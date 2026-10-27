import { expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { AuthService, hashPassword, SESSION_LIFETIME_MS } from '../src/modules/auth/service.ts'
import { createAuthRoutes } from '../src/modules/auth/routes.ts'
import { database, NOW } from './migrations/fixture.ts'

async function fixture() {
  const { store, reopen } = await database()
  const password = randomBytes(18).toString('base64url')
  const verifier = await hashPassword(password)
  await store.transaction(tx => {
    for (const [id, role] of [['nurse-a', 'nurse'], ['patient-a', 'patient'], ['inactive', 'nurse'], ['unlinked', 'patient']]) {
      tx.run('INSERT INTO accounts(id,identifier,password_hash,role,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        [id!, `${id}@synthetic.invalid`, verifier, role!, id === 'inactive' ? 0 : 1, NOW, NOW])
    }
    tx.run('INSERT INTO patients(id,profile_json,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      ['record-a', '{"displayName":"Pasien uji A"}', 'nurse-a', 'nurse-a', NOW, NOW])
    tx.run('INSERT INTO patient_account_links VALUES (?,?,?,?)', ['record-a', 'patient-a', 'nurse-a', NOW])
    tx.run('INSERT INTO capability_grants(id,account_id,capability,granted_by,granted_at) VALUES (?,?,?,?,?)',
      ['g1', 'nurse-a', 'patient.manage', 'nurse-a', NOW])
  })
  let time = new Date(NOW).getTime()
  const clock = () => new Date(time)
  const auth = new AuthService(store, { clock })
  return { store, reopen, password, verifier, auth, clock, advance: (ms: number) => { time += ms } }
}

test('login issues an opaque account-bound session; only hashes and sanitized audit reach storage', async () => {
  const { auth, store, password, verifier } = await fixture()
  const grant = await auth.login(' PATIENT-A@SYNTHETIC.INVALID ', password)
  expect(grant.principal).toEqual({ id: 'patient-a', role: 'patient', patientId: 'record-a', capabilities: [] })
  expect(grant.sessionToken).toMatch(/^sc_[A-Za-z0-9_-]{43}$/)
  expect(SESSION_LIFETIME_MS).toBe(24 * 60 * 60 * 1000)
  expect(Date.parse(grant.expiresAt) - Date.parse(NOW)).toBe(SESSION_LIFETIME_MS)
  expect(verifier).toMatch(/^\$argon2id\$/)
  expect(await Bun.password.verify(password, verifier)).toBe(true)
  const persisted = JSON.stringify(store.all('SELECT * FROM sessions'))
  expect(persisted).not.toContain(grant.sessionToken)
  expect(persisted).not.toContain(password)
  expect(store.get<{ token_hash: string }>('SELECT token_hash FROM sessions')?.token_hash).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(grant)).not.toContain(verifier)
  const audit = JSON.stringify(store.all('SELECT * FROM operational_audit'))
  expect(audit).toContain('auth.login')
  expect(audit).not.toContain(password)
  expect(audit).not.toContain(grant.sessionToken)
})

test('invalid, inactive, corrupt-verifier and unlinked patient logins all fail without a session', async () => {
  const { auth, store, password } = await fixture()
  await store.transaction(tx => tx.run('UPDATE accounts SET password_hash=? WHERE id=?', ['x'.repeat(40), 'nurse-a']))
  for (const [identifier, supplied] of [['missing', password], ['inactive@synthetic.invalid', password],
    ['patient-a@synthetic.invalid', 'incorrect'], ['nurse-a@synthetic.invalid', password], ['unlinked@synthetic.invalid', password]]) {
    await expect(auth.login(identifier!, supplied!)).rejects.toMatchObject({ code: 'unauthenticated', status: 401 })
  }
  expect(store.all('SELECT * FROM sessions')).toHaveLength(0)
  expect(store.all('SELECT * FROM operational_audit')).toHaveLength(0)
})

test('auth_session_rejects_expired: restore verifies revocation, account state and absolute expiry', async () => {
  const { auth, store, password, advance } = await fixture()
  const grant = await auth.login('nurse-a@synthetic.invalid', password)
  expect((await auth.getSession(grant.sessionToken)).capabilities).toEqual(['patient.manage'])
  const before = store.get<{ expires_at: string }>('SELECT expires_at FROM sessions')
  advance(SESSION_LIFETIME_MS - 1)
  expect((await auth.getSession(grant.sessionToken)).id).toBe('nurse-a')
  expect(store.get<{ expires_at: string }>('SELECT expires_at FROM sessions')).toEqual(before)
  advance(1)
  await expect(auth.getSession(grant.sessionToken)).rejects.toMatchObject({ status: 401 })
  await expect(auth.getSession('shared-infrastructure-key')).rejects.toMatchObject({ status: 401 })
  await expect(auth.getSession(grant.sessionToken + 'x')).rejects.toMatchObject({ status: 401 })
})

test('revocation and changed account/capability state are effective on the next restore', async () => {
  const { auth, store, password } = await fixture()
  const grant = await auth.login('nurse-a@synthetic.invalid', password)
  await store.transaction(tx => tx.run('UPDATE capability_grants SET revoked_at=?,revoked_by=? WHERE id=?', [NOW, 'nurse-a', 'g1']))
  expect((await auth.getSession(grant.sessionToken)).capabilities).toEqual([])
  await store.transaction(tx => tx.run("UPDATE accounts SET active=0 WHERE id='nurse-a'"))
  await expect(auth.getSession(grant.sessionToken)).rejects.toMatchObject({ status: 401 })
  await store.transaction(tx => tx.run("UPDATE accounts SET active=1 WHERE id='nurse-a'"))
  const session = await auth.inspect(grant.sessionToken)
  await auth.revoke(session.sessionId)
  await auth.revoke(session.sessionId)
  await expect(auth.getSession(grant.sessionToken)).rejects.toMatchObject({ status: 401 })
  expect(store.all("SELECT * FROM operational_audit WHERE action='auth.logout'")).toHaveLength(1)
})

test('sessions survive service restart and multiple independent sessions revoke separately', async () => {
  const { auth, store, reopen, password, clock } = await fixture()
  const first = await auth.login('patient-a@synthetic.invalid', password)
  const second = await auth.login('patient-a@synthetic.invalid', password)
  expect(first.sessionToken).not.toBe(second.sessionToken)
  store.close()
  const restored = new AuthService(reopen(), { clock })
  await restored.revoke((await restored.inspect(first.sessionToken)).sessionId)
  await expect(restored.getSession(first.sessionToken)).rejects.toMatchObject({ status: 401 })
  expect((await restored.getSession(second.sessionToken)).patientId).toBe('record-a')
})

test('failed attempts and concurrent password checks are bounded; expiry permits retry', async () => {
  const { auth, store, password, advance } = await fixture()
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => auth.login('patient-a@synthetic.invalid', 'wrong')))
  expect(results.every(result => result.status === 'rejected')).toBe(true)
  expect(results.some(result => result.status === 'rejected' && result.reason.code === 'rate_limited')).toBe(true)
  await expect(auth.login('patient-a@synthetic.invalid', password)).rejects.toMatchObject({ code: 'rate_limited', status: 429 })
  expect(store.all('SELECT * FROM sessions')).toHaveLength(0)
  advance(15 * 60 * 1000)
  expect((await auth.login('patient-a@synthetic.invalid', password)).principal.id).toBe('patient-a')
})

