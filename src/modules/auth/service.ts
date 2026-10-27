import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Store, Transaction } from '../../storage/database.ts'
import { DomainError, type Principal } from '../contracts/errors.ts'
import { strictTextObject } from '../contracts/validation.ts'

export const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000
const tokenPattern = /^sc_[A-Za-z0-9_-]{43}$/
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export interface SessionGrant { sessionToken: string; expiresAt: string; principal: Principal }
export interface SessionSnapshot { sessionId: string; expiresAt: string; principal: Principal }
interface Account { id: string; role: 'patient' | 'nurse'; active: number; password_hash: string }

export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || [...password].length < 12 || [...password].length > 128) {
    throw new DomainError('validation_failed')
  }
  return Bun.password.hash(password, { algorithm: 'argon2id', memoryCost: 65536, timeCost: 2 })
}

export class AuthService {
  private readonly attempts = new Map<string, { until: number; count: number }>()
  private readonly clock: () => Date
  private readonly verify: (password: string, hash: string) => Promise<boolean>
  private dummyHash?: Promise<string>
  private verifying = 0
  private globalWindow = { until: 0, count: 0 }

  constructor(private readonly store: Store, options: {
    clock?: () => Date
    verifyPassword?: (password: string, hash: string) => Promise<boolean>
  } = {}) {
    this.clock = options.clock ?? (() => new Date())
    this.verify = options.verifyPassword ?? ((password, hash) => Bun.password.verify(password, hash))
  }

  private limit(identifier: string): void {
    const now = this.clock().getTime()
    for (const [key, attempt] of this.attempts) if (attempt.until <= now) this.attempts.delete(key)
    if (this.globalWindow.until <= now) this.globalWindow = { until: now + 60000, count: 0 }
    const key = digest(identifier)
    const attempt = this.attempts.get(key) ?? { until: now + ATTEMPT_WINDOW_MS, count: 0 }
    if (!this.attempts.has(key) && this.attempts.size >= 1024) throw new DomainError('rate_limited')
    attempt.count = Math.min(attempt.count + 1, 6)
    this.globalWindow.count = Math.min(this.globalWindow.count + 1, 61)
    this.attempts.set(key, attempt)
    if (attempt.count > 5 || this.globalWindow.count > 60 || this.verifying >= 4) throw new DomainError('rate_limited')
  }

  private principal(account: Account, reader: Pick<Store, 'get' | 'all'> | Transaction = this.store): Principal {
    if (!account.active) throw new DomainError('unauthenticated')
    if (account.role === 'patient') {
      const link = reader.get<{ patient_id: string }>('SELECT patient_id FROM patient_account_links WHERE account_id=?', [account.id])
      if (!link) throw new DomainError('unauthenticated')
      return { id: account.id, role: 'patient', patientId: link.patient_id, capabilities: [] }
    }
    const capabilities = reader.all<{ capability: string }>(
      'SELECT capability FROM capability_grants WHERE account_id=? AND revoked_at IS NULL ORDER BY capability', [account.id],
    ).map(row => row.capability)
    return { id: account.id, role: 'nurse', capabilities }
  }

  async login(identifier: string, password: string): Promise<SessionGrant> {
    strictTextObject({ identifier, password }, { identifier: 320, password: 128 })
    const normalized = identifier.trim().toLowerCase()
    this.limit(normalized)
    this.verifying++
    try {
      const account = this.store.get<Account>('SELECT id,role,active,password_hash FROM accounts WHERE identifier=?', [normalized])
      const hash = account?.password_hash ?? await (this.dummyHash ??= hashPassword(randomBytes(32).toString('base64url')))
      let verified = false
      try { verified = await this.verify(password, hash) } catch { /* Invalid verifiers deny access without exposing storage details. */ }
      if (!verified || !account) throw new DomainError('unauthenticated')
      const now = this.clock()
      const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString()
      const sessionId = randomUUID()
      const sessionToken = `sc_${randomBytes(32).toString('base64url')}`
      const grant = await this.store.transaction(tx => {
        const current = tx.get<Account>('SELECT id,role,active,password_hash FROM accounts WHERE id=?', [account.id])
        if (!current || current.password_hash !== hash) throw new DomainError('unauthenticated')
        const principal = this.principal(current, tx)
        tx.run('INSERT INTO sessions(id,account_id,token_hash,issued_at,expires_at) VALUES (?,?,?,?,?)',
          [sessionId, principal.id, digest(sessionToken), now.toISOString(), expiresAt])
        tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)',
          [randomUUID(), principal.id, 'auth.login', 'session', sessionId, now.toISOString(), '{}'])
        return { sessionToken, expiresAt, principal }
      })
      this.attempts.delete(digest(normalized))
      return grant
    } finally { this.verifying-- }
  }

  async inspect(token: string): Promise<SessionSnapshot> {
    if (!tokenPattern.test(token)) throw new DomainError('unauthenticated')
    const row = this.store.get<Account & { session_id: string; expires_at: string }>(
      `SELECT a.id,a.role,a.active,a.password_hash,s.id AS session_id,s.expires_at FROM sessions s
       JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.revoked_at IS NULL
       AND julianday(s.expires_at)>julianday(?)`, [digest(token), this.clock().toISOString()],
    )
    if (!row) throw new DomainError('unauthenticated')
    return { sessionId: row.session_id, expiresAt: row.expires_at, principal: this.principal(row) }
  }

  async getSession(token: string): Promise<Principal> { return (await this.inspect(token)).principal }

  async revoke(sessionId: string): Promise<void> {
    const now = this.clock().toISOString()
    await this.store.transaction(tx => {
      const session = tx.get<{ account_id: string }>('SELECT account_id FROM sessions WHERE id=? AND revoked_at IS NULL', [sessionId])
      if (!session) return
      tx.run('UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL', [now, sessionId])
      tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)',
        [randomUUID(), session.account_id, 'auth.logout', 'session', sessionId, now, '{}'])
    })
  }
}
