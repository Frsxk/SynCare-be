import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const OPERATIONAL_APPLICATION_ID = 0x53594341

export interface Migration {
  version: number
  name: string
  sql: string
}

export function loadMigrations(directory: string | URL = new URL('./migrations/', import.meta.url)): Migration[] {
  const path = directory instanceof URL ? fileURLToPath(directory) : directory
  return readdirSync(path).filter((name) => name.endsWith('.sql')).sort().map((name) => {
    const match = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(name)
    if (!match) throw new Error('migration_filename_invalid')
    return { version: Number(match[1]), name: match[2]!, sql: readFileSync(join(path, name), 'utf8') }
  })
}

export function applyMigrations(db: Database, migrations: readonly Migration[]): void {
  if (migrations.some((migration, index) => migration.version !== index + 1 || !migration.name || !migration.sql.trim())) {
    throw new Error('migration_sequence_invalid')
  }
  const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex')
  db.transaction(() => {
    db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL, applied_at TEXT NOT NULL
    ) STRICT`)
    const applied = db.query<{ version: number; name: string; checksum: string }, []>(
      'SELECT version,name,checksum FROM schema_migrations ORDER BY version',
    ).all()
    for (const entry of applied) {
      const source = migrations[entry.version - 1]
      if (!source || entry.version > migrations.length) throw new Error('schema_version_unsupported')
      if (source.name !== entry.name || checksum(source.sql) !== entry.checksum) throw new Error('migration_drift')
    }
    if (applied.some((entry, index) => entry.version !== index + 1)) throw new Error('migration_ledger_invalid')
    for (const migration of migrations.slice(applied.length)) {
      db.exec(migration.sql)
      db.query('INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (?,?,?,?)')
        .run(migration.version, migration.name, checksum(migration.sql), new Date().toISOString())
    }
    db.run(`PRAGMA application_id = ${OPERATIONAL_APPLICATION_ID}`)
  }).immediate()
}

