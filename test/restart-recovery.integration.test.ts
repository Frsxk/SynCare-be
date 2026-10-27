import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { expect,test } from 'bun:test'
import { gateFixture } from './review-decision.test.ts'
import { decideReview } from '../src/modules/reviews/decision.ts'
import { ReviewReconciler } from '../src/modules/reviews/reconciler.ts'
import { ApprovalEvidenceReader } from '../src/modules/reviews/approval-evidence.ts'
import { readReview } from '../src/modules/reviews/registry.ts'
test('recovery_dual_store_crash: owned child exits after canonical commit; restart reconciles one exact approval without another decision',async()=>{
  const f=await gateFixture(),statePath=f.store.path,canonicalPath=`${statePath}.crash-canonical`
  await decideReview(f.store,f.gateway,f.ctx(),f.review.id,{expectedVersion:f.review.version,requestId:f.gate.requestId,actionId:'approve',reviewerNote:'Private isolated fault fixture'})
  f.store.close()
  const child=Bun.spawn([process.execPath,fileURLToPath(new URL('./fixtures/review-crash-worker.ts',import.meta.url))],{stdin:new Blob([JSON.stringify({statePath,canonicalPath,reviewId:f.review.id})]),stdout:'pipe',stderr:'pipe'})
  const stdout=await new Response(child.stdout).text(),stderr=await new Response(child.stderr).text(),exit=await child.exited
  if(exit!==17)throw Error(stderr)
  const output=JSON.parse(stdout) as {approvedAt:string}
  expect(exit).toBe(17)
  const store=f.reopen(),reader=new ApprovalEvidenceReader(canonicalPath),recovery=new ReviewReconciler(store,f.gateway,reader)
  expect(readReview(store,f.ctx(),f.review.id).state).toBe('DECISION_PENDING')
  expect(store.all('SELECT * FROM approval_links')).toHaveLength(0)
  f.gateway.snapshot=async()=>({status:'completed',output:JSON.stringify({action:'approved',patient_id:f.first.id,approved_at:output.approvedAt})})
  await recovery.recover();await recovery.reconcile(f.review.id);await recovery.reconcile(f.review.id)
  expect(readReview(store,f.ctx(),f.review.id).state).toBe('APPROVED');expect(store.all('SELECT * FROM approval_links')).toHaveLength(1);expect(f.calls).toHaveLength(1)
  const db=new Database(canonicalPath,{readonly:true});expect(db.query<{n:number},[]>('SELECT count(*) n FROM approved_plans').get()?.n).toBe(1);db.close()
})
