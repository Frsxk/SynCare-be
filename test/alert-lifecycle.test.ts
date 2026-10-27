import { expect,test } from 'bun:test'
import { AlertService } from '../src/modules/alerts/actions.ts'
import { alertFixture } from './alert-fixture.ts'

test('ack follow-up resolve: reads never acknowledge, concurrent one winner, original receipt replay, private notes and terminal guard',async()=>{
  const f=await alertFixture(),{alert}=await f.create(),id=alert.id
  expect(f.alerts.read(f.ctx(),id).version).toBe(1)
  await expect(f.alerts.act(f.ctx(),id,{action:'resolve',expectedVersion:1,note:'Invalid shortcut'})).rejects.toMatchObject({code:'version_conflict'})
  const intent=f.ctx(),body={action:'acknowledge',expectedVersion:1,note:'Private acknowledgment note'}
  const results=await Promise.allSettled([f.alerts.act(intent,id,body),f.alerts.act(f.ctx(),id,body)])
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
  expect((await f.alerts.act(intent,id,body)).replayed).toBe(true)
  f.advance(1000)
  const followed=await f.alerts.act(f.ctx(),id,{action:'follow_up',expectedVersion:2,actionType:'contact_attempt',occurredAt:f.clock().toISOString(),note:'INTERNAL secret synthetic note',patientSummary:'Perawat mencatat upaya tindak lanjut.'})
  expect(followed.resource.status).toBe('IN_PROGRESS')
  const resolved=await f.alerts.act(f.ctx(),id,{action:'resolve',expectedVersion:3,note:'INTERNAL closure summary',patientSummary:'Proses tindak lanjut ditutup.'})
  expect(resolved.resource.status).toBe('RESOLVED');expect(resolved.resource.timeline).toHaveLength(4)
  const patient=f.alerts.read(f.ctx('patient-a'),id),json=JSON.stringify(patient)
  expect(patient.status).toBe('RESOLVED');expect(json).not.toContain('INTERNAL');expect(json).not.toContain('internalNote');expect(json).not.toContain('actorId');expect(json).not.toContain('actionType')
  expect(json).toContain('Proses tindak lanjut ditutup.')
  await expect(f.alerts.act(f.ctx(),id,{action:'acknowledge',expectedVersion:4})).rejects.toMatchObject({code:'version_conflict'})
  expect((await f.alerts.act(intent,id,body)).resource.version).toBe(4)
  f.store.close();const store=f.reopen();expect(new AlertService(store,{codec:f.codec,clock:f.clock}).read(f.ctx('patient-a'),id)).toEqual(patient)
})

test('actor/state/time/privacy guards, atomic action failure, current capability and foreign scope',async()=>{
  const f=await alertFixture(),{alert}=await f.create(),id=alert.id
  expect(()=>f.alerts.read(f.ctx('nurse-b'),id)).toThrow();expect(()=>f.alerts.read(f.ctx('patient-b'),id)).toThrow()
  await expect(f.alerts.act(f.ctx('patient-a'),id,{action:'acknowledge',expectedVersion:1})).rejects.toMatchObject({code:'forbidden'})
  await expect(f.alerts.act(f.ctx(),id,{action:'acknowledge',expectedVersion:1,actorId:'other'})).rejects.toMatchObject({code:'validation_failed'})
  await f.store.transaction(tx=>tx.run("CREATE TRIGGER synthetic_action_failure BEFORE INSERT ON alert_actions WHEN NEW.action='acknowledge' BEGIN SELECT RAISE(ABORT,'unit failure'); END"))
  await expect(f.alerts.act(f.ctx(),id,{action:'acknowledge',expectedVersion:1})).rejects.toThrow()
  expect(f.alerts.read(f.ctx(),id).status).toBe('PENDING_REVIEW');expect(f.store.all('SELECT * FROM idempotency_receipts WHERE resource_id=?',[id])).toHaveLength(0)
  await f.store.transaction(tx=>tx.run('DROP TRIGGER synthetic_action_failure'))
  await f.alerts.act(f.ctx(),id,{action:'acknowledge',expectedVersion:1})
  const input={action:'follow_up',expectedVersion:2,actionType:'other',note:'documented attempt',occurredAt:f.clock().toISOString()}
  for(const patch of [{note:' '},{actionType:'automatic_dispatch'},{occurredAt:new Date(f.clock().getTime()+1000).toISOString()},{occurredAt:'2020-01-01T00:00:00.000Z'},{patientSummary:' '}])await expect(f.alerts.act(f.ctx(),id,{...input,...patch})).rejects.toMatchObject({code:'validation_failed'})
  await f.store.transaction(tx=>tx.run("UPDATE capability_grants SET revoked_at=?,revoked_by='operator' WHERE account_id='nurse-a' AND capability='alert.manage'",[f.clock().toISOString()]))
  expect(()=>f.alerts.read(f.ctx(),id)).toThrow();await expect(f.alerts.act(f.ctx(),id,input)).rejects.toMatchObject({code:'forbidden'})
})

