import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMigrations, loadMigrations, OPERATIONAL_APPLICATION_ID, type Migration } from './migrations.ts'

type Bindings = SQLQueryBindings[]
type WorkState = 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'

export interface Transaction {
  run(sql: string, bindings?: Bindings): void
  get<T>(sql: string, bindings?: Bindings): T | null
  all<T>(sql: string, bindings?: Bindings): T[]
}

export interface WorkItem {
  id: string
  kind: string
  sourceKey: string
  payload: unknown
  state: 'RUNNING'
  claimToken: string
  leaseExpiresAt: string
  attemptCount: number
}

export class StorageError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'StorageError' }
}

export function resolveDatabasePath(input: string | URL): string {
  let path: string
  try { path = input instanceof URL ? fileURLToPath(input) : input } catch { throw new StorageError('invalid_database_path') }
  if (!path.trim() || !isAbsolute(path)) throw new StorageError('absolute_path_required')
  const absolute = resolve(path)
  if (existsSync(absolute)) {
    if (!statSync(absolute).isFile()) throw new StorageError('database_path_not_file')
    return realpathSync.native(absolute)
  }
  return absolute
}

function samePath(first: string, second: string): boolean {
  if ((process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second)) return true
  if (!existsSync(first) || !existsSync(second)) return false
  const a = statSync(first), b = statSync(second)
  return a.dev === b.dev && a.ino === b.ino
}

function tables(db: Database): string[] {
  return db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all().map((row) => row.name)
}

export function inspectApprovalDatabase(input: string | URL): {
  path: string; status: 'missing' | 'unreadable' | 'schema_mismatch' | 'readable_live_unverified'; liveVerified: false
} {
  const path = resolveDatabasePath(input)
  if (!existsSync(path)) return { path, status: 'missing', liveVerified: false }
  let db: Database | undefined
  try {
    db = new Database(path, { readonly: true, strict: true })
    const names = tables(db)
    const valid = names.includes('approved_plans') && names.includes('audit_log')
    return { path, status: valid ? 'readable_live_unverified' : 'schema_mismatch', liveVerified: false }
  } catch {
    return { path, status: 'unreadable', liveVerified: false }
  } finally { db?.close() }
}

export class Store {
  private closed = false
  private constructor(private readonly db: Database, readonly path: string) {}

  static open(options: { path: string | URL; create?: boolean; reviewPath?: string | URL; busyTimeoutMs?: number }): Store {
    const path = resolveDatabasePath(options.path)
    if (options.reviewPath && samePath(path, resolveDatabasePath(options.reviewPath))) {
      throw new StorageError('database_paths_overlap')
    }
    if (!existsSync(path) && !options.create) throw new StorageError('state_db_missing')
    const busyTimeout = options.busyTimeoutMs ?? 5000
    if (!Number.isInteger(busyTimeout) || busyTimeout < 0 || busyTimeout > 60000) throw new StorageError('invalid_busy_timeout')
    let db: Database
    try { db = new Database(path, { create: options.create ?? false, readwrite: true, strict: true }) }
    catch { throw new StorageError('state_db_unavailable') }
    try {
      const names = tables(db)
      if (names.includes('approved_plans') || names.includes('audit_log')) throw new StorageError('approval_db_not_operational')
      const applicationId = db.query<{ application_id: number }, []>('PRAGMA application_id').get()!.application_id
      if ((applicationId !== 0 && applicationId !== OPERATIONAL_APPLICATION_ID) ||
          (names.length > 0 && (applicationId !== OPERATIONAL_APPLICATION_ID || !names.includes('schema_migrations')))) {
        throw new StorageError('unrecognized_database')
      }
      db.run(`PRAGMA busy_timeout = ${busyTimeout}`)
      db.run('PRAGMA foreign_keys = ON')
      db.run('PRAGMA journal_mode = WAL')
      db.run('PRAGMA synchronous = FULL')
      return new Store(db, path)
    } catch (error) { db.close(); throw error }
  }

  private assertOpen(): void {
    if (this.closed) throw new StorageError('store_closed')
  }

