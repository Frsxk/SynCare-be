import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Store, inspectApprovalDatabase, resolveDatabasePath } from '../src/storage/database.ts'
import { loadMigrations } from '../src/storage/migrations.ts'
import { loadConfig } from '../src/config.ts'

const NOW = '2026-10-24T00:00:00.000Z'
const directories: string[] = []
const stores: Store[] = []

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'syncare-storage-'))
  directories.push(directory)
  const path = join(directory, 'state.sqlite3')
  return { directory, path }
}

function open(path: string, create = true) {
  const store = Store.open({ path, create })
  stores.push(store)
  return store
}

async function enqueue(store: Store, id = 'work-a', source = id) {
  await store.transaction((tx) => tx.run(
    `INSERT INTO work_items (id, kind, source_key, payload_json, available_at, created_at, updated_at)
     VALUES (?, 'test', ?, '{}', ?, ?, ?)`, [id, source, NOW, NOW, NOW],
  ))
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('syncare-storage-')) {
      throw new Error('Refusing cleanup outside the owned temporary fixture')
    }
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
  }
})

describe('operational storage foundation', () => {
  test('default configured paths use filesystem paths rather than URL pathnames on Windows', () => {
    const previous = { key: process.env.LANGFLOW_API_KEY, state: process.env.SYNCARE_STATE_DB, review: process.env.SYNCARE_REVIEW_DB }
    try {
      process.env.LANGFLOW_API_KEY = 'synthetic-config-test-only'
      delete process.env.SYNCARE_STATE_DB
      delete process.env.SYNCARE_REVIEW_DB
      const config = loadConfig()
      expect(config.consoleStateDbPath).toBe(fileURLToPath(new URL('../data/console-state.sqlite3', import.meta.url)))
      expect(config.reviewDbPath).toBe(fileURLToPath(new URL('../data/langflow/langflow/syncare-review.sqlite3', import.meta.url)))
    } finally {
      for (const [name, value] of Object.entries({ LANGFLOW_API_KEY: previous.key, SYNCARE_STATE_DB: previous.state, SYNCARE_REVIEW_DB: previous.review })) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
  test('storage_restart_and_path: persists committed work and does not reseed on reopen', async () => {
    const { path } = fixture()
    const first = open(path)
    await first.migrate()
    await enqueue(first)
    first.close()
    const second = open(path, false)
    await second.migrate()
    expect(second.get<{ id: string }>('SELECT id FROM work_items')?.id).toBe('work-a')
    expect(second.all('SELECT * FROM schema_migrations')).toHaveLength(loadMigrations().length)
    expect(second.diagnostics().foreignKeys).toBe(true)
    expect(second.diagnostics().operationalPath).toBe(resolve(path))
  })

  test('missing/relative paths fail closed without creating a database', () => {
    const { path, directory } = fixture()
    expect(() => Store.open({ path })).toThrow('state_db_missing')
    expect(existsSync(path)).toBe(false)
    expect(() => Store.open({ path: 'relative.sqlite3', create: true })).toThrow('absolute_path_required')
    expect(() => Store.open({ path: ':memory:', create: true })).toThrow('absolute_path_required')
    expect(resolveDatabasePath(pathToFileURL(path))).toBe(resolve(path))
    const unavailableParent = join(directory, 'missing-parent')
    expect(() => Store.open({ path: join(unavailableParent, 'state.sqlite3'), create: true })).toThrow('state_db_unavailable')
    expect(existsSync(unavailableParent)).toBe(false)
  })

  test('a locked database rejects a write without partial success', async () => {
    const { path } = fixture()
    const store = Store.open({ path, create: true, busyTimeoutMs: 10 })
    stores.push(store)
    await store.migrate()
    const locker = new Database(path)
    locker.run('BEGIN IMMEDIATE')
    try { await expect(enqueue(store)).rejects.toThrow() }
    finally { locker.run('ROLLBACK'); locker.close() }
    expect(store.all('SELECT * FROM work_items')).toHaveLength(0)
    await enqueue(store)
    expect(store.all('SELECT * FROM work_items')).toHaveLength(1)
  })

  test('transaction rollback preserves data and foreign keys are enforced', async () => {
    const { path } = fixture()
    const store = open(path)
    await store.migrate()
    await expect(store.transaction((tx) => {
      tx.run('CREATE TABLE fixture_parent (id TEXT PRIMARY KEY)')
      tx.run('CREATE TABLE fixture_child (parent_id TEXT REFERENCES fixture_parent(id))')
      tx.run("INSERT INTO fixture_child VALUES ('missing-parent')")
    })).rejects.toThrow()
    expect(store.get("SELECT name FROM sqlite_master WHERE name = 'fixture_parent'")).toBeNull()
    await expect(store.transaction((tx) => {
      tx.run(`INSERT INTO work_items (id,kind,source_key,payload_json,available_at,created_at,updated_at)
              VALUES ('rolled-back','test','rolled-back','{}',?,?,?)`, [NOW, NOW, NOW])
      throw new Error('synthetic failure after write')
    })).rejects.toThrow('synthetic failure after write')
    expect(store.all('SELECT * FROM work_items')).toHaveLength(0)
  })

  test('failed migrations roll back their DDL and ledger entry', async () => {
    const { path } = fixture()
    const store = open(path)
    await store.migrate()
    await expect(store.migrate([...loadMigrations(), {
      version: loadMigrations().length + 1, name: 'broken_fixture', sql: 'CREATE TABLE partial_fixture(id TEXT); INVALID SQL;',
    }])).rejects.toThrow()
    expect(store.get("SELECT name FROM sqlite_master WHERE name = 'partial_fixture'")).toBeNull()
    expect(store.all('SELECT * FROM schema_migrations')).toHaveLength(loadMigrations().length)
  })

  test('checksum drift, missing installed versions and noncontiguous manifests are rejected', async () => {
    const { path } = fixture()
    const store = open(path)
    await store.migrate()
    const original = loadMigrations()[0]!
    await expect(store.migrate([{ ...original, sql: original.sql + '\n-- changed' }, ...loadMigrations().slice(1)])).rejects.toThrow('migration_drift')
    await expect(store.migrate([])).rejects.toThrow('schema_version_unsupported')
    await expect(store.migrate([original, { version: 3, name: 'gap', sql: 'SELECT 1' }])).rejects.toThrow('migration_sequence_invalid')
    expect(store.all('SELECT * FROM schema_migrations')).toHaveLength(loadMigrations().length)
  })

  test.each(['unrelated', 'schema_migrations'])('does not open an unknown database with a %s table for operational writes', (table) => {
    const { path } = fixture()
    const other = new Database(path)
    other.run(`CREATE TABLE ${table} (id TEXT)`)
    other.close()
    const before = createHash('sha256').update(readFileSync(path)).digest('hex')
    expect(() => Store.open({ path })).toThrow('unrecognized_database')
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(before)
  })

  test('refuses the approval database, including an explicitly supplied alias', async () => {
    const { directory, path } = fixture()
    const review = join(directory, 'review.sqlite3')
    const db = new Database(review)
    db.run('CREATE TABLE approved_plans(plan_json TEXT, approved_at TEXT, reviewer_note TEXT)')
    db.run('CREATE TABLE audit_log(action TEXT,actor TEXT,timestamp TEXT,payload TEXT)')
    db.close()
    const before = createHash('sha256').update(readFileSync(review)).digest('hex')
    expect(() => Store.open({ path: review })).toThrow('approval_db_not_operational')
    expect(() => Store.open({ path, create: true, reviewPath: path })).toThrow('database_paths_overlap')
    const readiness = inspectApprovalDatabase(review)
    expect(readiness.status).toBe('readable_live_unverified')
    expect(readiness.liveVerified).toBe(false)
    expect(createHash('sha256').update(readFileSync(review)).digest('hex')).toBe(before)
    expect(inspectApprovalDatabase(join(directory, 'absent.sqlite3')).status).toBe('missing')
    expect(existsSync(join(directory, 'absent.sqlite3'))).toBe(false)
  })

  test('two processes can claim one pending item only once', async () => {
    const { path } = fixture()
    const store = open(path)
    await store.migrate()
    await enqueue(store)
    const moduleUrl = new URL('../src/storage/database.ts', import.meta.url).href
    const script = `import {Store} from ${JSON.stringify(moduleUrl)};
      const store = Store.open({path:${JSON.stringify(path)}});
      const work = await store.claimWork('test', ${JSON.stringify(NOW)});
      console.log(work === null ? 'empty' : 'claimed'); store.close();`
    const workers = [1, 2].map(() => Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' }))
    const results = await Promise.all(workers.map(async (worker) => {
      const [code, out, error] = await Promise.all([worker.exited, new Response(worker.stdout).text(), new Response(worker.stderr).text()])
      expect(error).toBe('')
      expect(code).toBe(0)
      return out.trim()
    }))
    expect(results.sort()).toEqual(['claimed', 'empty'])
    expect(store.get<{ attempt_count: number }>('SELECT attempt_count FROM work_items')?.attempt_count).toBe(1)
  })

  test('expired running work is never automatically replayed', async () => {
    const { path } = fixture()
    const store = open(path)
    await store.migrate()
    await enqueue(store)
    const claimed = await store.claimWork('test', NOW, 1000)
    expect(claimed?.state).toBe('RUNNING')
    expect(await store.claimWork('test', '2026-10-24T00:10:00.000Z')).toBeNull()
    expect(await store.finishWork('work-a', 'wrong-claim', 'SUCCEEDED')).toBe(false)
    expect(await store.finishWork('work-a', claimed!.claimToken, 'UNKNOWN')).toBe(true)
    expect(await store.claimWork('test', '2026-10-24T00:11:00.000Z')).toBeNull()
  })

  test('invalid work JSON/status and duplicate source are rejected atomically', async () => {
    const { path } = fixture()
    const store = open(path)
    await store.migrate()
    await enqueue(store)
    await expect(enqueue(store, 'different-id', 'work-a')).rejects.toThrow()
    await expect(store.transaction((tx) => tx.run("UPDATE work_items SET state='invented'"))).rejects.toThrow()
    await expect(store.transaction((tx) => tx.run("UPDATE work_items SET payload_json='invalid json'"))).rejects.toThrow()
    expect(store.all('SELECT * FROM work_items')).toHaveLength(1)
  })

  test('async transaction callbacks cannot commit writes outside the transaction', async () => {
    const { path } = fixture()
    const store = open(path)
    await store.migrate()
    await expect(store.transaction(async () => 'unsafe')).rejects.toThrow('async_transaction_not_supported')
    expect(store.all('SELECT * FROM work_items')).toHaveLength(0)
  })
})
