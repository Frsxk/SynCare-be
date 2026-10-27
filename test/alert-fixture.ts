import { randomUUID } from 'node:crypto'
import { checkinFixture } from './checkin-submit.test.ts'
import { CheckinProcessor } from '../src/modules/checkins/processor.ts'
import { CheckinService } from '../src/modules/checkins/service.ts'
import { AlertProducer } from '../src/modules/alerts/producer.ts'
import { AlertService } from '../src/modules/alerts/actions.ts'
import { routine } from './f2-context.test.ts'
import { NOW } from './migrations/fixture.ts'
export async function alertFixture(){
  const f=await checkinFixture();let now=Date.now()
  const clock=()=>new Date(now),advance=(ms:number)=>{now+=ms}
  await f.store.transaction(tx=>{for(const id of ['nurse-a','nurse-b'])tx.run('INSERT INTO capability_grants VALUES (?,?,?,?,?,?,?)',[randomUUID(),id,'alert.manage','operator',NOW,null,null])})
  const alerts=new AlertService(f.store,{codec:f.codec,clock}),producer=new AlertProducer(f.store,clock)
  const checkins=new CheckinService(f.store,{codec:f.codec,clock})
  const source=async(action:'acute'|'routine'|'review'='acute')=>{
    const report=(await checkins.submit(f.ctx('patient-a'),f.first.id,{message:'Synthetic M07 source'})).resource
    const processor=new CheckinProcessor(f.store,{clock,runF2:async c=>({raw:{synthetic:true},sessionId:c.sessionId,outputText:JSON.stringify(action==='acute'?{action:'escalate_immediately',reason:'Alasan akut sintetis dari F2.'}:{...routine(c.patientId,c.baselineScore),...(c.baselineScore===7?{score:7,tier:'HIGH',baseline_tier:'HIGH'}:{}),...(action==='review'?{action:'trigger_plan_review'}:{})})})})
    await processor.processNext({checkinId:report.id,attemptId:report.processing.id});return checkins.read(f.ctx('patient-a'),report.id)
  }
  const create=async()=>{const report=await source();await producer.reconcile();await producer.processNext();return{report,alert:alerts.list(f.ctx(),undefined,{limit:20}).items.find(a=>a.source.reportId===report.id)!}}
  return{...f,checkins,clock,advance,alerts,producer,source,create}
}
