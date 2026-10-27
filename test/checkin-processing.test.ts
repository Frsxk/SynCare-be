import { expect, test } from 'bun:test'
import { CheckinProcessor } from '../src/modules/checkins/processor.ts'
import { LangflowTimeoutError } from '../src/plugins/langflow.ts'
import { checkinFixture } from './checkin-submit.test.ts'
import { routine } from './f2-context.test.ts'

test('durable F2 runs after commit; binds original confirmed baseline, commits actual outcome without changing confirmation',async()=>{
  const f=await checkinFixture()
  const c=await f.checkins.submit(f.ctx('patient-a'),f.first.id,{message:'Unit report'})
  let calls=0
  const worker=new CheckinProcessor(f.store,{runF2:async context=>{calls++;expect(f.store.get('SELECT id FROM checkins WHERE id=?',[c.resource.id])).not.toBeNull()
    expect(context.patientId).toBe(f.first.id);expect(context.baselineScore).toBe(1);expect(context.assessmentId).toBe(f.assessment.id)
    return{raw:{unit:'exact'},outputText:JSON.stringify(routine(context.patientId,context.baselineScore)),sessionId:context.sessionId}}})
  await Promise.all([worker.processNext(),worker.processNext()])
  expect(calls).toBe(1)
  const saved=await f.checkins.read(f.ctx('patient-a'),c.resource.id)
  expect(saved.processing.state).toBe('SUCCEEDED')
  expect(saved.outcome?.action).toBe('continue_monitoring')
  expect(f.store.all('SELECT * FROM risk_confirmations')).toHaveLength(1)
})
test('unknown/invalid/failed are distinct, never automatically replayed; known urgent survives alert-work failure',async()=>{
  const f=await checkinFixture()
  for(const mode of ['UNKNOWN','INVALID','FAILED','SUCCEEDED'] as const){
    const c=await f.checkins.submit(f.ctx('patient-a'),f.first.id,{message:`Unit ${mode}`})
    const worker=new CheckinProcessor(f.store,{runF2:async()=>{
      if(mode==='UNKNOWN')throw new LangflowTimeoutError(1,'synthetic')
      if(mode==='FAILED')throw Error('private exception')
      return{raw:{unit:true},outputText:mode==='INVALID'?'{}':'{"action":"escalate_immediately","reason":"server synthetic quote"}',sessionId:null}
    }})
    if(mode==='SUCCEEDED')await f.store.transaction(tx=>tx.run("CREATE TRIGGER synthetic_alert_failure BEFORE INSERT ON work_items WHEN NEW.kind='ALERT_F2' BEGIN SELECT RAISE(ABORT,'unit alert failure'); END"))
    await worker.processNext()
    const saved=await f.checkins.read(f.ctx('patient-a'),c.resource.id)
    expect(saved.processing.state).toBe(mode)
    expect(JSON.stringify(saved)).not.toContain('private exception')
    if(mode==='SUCCEEDED'){expect(saved.outcome?.action).toBe('escalate_immediately');expect(saved.alertEvidence).toBe('unavailable')}
    expect(await worker.processNext()).toBe(false)
  }
})

test('restart recovery marks expired delivery unknown without rerun; source replacement retains historical binding',async()=>{
  const f=await checkinFixture(),now=new Date()
  const c=await f.checkins.submit(f.ctx('patient-a'),f.first.id,{message:'Interrupted synthetic report'})
  const work=await f.store.claimWork('CHECKIN_F2',new Date(now.getTime()+1000).toISOString(),1)
  expect(work).not.toBeNull()
  let calls=0
  const worker=new CheckinProcessor(f.store,{clock:()=>new Date(now.getTime()+2000),runF2:async()=>{calls++;throw Error('no automatic replay')}})
  await worker.recoverExpired()
  expect((await f.checkins.read(f.ctx('patient-a'),c.resource.id)).processing.state).toBe('UNKNOWN')
  expect(await worker.processNext()).toBe(false)
  expect(calls).toBe(0)
  const version=f.store.get<{version:number}>('SELECT version FROM patients WHERE id=?',[f.first.id])!.version
  await f.discharges.addDischarge(f.ctx(),f.first.id,{sourceText:'Synthetic new source',expectedPatientVersion:version})
  expect((await f.checkins.read(f.ctx('patient-a'),c.resource.id)).baseline?.applicable).toBe(false)
  const next=await f.checkins.submit(f.ctx('patient-a'),f.first.id,{message:'Still save report with new unconfirmed source'})
  expect(next.resource.processing.state).toBe('BLOCKED_BASELINE')
})

test('trigger_plan_review stays separate from acute alert and original confirmed F1',async()=>{
  const f=await checkinFixture()
  const c=await f.checkins.submit(f.ctx('patient-a'),f.first.id,{message:'Synthetic review-branch fixture'})
  await new CheckinProcessor(f.store,{runF2:async context=>({raw:{unit:true},sessionId:context.sessionId,
    outputText:JSON.stringify({...routine(context.patientId,context.baselineScore),action:'trigger_plan_review',tier:'HIGH',score:4,tier_changed:true})})}).processNext()
  const record=await f.checkins.read(f.ctx('patient-a'),c.resource.id)
  expect(record.outcome?.action).toBe('trigger_plan_review')
  expect(record.alertEvidence).toBe('not_applicable')
  expect(f.store.all("SELECT * FROM work_items WHERE kind='ALERT_F2'")).toHaveLength(0)
  expect(f.store.get<{category:string}>('SELECT category FROM risk_confirmations')?.category).toBe('LOW')
})
