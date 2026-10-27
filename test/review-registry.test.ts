import { expect,test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { reviewFixture } from './review-fixture.ts'
import { startReview } from '../src/modules/reviews/start.ts'
import { ReviewReconciler } from '../src/modules/reviews/reconciler.ts'
import { ApprovalEvidenceReader } from '../src/modules/reviews/approval-evidence.ts'
import { readReview } from '../src/modules/reviews/registry.ts'
import type { ReviewGateway } from '../src/modules/reviews/contracts.ts'
test('lost start binds only exact discovered existing job/session/plan and never calls start twice after reopen',async()=>{
  const f=await reviewFixture(),draft=await f.draft(),jobId=randomUUID();let starts=0,session=''
  const gateway:ReviewGateway={start:async(_,id)=>{starts++;session=id;throw Error('lost_response')},discover:async id=>{expect(id).toBe(session);return jobId},snapshot:async()=>({status:'suspended',gatePlan:draft.artifact,gate:{requestId:'actual-gate',options:[{actionId:'approve',label:'Approve'}]}}),resume:async()=>{}}
  const value=(await startReview(f.store,f.plans,gateway,f.ctx(),draft.id,{})).resource
  f.store.close();const store=f.reopen(),reconciler=new ReviewReconciler(store,gateway,new ApprovalEvidenceReader(`${store.path}.absent`))
  await reconciler.recover();await reconciler.tick();expect(readReview(store,f.ctx(),value.id).state).toBe('WAITING_FOR_HUMAN');expect(starts).toBe(1)
  expect(store.all('SELECT * FROM review_jobs')).toHaveLength(1)
})
test('mismatched upstream gate source remains unknown rather than accepting display text as a new gate',async()=>{
  const f=await reviewFixture(),draft=await f.draft()
  const gateway:ReviewGateway={start:async()=>({jobId:randomUUID(),status:'queued'}),snapshot:async()=>({status:'suspended',gatePlan:{patient_id:'other'},gate:{requestId:'wrong',options:[{actionId:'approve',label:'Approve'}]}}),resume:async()=>{throw Error('must_not_call')}}
  const value=(await startReview(f.store,f.plans,gateway,f.ctx(),draft.id,{})).resource
  await new ReviewReconciler(f.store,gateway,new ApprovalEvidenceReader(`${f.store.path}.absent`)).reconcile(value.id)
  expect(readReview(f.store,f.ctx(),value.id).state).toBe('UNKNOWN');expect(readReview(f.store,f.ctx(),value.id).gate).toBeNull()
})
