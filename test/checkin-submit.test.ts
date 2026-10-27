import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { assessmentFixture, f1Output } from './assessment.test.ts'
import { AssessmentService } from '../src/modules/assessments/service.ts'
import { ConfirmationService } from '../src/modules/assessments/confirmation.ts'
import { CheckinService } from '../src/modules/checkins/service.ts'

export async function checkinFixture() {
  const f=await assessmentFixture()
  const assessments=new AssessmentService(f.store,{codec:f.codec,runF1:async()=>({raw:{unit:true},outputText:JSON.stringify(f1Output),sessionId:null})})
  const a=await assessments.run(f.ctx(),f.discharge.id)
  await new ConfirmationService(f.store).confirm(f.ctx(),a.id,{category:f1Output.tier,expectedVersion:a.version})
  const checkins=new CheckinService(f.store,{codec:f.codec})
  return {...f,checkins,assessment:a}
}
test('checkin_retry_identity: commit report/outbox/receipt together; same key count1, new key same text count2; missing baseline still saves',async()=>{
  const f=await checkinFixture(),intent=f.ctx('patient-a')
  const first=await f.checkins.submit(intent,f.first.id,{message:'  Unit synthetic message\n'})
  expect(first.resource.processing.state).toBe('PENDING')
  expect(first.resource.baseline?.score).toBe(1)
  expect(first.resource.message).toBe('  Unit synthetic message\n')
  expect((await f.checkins.submit(intent,f.first.id,{message:'  Unit synthetic message\n'})).resource.id).toBe(first.resource.id)
  await expect(f.checkins.submit(intent,f.first.id,{message:'Different body with the same key'})).rejects.toMatchObject({code:'idempotency_conflict'})
  await f.checkins.submit(f.ctx('patient-a'),f.first.id,{message:'  Unit synthetic message\n'})
  expect(f.store.all('SELECT * FROM checkins')).toHaveLength(2)
  expect(f.store.all("SELECT * FROM work_items WHERE kind='CHECKIN_F2'")).toHaveLength(2)
  const blocked=await f.checkins.submit(f.ctx('patient-b'),f.second.id,{message:'Synthetic report without F1'})
  expect(blocked.resource.processing.state).toBe('BLOCKED_BASELINE')
  expect(blocked.resource.baseline).toBeNull()
  expect(f.store.all("SELECT * FROM work_items WHERE kind='CHECKIN_F2'")).toHaveLength(2)
})
test('submit authority/input and commit failure never return saved success or leak another patient',async()=>{
  const f=await checkinFixture()
  await expect(f.checkins.submit(f.ctx('nurse-a'),f.first.id,{message:'x'})).rejects.toMatchObject({code:'forbidden'})
  await expect(f.checkins.submit(f.ctx('patient-a'),f.second.id,{message:'x'})).rejects.toMatchObject({code:'not_found'})
  await expect(f.checkins.submit(f.ctx('patient-a'),f.first.id,{message:'x',baselineScore:7})).rejects.toMatchObject({code:'validation_failed'})
  await f.store.transaction(tx=>tx.run("CREATE TRIGGER synthetic_commit_failure BEFORE INSERT ON processing_attempts BEGIN SELECT RAISE(ABORT,'unit failure'); END"))
  await expect(f.checkins.submit({...f.ctx('patient-a'),idempotencyKey:randomUUID()},f.first.id,{message:'x'})).rejects.toThrow()
  expect(f.store.all('SELECT * FROM checkins')).toHaveLength(0)
  expect(f.store.all("SELECT * FROM work_items WHERE kind='CHECKIN_F2'")).toHaveLength(0)
})