  async migrate(migrations: readonly Migration[] = loadMigrations()): Promise<void> {
    this.assertOpen()
    applyMigrations(this.db, migrations)
  }

  get<T>(sql: string, bindings: Bindings = []): T | null {
    this.assertOpen()
    return this.db.query<T, Bindings>(sql).get(...bindings)
  }

  all<T>(sql: string, bindings: Bindings = []): T[] {
    this.assertOpen()
    return this.db.query<T, Bindings>(sql).all(...bindings)
  }

  async transaction<T>(work: (tx: Transaction) => T): Promise<T> {
    this.assertOpen()
    if (work.constructor.name === 'AsyncFunction') throw new StorageError('async_transaction_not_supported')
    return this.db.transaction(() => {
      let active = true
      const assertActive = () => { if (!active) throw new StorageError('transaction_closed') }
      const tx: Transaction = {
        run: (sql, bindings = []) => { assertActive(); this.db.query(sql).run(...bindings) },
        get: <R>(sql: string, bindings: Bindings = []) => { assertActive(); return this.get<R>(sql, bindings) },
        all: <R>(sql: string, bindings: Bindings = []) => { assertActive(); return this.all<R>(sql, bindings) },
      }
      try {
        const result = work(tx)
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          void Promise.resolve(result).catch(() => {})
          throw new StorageError('async_transaction_not_supported')
        }
        return result
      } finally { active = false }
    }).immediate()
  }

  async claimWork(kind: string, now: string, leaseMs = 60000): Promise<WorkItem | null> {
    const at = new Date(now)
    if (!kind.trim() || !Number.isFinite(at.getTime()) || !Number.isInteger(leaseMs) || leaseMs <= 0 || leaseMs > 3600000) {
      throw new StorageError('invalid_work_claim')
    }
    return this.transaction((tx) => {
      // Expired RUNNING work needs reconciliation; it is never reset to PENDING here.
      const row = tx.get<{ id: string; kind: string; source_key: string; payload_json: string; attempt_count: number }>(
        "SELECT id,kind,source_key,payload_json,attempt_count FROM work_items WHERE kind=? AND state='PENDING' AND julianday(available_at)<=julianday(?) ORDER BY julianday(available_at),id LIMIT 1",
        [kind, at.toISOString()],
      )
      if (!row) return null
      const claimToken = randomUUID(), leaseExpiresAt = new Date(at.getTime() + leaseMs).toISOString()
      tx.run("UPDATE work_items SET state='RUNNING',claim_token=?,claimed_at=?,lease_expires_at=?,attempt_count=attempt_count+1,updated_at=? WHERE id=? AND state='PENDING'",
        [claimToken, at.toISOString(), leaseExpiresAt, at.toISOString(), row.id])
      return { id: row.id, kind: row.kind, sourceKey: row.source_key, payload: JSON.parse(row.payload_json) as unknown,
        state: 'RUNNING', claimToken, leaseExpiresAt, attemptCount: row.attempt_count + 1 }
    })
  }

  async finishWork(id: string, claimToken: string, state: WorkState): Promise<boolean> {
    if (!['SUCCEEDED', 'FAILED', 'UNKNOWN'].includes(state)) throw new StorageError('invalid_work_state')
    return this.transaction((tx) => {
      tx.run("UPDATE work_items SET state=?,claim_token=NULL,updated_at=? WHERE id=? AND state='RUNNING' AND claim_token=?",
        [state, new Date().toISOString(), id, claimToken])
      return tx.get<{ changed: number }>('SELECT changes() AS changed')!.changed === 1
    })
  }

  diagnostics(): { operationalPath: string; schemaVersion: number; foreignKeys: boolean; liveApprovalVerified: false } {
    this.assertOpen()
    const hasLedger = tables(this.db).includes('schema_migrations')
    return { operationalPath: this.path,
      schemaVersion: hasLedger ? this.get<{ version: number }>('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations')!.version : 0,
      foreignKeys: this.get<{ foreign_keys: number }>('PRAGMA foreign_keys')!.foreign_keys === 1,
      liveApprovalVerified: false }
  }

  close(): void { if (!this.closed) { this.db.close(); this.closed = true } }
}

