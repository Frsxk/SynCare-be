import { expect,test } from 'bun:test'
import { database } from './fixture.ts'
import { alertFixture } from '../alert-fixture.ts'
import { AlertService } from '../../src/modules/alerts/actions.ts'

test('0007_alerts_constraints: upgrade/repeat preserves ledger and creates alerts/actions',async()=>{
  const {store,reopen}=await database(6)
  expect(store.diagnostics().schemaVersion).toBe(6)
  await store.migrate((await import('../../src/storage/migrations.ts')).loadMigrations().slice(0,7))
  expect(store.diagnostics().schemaVersion).toBe(7)
  expect(store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='alerts'")).not.toBeNull()
  expect(store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='alert_actions'")).not.toBeNull()
  await store.migrate((await import('../../src/storage/migrations.ts')).loadMigrations().slice(0,7));store.close()
  expect(reopen().diagnostics().schemaVersion).toBe(7)
})

test('0007 source/FK/history constraints and stored rows survive repeat migration and normal reopen',async()=>{
  const f=await alertFixture(),{alert}=await f.create(),before=f.alerts.read(f.ctx('patient-a'),alert.id)
  await expect(f.store.transaction(tx=>tx.run('INSERT INTO alerts(id,patient_id,checkin_id,attempt_id,source_type,source_action,reason,reported_at,source_at,status,version,acknowledged_at,resolved_at,created_at,updated_at) SELECT ?,?,checkin_id,attempt_id,source_type,source_action,reason,reported_at,source_at,status,version,acknowledged_at,resolved_at,created_at,updated_at FROM alerts WHERE id=?',['invalid-source','missing-patient',alert.id]))).rejects.toThrow()
  await expect(f.store.transaction(tx=>tx.run("UPDATE alerts SET status='RESOLVED',version=2,resolved_at=?,updated_at=? WHERE id=?",[f.clock().toISOString(),f.clock().toISOString(),alert.id]))).rejects.toThrow()
  await expect(f.store.transaction(tx=>tx.run("UPDATE alert_actions SET patient_summary='leaked' WHERE alert_id=?",[alert.id]))).rejects.toThrow()
  expect(f.store.all('SELECT * FROM alerts')).toHaveLength(1)
  await f.store.migrate();await f.store.migrate();f.store.close()
  const restored=f.reopen();expect(restored.diagnostics().schemaVersion).toBe((await import('../../src/storage/migrations.ts')).loadMigrations().length)
  expect(new AlertService(restored,{codec:f.codec,clock:f.clock}).read(f.ctx('patient-a'),alert.id)).toEqual(before)
})
