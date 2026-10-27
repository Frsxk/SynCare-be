import { expect,test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { reviewFixture } from './review-fixture.ts'
import { startReview } from '../src/modules/reviews/start.ts'
import { decideReview } from '../src/modules/reviews/decision.ts'
import { ReviewReconciler } from '../src/modules/reviews/reconciler.ts'
import { ApprovalEvidenceReader } from '../src/modules/reviews/approval-evidence.ts'
import { readReview } from '../src/modules/reviews/registry.ts'
import type { ReviewGateway } from '../src/modules/reviews/contracts.ts'
export async function gateFixture(){
  const f=await reviewFixture(),draft=await f.draft(),calls:unknown[][]=[];let status='suspended',lost=false
  const gate={requestId:`gate:${randomUUID()}`,options:[{actionId:'approve',label:'Approve'},{actionId:'request_changes',label:'Request Changes'}]}
  const gateway:ReviewGateway={start:async()=>({jobId:randomUUID(),status:'queued'}),snapshot:async()=>({status,gate,gatePlan:draft.artifact}),resume:async(...args)=>{calls.push(args);if(lost)throw Error('lost_resume')}}
  const reconciler=new ReviewReconciler(f.store,gateway,new ApprovalEvidenceReader(`${f.store.path}.missing`))
  const started=await startReview(f.store,f.plans,gateway,f.ctx(),draft.id,{})
  await reconciler.reconcile(started.resource.id)
  return{...f,draft,gateway,gate,calls,reconciler,review:readReview(f.store,f.ctx(),started.resource.id),status:(value:string)=>{status=value},lose:()=>{lost=true}}
}
test('review_actual_gate_only: stale/disallowed/forged actor rejected; server actor sent once and HTTP acceptance never approval',async()=>{
  const f=await gateFixture(),input={expectedVersion:f.review.version,requestId:f.gate.requestId,actionId:'approve'}
  expect(f.review.state).toBe('WAITING_FOR_HUMAN');expect(f.review.gate?.options).toHaveLength(2)
  for(const body of [{...input,actor:'forged'},{...input,requestId:'stale'},{...input,actionId:'escalate'},{...input,expectedVersion:1}])await expect(decideReview(f.store,f.gateway,f.ctx(),f.review.id,body)).rejects.toBeInstanceOf(Error)
  expect(f.calls).toHaveLength(0)
  const ctx=f.ctx(),first=await decideReview(f.store,f.gateway,ctx,f.review.id,input)
  expect(first.resource.state).toBe('DECISION_PENDING');expect(f.calls).toHaveLength(1);expect(f.calls[0]?.[3]).toBe(ctx.principal.id)
  await decideReview(f.store,f.gateway,ctx,f.review.id,input);expect(f.calls).toHaveLength(1)
  await expect(decideReview(f.store,f.gateway,f.ctx(),f.review.id,input)).rejects.toMatchObject({code:'version_conflict'})
})
test('lost_resume_single_gate: one concurrent claim; unknown survives recovery without automatic resend',async()=>{
  const f=await gateFixture();f.lose()
  const input={expectedVersion:f.review.version,requestId:f.gate.requestId,actionId:'approve'},ctx=f.ctx()
  const results=await Promise.allSettled([decideReview(f.store,f.gateway,ctx,f.review.id,input),decideReview(f.store,f.gateway,f.ctx(),f.review.id,{...input,actionId:'request_changes'})])
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(f.calls).toHaveLength(1)
  expect(readReview(f.store,ctx,f.review.id).state).toBe('DECISION_UNKNOWN')
  await f.reconciler.recover();await f.reconciler.reconcile(f.review.id)
  expect(readReview(f.store,ctx,f.review.id).state).toBe('DECISION_UNKNOWN')
  expect(f.calls).toHaveLength(1)
  await decideReview(f.store,f.gateway,ctx,f.review.id,input);expect(f.calls).toHaveLength(1)
})
test('missing upstream job becomes UNKNOWN without replay; timeout failure is not explicit expiry',async()=>{
  const f=await gateFixture()
  f.gateway.snapshot=async()=>{throw Error('unreachable')}
  await f.reconciler.reconcile(f.review.id)
  expect(readReview(f.store,f.ctx(),f.review.id).state).toBe('UNKNOWN')
  f.gateway.snapshot=async()=>({status:'timed_out'})
  await f.reconciler.reconcile(f.review.id)
  expect(readReview(f.store,f.ctx(),f.review.id).state).toBe('EXPIRED')
  expect(f.calls).toHaveLength(0)
})
