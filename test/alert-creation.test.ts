import { expect,test } from 'bun:test'
import { AlertProducer } from '../src/modules/alerts/producer.ts'
import { alertFixture } from './alert-fixture.ts'
import { AssessmentService } from '../src/modules/assessments/service.ts'
import { ConfirmationService } from '../src/modules/assessments/confirmation.ts'
import { f1Output } from './assessment.test.ts'

test('alert_red_flag_once: LOW acute creates once from trusted report; duplicate/cross-worker replay ignores forged payload identity; routine/review do not alert',async()=>{
  const f=await alertFixture(),report=await f.source()
  expect(report.baseline?.score).toBe(1)
  await f.store.transaction(tx=>tx.run("UPDATE work_items SET payload_json=? WHERE kind='ALERT_F2'",[JSON.stringify({patientId:f.second.id,checkinId:'forged',attemptId:'forged'})]))
  await f.producer.reconcile();await Promise.all([f.producer.processNext(),new AlertProducer(f.store,f.clock).processNext()]);await f.producer.reconcile();await f.producer.processNext()
  const rows=f.alerts.list(f.ctx(),undefined,{limit:20}).items
  expect(rows).toHaveLength(1);expect(rows[0]?.patientId).toBe(f.first.id);expect(rows[0]?.source.reason).toBe('Alasan akut sintetis dari F2.')
  expect(rows[0]?.status).toBe('PENDING_REVIEW');expect(f.alerts.read(f.ctx(),rows[0]!.id).timeline).toHaveLength(1)
  await f.source('routine');await f.source('review');await f.producer.reconcile();expect(await f.producer.processNext()).toBe(false)
  expect(f.store.all('SELECT * FROM alerts')).toHaveLength(1)
})

test('alert write/enqueue failure preserves known warning; missing enqueue, local lease and retry reconcile without another F2 call',async()=>{
  const f=await alertFixture(),report=await f.source()
  await f.store.transaction(tx=>tx.run("DELETE FROM work_items WHERE kind='ALERT_F2'"))
  expect((await f.checkins.read(f.ctx('patient-a'),report.id)).outcome?.action).toBe('escalate_immediately')
  await f.producer.reconcile()
  await f.store.transaction(tx=>tx.run("CREATE TRIGGER synthetic_alert_failure BEFORE INSERT ON alert_actions BEGIN SELECT RAISE(ABORT,'synthetic failure'); END"))
  await f.producer.processNext();expect(f.store.all('SELECT * FROM alerts')).toHaveLength(0)
  expect((await f.checkins.read(f.ctx('patient-a'),report.id)).outcome?.action).toBe('escalate_immediately')
  await f.store.transaction(tx=>tx.run('DROP TRIGGER synthetic_alert_failure'))
  f.advance(31000);await f.producer.reconcile()
  expect(await f.store.claimWork('ALERT_F2',f.clock().toISOString(),1000)).not.toBeNull()
  f.advance(2000);await f.producer.reconcile();await f.producer.processNext()
  expect(f.store.all('SELECT * FROM alerts')).toHaveLength(1)
  expect(f.store.get<{state:string}>("SELECT state FROM work_items WHERE kind='ALERT_F2'")?.state).toBe('SUCCEEDED')
  expect(f.store.get<{attempt_count:number}>("SELECT attempt_count FROM work_items WHERE kind='CHECKIN_F2'")?.attempt_count).toBe(1)
})

test('HIGH confirmed baseline with routine F2 is not automatically an acute alert',async()=>{
  const f=await alertFixture()
  const assessment=await new AssessmentService(f.store,{codec:f.codec,runF1:async()=>({raw:{synthetic:true},outputText:JSON.stringify({...f1Output,score:7,tier:'HIGH'}),sessionId:null})}).run(f.ctx(),f.discharge.id)
  await new ConfirmationService(f.store).confirm(f.ctx(),assessment.id,{expectedVersion:assessment.version,category:'HIGH'})
  const report=await f.source('routine');expect(report.baseline?.score).toBe(7);expect(report.outcome?.action).toBe('continue_monitoring')
  await f.producer.reconcile();expect(await f.producer.processNext()).toBe(false);expect(f.store.all('SELECT * FROM alerts')).toHaveLength(0)
})
