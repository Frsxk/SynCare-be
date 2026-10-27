import { expect,test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { reviewFixture } from './review-fixture.ts'
import { startReview } from '../src/modules/reviews/start.ts'
import { readReview } from '../src/modules/reviews/registry.ts'
import type { ReviewGateway } from '../src/modules/reviews/contracts.ts'
test('review_start_lost_response: intent before call, START_UNKNOWN durable, same key never dispatches twice',async()=>{
  const f=await reviewFixture(),draft=await f.draft(),ctx=f.ctx();let starts=0
  const gateway:ReviewGateway={start:async()=>{starts++;expect(f.store.get("SELECT id FROM review_jobs WHERE draft_id=? AND dispatch_at IS NOT NULL",[draft.id])).not.toBeNull();throw Error('lost_handle')},snapshot:async()=>({status:'failed'}),resume:async()=>{}}
  const first=await startReview(f.store,f.plans,gateway,ctx,draft.id,{})
  expect(first.resource.state).toBe('START_UNKNOWN')
  expect((await startReview(f.store,f.plans,gateway,ctx,draft.id,{})).resource.id).toBe(first.resource.id)
  expect(starts).toBe(1)
  await expect(startReview(f.store,f.plans,gateway,f.ctx(),draft.id,{})).rejects.toMatchObject({code:'version_conflict'})
  f.store.close();const restored=f.reopen()
  expect(readReview(restored,ctx,first.resource.id).state).toBe('START_UNKNOWN')
  expect(()=>readReview(restored,f.ctx('nurse-b'),first.resource.id)).toThrow()
  expect(()=>readReview(restored,f.ctx('patient-a'),first.resource.id)).toThrow()
})
test('start bound to current confirmed source and one review per immutable draft',async()=>{
  const f=await reviewFixture(),draft=await f.draft();let starts=0
  const gateway:ReviewGateway={start:async()=>{starts++;return{jobId:randomUUID(),status:'queued'}},snapshot:async()=>({status:'queued'}),resume:async()=>{}}
  const first=await startReview(f.store,f.plans,gateway,f.ctx(),draft.id,{})
  expect(first.resource.state).toBe('RUNNING');expect(starts).toBe(1)
  await expect(startReview(f.store,f.plans,gateway,f.ctx(),draft.id,{actor:'forged'})).rejects.toMatchObject({code:'validation_failed'})
  expect(f.store.all('SELECT * FROM review_events WHERE review_id=?',[first.resource.id])).toHaveLength(3)
})
test('new discharge invalidates old draft eligibility without rewriting its source or starting upstream',async()=>{
  const f=await reviewFixture(),draft=await f.draft();let calls=0
  const version=f.store.get<{version:number}>('SELECT version FROM patients WHERE id=?',[f.first.id])!.version
  await f.discharges.addDischarge(f.ctx(),f.first.id,{expectedPatientVersion:version,sourceText:'Sumber pulang baru sintetis.'})
  const gateway:ReviewGateway={start:async()=>{calls++;return{jobId:randomUUID(),status:'queued'}},snapshot:async()=>({status:'queued'}),resume:async()=>{}}
  await expect(startReview(f.store,f.plans,gateway,f.ctx(),draft.id,{})).rejects.toMatchObject({code:'version_conflict'});expect(calls).toBe(0)
  expect(f.plans.read(f.ctx(),draft.id)).toEqual(draft)
})
