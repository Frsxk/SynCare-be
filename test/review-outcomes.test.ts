import { expect,test } from 'bun:test'
import { gateFixture } from './review-decision.test.ts'
import { decideReview } from '../src/modules/reviews/decision.ts'
import { readReview } from '../src/modules/reviews/registry.ts'
import { makeDraft } from './review-fixture.ts'
test('request_changes yields immutable new guarded DRAFT lineage and never starts another gate automatically',async()=>{
  const f=await gateFixture(),note='Permintaan perubahan sintetis.'
  await decideReview(f.store,f.gateway,f.ctx(),f.review.id,{expectedVersion:f.review.version,requestId:f.gate.requestId,actionId:'request_changes',reviewerNote:note})
  const revised=makeDraft({...f.draft.input,reviewer_note:note})
  f.gateway.snapshot=async()=>({status:'completed',output:JSON.stringify(revised)})
  await f.reconciler.reconcile(f.review.id)
  const current=readReview(f.store,f.ctx(),f.review.id)
  expect(current.state).toBe('REVISION_DRAFT');expect(current.revisedDraftId).not.toBeNull()
  const draft=f.plans.read(f.ctx(),current.revisedDraftId!)
  expect(draft.parentDraftId).toBe(f.draft.id);expect(draft.sourceReviewId).toBe(f.review.id);expect(draft.state).toBe('DRAFT')
  expect(f.store.all('SELECT * FROM review_jobs')).toHaveLength(1);expect(f.store.all('SELECT * FROM approval_links')).toHaveLength(0)
  expect(f.plans.read(f.ctx(),f.draft.id)).toEqual(f.draft)
})
test('review_nonapprove_truth: exact source escalation/fallback and invalid output are never approved',async()=>{
  const f=await gateFixture()
  f.gateway.snapshot=async()=>({status:'completed',output:JSON.stringify({action:'escalate_to_clinician',plan_json:f.draft.artifact})})
  await f.reconciler.reconcile(f.review.id)
  expect(readReview(f.store,f.ctx(),f.review.id).state).toBe('ESCALATED');expect(f.store.all('SELECT * FROM approval_links')).toHaveLength(0)
  const g=await gateFixture();g.gateway.snapshot=async()=>({status:'completed',output:'not JSON'})
  await g.reconciler.reconcile(g.review.id)
  expect(readReview(g.store,g.ctx(),g.review.id).state).toBe('INVALID');expect(g.store.all('SELECT * FROM approval_links')).toHaveLength(0)
})
