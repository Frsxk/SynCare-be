import { expect,test } from 'bun:test'
import { checkinFixture } from './checkin-submit.test.ts'
import { CheckinService } from '../src/modules/checkins/service.ts'
import { CheckinProcessor } from '../src/modules/checkins/processor.ts'
import { routine } from './f2-context.test.ts'
test('f2_outcomes_typed: internal process targets exact report/attempt and repeated process never invokes F2 twice',async()=>{
  const f=await checkinFixture()
  const first=await f.checkins.submit(f.ctx('patient-a'),f.first.id,{message:'First synthetic report'})
  const second=await f.checkins.submit(f.ctx('patient-a'),f.first.id,{message:'Second synthetic report'})
  let calls=0
  const processor=new CheckinProcessor(f.store,{runF2:async context=>{calls++;expect(context.message).toBe('Second synthetic report');return{raw:{unit:true},outputText:JSON.stringify(routine(context.patientId,context.baselineScore)),sessionId:context.sessionId}}})
  const service=new CheckinService(f.store,{codec:f.codec,processor})
  await expect(service.process(second.resource.id,first.resource.processing.id)).rejects.toMatchObject({code:'not_found'})
  const result=await service.process(second.resource.id,second.resource.processing.id)
  expect(result.id).toBe(second.resource.id);expect(result.processing.state).toBe('SUCCEEDED')
  expect((await service.process(second.resource.id,second.resource.processing.id)).id).toBe(result.id)
  expect(calls).toBe(1)
  expect((await f.checkins.read(f.ctx('patient-a'),first.resource.id)).processing.state).toBe('PENDING')
})
