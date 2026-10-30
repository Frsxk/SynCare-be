import { expect,test } from 'bun:test'
import { database } from './fixture.ts'
import { loadMigrations } from '../../src/storage/migrations.ts'
test('0008_reviews_constraints: upgrade repeat reopen preserve existing schema and review ledger',async()=>{
  const {store,reopen}=await database(7)
  expect(store.diagnostics().schemaVersion).toBe(7)
  await store.migrate(loadMigrations().slice(0,8))
  expect(store.diagnostics().schemaVersion).toBe(8)
  for(const name of ['care_plan_drafts','review_jobs','review_events','review_decisions','approval_links'])expect(store.get('SELECT name FROM sqlite_master WHERE type=? AND name=?',['table',name])).not.toBeNull()
  await store.migrate(loadMigrations().slice(0,8));store.close()
  expect(reopen().diagnostics().schemaVersion).toBe(8)
})
