import { expect,test } from 'bun:test'
import { reviewFixture } from './review-fixture.ts'
import { PlanService } from '../src/modules/plans/service.ts'
test('draft_uses_trusted_f1: source is stored F1; injected score rejected; committed key never repeats inference',async()=>{
  const f=await reviewFixture(),ctx=f.ctx(),input={assessmentId:f.assessment.id,followupDate:'2026-11-02',hotline:'Kontak sintetis'}
  const first=await f.plans.draft(ctx,f.first.id,input)
  expect(first.resource.state).toBe('DRAFT')
  expect(JSON.parse(f.calls[0]!).f1_scored_output).toEqual(f.assessment.output)
  expect((await f.plans.draft(ctx,f.first.id,input)).resource).toEqual(first.resource)
  expect(f.calls).toHaveLength(1)
  await expect(f.plans.draft(f.ctx(),f.first.id,{...input,score:7})).rejects.toMatchObject({code:'validation_failed'})
  expect(()=>f.plans.read(f.ctx('patient-a'),first.resource.id)).toThrow()
  expect(()=>f.plans.read(f.ctx('nurse-b'),first.resource.id)).toThrow()
  await expect(f.plans.draft(ctx,f.first.id,{...input,hotline:'different'})).rejects.toMatchObject({code:'idempotency_conflict'})
})
test('invalid or uncertain F3 cannot replace previous immutable artifact and same key does not rerun',async()=>{
  const f=await reviewFixture(),prior=await f.draft(),ctx=f.ctx(),input={assessmentId:f.assessment.id,followupDate:'2026-11-02',hotline:'Kontak sintetis'}
  let calls=0
  const failing=new PlanService(f.store,async()=>{calls++;throw Error('lost_response')})
  expect((await failing.draft(ctx,f.first.id,input)).resource.state).toBe('UNKNOWN')
  expect((await failing.draft(ctx,f.first.id,input)).resource.state).toBe('UNKNOWN');expect(calls).toBe(1)
  const invalid=new PlanService(f.store,async()=>({raw:{},sessionId:null,outputText:'{"status":"approved"}'}))
  expect((await invalid.draft(f.ctx(),f.first.id,input)).resource.state).toBe('INVALID')
  expect(f.plans.read(f.ctx(),prior.id)).toEqual(prior)
  await expect(f.store.transaction(tx=>tx.run("UPDATE care_plan_drafts SET artifact_json='{}',version=version+1 WHERE id=?",[prior.id]))).rejects.toThrow()
})
