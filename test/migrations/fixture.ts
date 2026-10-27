import { afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Store } from '../../src/storage/database.ts'
import { loadMigrations } from '../../src/storage/migrations.ts'

export const NOW = '2026-10-24T00:00:00.000Z'
const fixtures: { directory: string; stores: Store[] }[] = []
export async function database(initialVersions?: number) {
  const directory = mkdtempSync(join(tmpdir(), 'syncare-schema-'))
  const path = join(directory, 'state.sqlite3')
  const owned = { directory, stores: [] as Store[] }
  fixtures.push(owned)
  const open = () => {
    const store = Store.open({ path, create: true })
    owned.stores.push(store)
    return store
  }
  const store = open()
  await store.migrate(initialVersions === undefined ? undefined : loadMigrations().slice(0, initialVersions))
  return { store, reopen: open }
}
export async function account(store: Store, id: string, role = 'patient') {
  await store.transaction(tx => tx.run(
    'INSERT INTO accounts(id,identifier,password_hash,role,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    [id, `${id}@synthetic.invalid`, '$argon2id$synthetic-fixture-not-a-real-verifier', role, NOW, NOW],
  ))
}
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.stores.forEach(store => store.close())
    if (dirname(resolve(fixture.directory)) !== resolve(tmpdir()) || !fixture.directory.includes('syncare-schema-')) {
      throw new Error('Refusing cleanup outside owned fixture')
    }
    rmSync(fixture.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
  }
})
