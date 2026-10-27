import { expect, test } from 'bun:test'
import { account, database, NOW } from './fixture.ts'
import { loadMigrations } from '../../src/storage/migrations.ts'

test('0004_assessments_constraints: upgrade preserves sources; exact source identity and immutable confirmation survive reopen', async () => {
  const { store, reopen } = await database(3)
  await account(store, 'nurse', 'nurse')
  await store.transaction(tx => tx.run("UPDATE accounts SET active=1 WHERE id='nurse'"))
  await store.transaction(tx => {
    tx.run('INSERT INTO patients(id,profile_json,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?)', ['p', '{"displayName":"Sintetis"}', 'nurse', 'nurse', NOW, NOW])
    tx.run('INSERT INTO discharge_versions VALUES (?,?,?,?,?,?,?)', ['d1', 'p', 'e', 1, 'Exact original source', 'nurse', NOW])
  })
  await store.migrate()
  await store.transaction(tx => {
    tx.run('INSERT INTO patient_episode_heads VALUES (?,?,?,?,?,?,?)', ['p', 'e', 'd1', 1, 'nurse', NOW, 1])
    tx.run(`INSERT INTO assessments(id,patient_id,discharge_id,source_version,requested_by,idempotency_key,session_id,state,version,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, ['a1', 'p', 'd1', 1, 'nurse', 'request-1', 'server-session-1', 'RUNNING', 1, NOW])
    tx.run(`UPDATE assessments SET state='SUCCEEDED',version=2,output_json=?,raw_json=?,completed_at=? WHERE id='a1'`,
      ['{"tier":"LOW","score":1}', '{"synthetic":"exact upstream"}', NOW])
    tx.run('INSERT INTO risk_confirmations VALUES (?,?,?,?,?,?,?)', ['c1', 'a1', 'p', 'LOW', 'nurse', NOW, 1])
  })
  await expect(store.transaction(tx => tx.run('INSERT INTO risk_confirmations VALUES (?,?,?,?,?,?,?)', ['c2', 'a1', 'p', 'HIGH', 'nurse', NOW, 1]))).rejects.toThrow()
  await expect(store.transaction(tx => tx.run("UPDATE assessments SET output_json='{}' WHERE id='a1'"))).rejects.toThrow()
  await expect(store.transaction(tx => tx.run("UPDATE risk_confirmations SET category='HIGH'"))).rejects.toThrow()
  await expect(store.transaction(tx => tx.run("UPDATE discharge_versions SET source_text='replacement'"))).rejects.toThrow()
  await expect(store.transaction(tx => tx.run("UPDATE patient_episode_heads SET current_discharge_id='missing'"))).rejects.toThrow()
  await expect(store.transaction(tx => tx.run(`INSERT INTO assessments(id,patient_id,discharge_id,source_version,requested_by,idempotency_key,session_id,state,version,created_at)
    VALUES ('bad','p','d1',2,'nurse','request-2','server-session-2','RUNNING',1,?)`, [NOW]))).rejects.toThrow()
  await store.migrate()
  store.close()
  const restored = reopen()
  await restored.migrate()
  expect(restored.get<{ raw_json: string }>("SELECT raw_json FROM assessments WHERE id='a1'")?.raw_json).toBe('{"synthetic":"exact upstream"}')
  expect(restored.get<{ category: string }>("SELECT category FROM risk_confirmations WHERE id='c1'")?.category).toBe('LOW')
  expect(restored.get<{ source_text: string }>("SELECT source_text FROM discharge_versions WHERE id='d1'")?.source_text).toBe('Exact original source')
  expect(restored.all('SELECT * FROM schema_migrations')).toHaveLength(loadMigrations().length)
})
