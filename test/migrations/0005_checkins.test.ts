import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { database, account, NOW } from './fixture.ts'

test('0005_checkins_constraints: upgrade/reopen preserves immutable report and attempt; foreign and duplicate sources rejected', async () => {
  const { store, reopen } = await database(4)
  await account(store, 'patient')
  await store.transaction(tx => tx.run('INSERT INTO patients(id,profile_json,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    ['p', '{"displayName":"Sintetis"}', 'patient', 'patient', NOW, NOW]))
  await store.migrate()
  await store.transaction(tx => {
    tx.run('INSERT INTO checkins VALUES (?,?,?,?,?,?,?,?,?)', ['c', 'p', 'patient', '  exact message\n', NOW, null, null, null, 1])
    tx.run('INSERT INTO processing_attempts(id,checkin_id,session_id,state,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      ['a', 'c', randomUUID(), 'BLOCKED_BASELINE', 1, NOW, NOW])
  })
  await expect(store.transaction(tx => tx.run("UPDATE checkins SET message='changed' WHERE id='c'"))).rejects.toThrow()
  await expect(store.transaction(tx => tx.run("DELETE FROM checkins WHERE id='c'"))).rejects.toThrow()
  await expect(store.transaction(tx => tx.run('INSERT INTO checkins VALUES (?,?,?,?,?,?,?,?,?)', ['bad', 'foreign', 'patient', 'x', NOW, null, null, null, 1]))).rejects.toThrow()
  await expect(store.transaction(tx => tx.run('INSERT INTO processing_attempts(id,checkin_id,session_id,state,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    ['duplicate', 'c', randomUUID(), 'PENDING', 1, NOW, NOW]))).rejects.toThrow()
  await store.migrate()
  store.close()
  const restored = reopen()
  await restored.migrate()
  expect(restored.get<{ message: string }>("SELECT message FROM checkins WHERE id='c'")?.message).toBe('  exact message\n')
  expect(restored.get<{ state: string }>("SELECT state FROM processing_attempts WHERE checkin_id='c'")?.state).toBe('BLOCKED_BASELINE')
})