test('login rechecks account activation after asynchronous password verification', async () => {
  const { store, password, clock } = await fixture()
  const auth = new AuthService(store, { clock, verifyPassword: async () => {
    await store.transaction(tx => tx.run("UPDATE accounts SET active=0 WHERE id='patient-a'"))
    return true
  } })
  await expect(auth.login('patient-a@synthetic.invalid', password)).rejects.toMatchObject({ status: 401 })
  expect(store.all('SELECT * FROM sessions')).toHaveLength(0)
  store.close()
  await expect(auth.login('patient-a@synthetic.invalid', password)).rejects.toThrow()
})

test('API-A1/A2 validate bodies, keep sessions private and reject expired/revoked credentials', async () => {
  const { auth, password, advance } = await fixture()
  const app = createAuthRoutes(auth)
  const login = (body: unknown) => app.handle(new Request('http://localhost/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }))
  for (const body of [{ identifier: 'patient-a@synthetic.invalid', password, role: 'nurse' }, null, { identifier: 'x', password: '' }]) {
    expect((await login(body)).status).toBe(422)
  }
  const response = await login({ identifier: 'patient-a@synthetic.invalid', password })
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toContain('no-store')
  const grant = (await response.json() as { data: { sessionToken: string } }).data
  const request = (method = 'GET', token = grant.sessionToken) => new Request('http://localhost/api/v1/auth/session', {
    method, headers: { Authorization: `Bearer ${token}` },
  })
  const restored = await app.handle(request())
  expect(restored.status).toBe(200)
  expect(await restored.text()).not.toContain(grant.sessionToken)
  expect((await app.handle(request('DELETE'))).status).toBe(204)
  expect((await app.handle(request())).status).toBe(401)
  advance(SESSION_LIFETIME_MS)
  expect((await app.handle(request('GET', 'shared-key'))).status).toBe(401)
})