test('bounded timeline pagination and filter-scoped queue; append-only source/actions and duplicate source fail closed',async()=>{
  const f=await alertFixture(),{alert}=await f.create(),id=alert.id
  await f.alerts.act(f.ctx(),id,{action:'acknowledge',expectedVersion:1})
  for(let version=2;version<25;version++)await f.alerts.act(f.ctx(),id,{action:'follow_up',expectedVersion:version,actionType:'other',occurredAt:f.clock().toISOString(),note:`Private note ${version}`})
  const latest=f.alerts.read(f.ctx('patient-a'),id),older=f.alerts.read(f.ctx('patient-a'),id,{limit:20,cursor:latest.timelineNextCursor!})
  expect(latest.timeline).toHaveLength(20);expect(older.timeline).toHaveLength(5);expect(new Set([...latest.timeline,...older.timeline].map(a=>a.id)).size).toBe(25)
  expect(()=>f.alerts.read(f.ctx(),id,{limit:20,cursor:latest.timelineNextCursor!})).toThrow()
  for(const sql of ["UPDATE alerts SET reason='fake' WHERE id=?","DELETE FROM alerts WHERE id=?","UPDATE alert_actions SET patient_summary=internal_note WHERE alert_id=?","DELETE FROM alert_actions WHERE alert_id=?"])await expect(f.store.transaction(tx=>tx.run(sql,[id]))).rejects.toThrow()
  const other=(await f.create()).alert
  await f.alerts.act(f.ctx(),id,{action:'resolve',expectedVersion:25,note:'Closure after documented follow-up'})
  expect(f.alerts.list(f.ctx(),undefined,{limit:1},'active').items.map(a=>a.id)).toEqual([other.id])
  const all=f.alerts.list(f.ctx(),undefined,{limit:1},'all');expect(all.nextCursor).not.toBeNull()
  expect(()=>f.alerts.list(f.ctx(),undefined,{limit:1,cursor:all.nextCursor!},'active')).toThrow()
  await expect(f.store.transaction(tx=>tx.run('INSERT INTO alerts SELECT ?,patient_id,checkin_id,attempt_id,source_type,source_action,reason,reported_at,source_at,status,version,acknowledged_at,resolved_at,created_at,updated_at FROM alerts WHERE id=?',['duplicate',other.id]))).rejects.toThrow()
})

test('missing current action evidence fails closed instead of publishing an unsupported acknowledgment',async()=>{
  const f=await alertFixture(),{alert}=await f.create()
  await f.store.transaction(tx=>tx.run("UPDATE alerts SET status='ACKNOWLEDGED',version=2,acknowledged_at=?,updated_at=? WHERE id=?",[f.clock().toISOString(),f.clock().toISOString(),alert.id]))
  expect(()=>f.alerts.read(f.ctx('patient-a'),alert.id)).toThrow()
  await expect(f.alerts.act(f.ctx(),alert.id,{action:'follow_up',expectedVersion:2,actionType:'other',occurredAt:f.clock().toISOString(),note:'Cannot fill a missing audit event silently'})).rejects.toMatchObject({code:'processing_failed'})
  expect(f.store.all('SELECT * FROM alert_actions WHERE alert_id=?',[alert.id])).toHaveLength(1)
})
