import { Database } from 'bun:sqlite'
import { expect,test } from 'bun:test'
import { gateFixture } from './review-decision.test.ts'
import { decideReview } from '../src/modules/reviews/decision.ts'
import { ReviewReconciler } from '../src/modules/reviews/reconciler.ts'
import { ApprovalEvidenceReader } from '../src/modules/reviews/approval-evidence.ts'
import { reviewRow,readReview } from '../src/modules/reviews/registry.ts'
import { ApprovedPlans } from '../src/modules/plans/approved.ts'
export async function canonicalFixture(){
  const f=await gateFixture(),path=`${f.store.path}.canonical`,db=new Database(path,{create:true})
  db.exec('CREATE TABLE approved_plans(plan_json TEXT,approved_at TEXT,reviewer_note TEXT);CREATE TABLE audit_log(action TEXT,actor TEXT,timestamp TEXT,payload TEXT)');db.close()
  const evidence=new ApprovalEvidenceReader(path),reconciler=new ReviewReconciler(f.store,f.gateway,evidence),approved=new ApprovedPlans(f.store,evidence,f.codec)
  const time=new Date().toISOString(),ctx=f.ctx(),note='INTERNAL synthetic reviewer note'
  const approve=()=>decideReview(f.store,f.gateway,ctx,f.review.id,{expectedVersion:f.review.version,requestId:f.gate.requestId,actionId:'approve',reviewerNote:note})
  const write=(audit=true)=>{const db=new Database(path),r=reviewRow(f.store,f.review.id)
    db.transaction(()=>{db.query('INSERT INTO approved_plans VALUES (?,?,?)').run(JSON.stringify(f.draft.artifact),time,note);if(audit)db.query('INSERT INTO audit_log VALUES (?,?,?,?)').run('Approve',ctx.principal.id,time,JSON.stringify({request_id:f.gate.requestId,session_id:r.session_id,decision:{action_id:'approve',actor:ctx.principal.id,reviewer_note:note},plan_json:f.draft.artifact}))})()
    db.close()
  }
  const finish=()=>{f.gateway.snapshot=async()=>({status:'completed',output:JSON.stringify({action:'approved',patient_id:f.first.id,approved_at:time})})}
  return{...f,path,evidence,reconciler,approved,time,approvingCtx:ctx,note,approve,write,finish}
}
test('canonical row plus exact audit required; approved projection strips private source/reviewer and survives reopen',async()=>{
  const f=await canonicalFixture();await f.approve();f.write();f.finish();await f.reconciler.reconcile(f.review.id)
  expect(readReview(f.store,f.ctx(),f.review.id).state).toBe('APPROVED')
  const page=f.approved.list(f.ctx('patient-a'),f.first.id,{limit:20})
  expect(page.items).toHaveLength(1);expect(page.items[0]?.plan.status).toBe('DRAFT pending human approval')
  expect(JSON.stringify(page)).not.toContain('reviewer_note');expect(JSON.stringify(page)).not.toContain('source_input');expect(JSON.stringify(page)).not.toContain(f.note)
  const legacy=f.approved.legacy(f.ctx('patient-a'),f.first.id)
  expect(legacy.plans).toHaveLength(1);expect(legacy.plans[0]?.reviewer_note).toBe('');expect(JSON.stringify(legacy)).not.toContain(f.note);expect(JSON.stringify(legacy)).not.toContain('source_input')
  expect(()=>f.approved.list(f.ctx('patient-b'),f.first.id,{limit:20})).toThrow()
  await expect(f.store.transaction(tx=>tx.run("UPDATE review_jobs SET state='RUNNING',version=version+1 WHERE id=?",[f.review.id]))).rejects.toThrow()
  await f.store.migrate();f.store.close();const reopened=f.reopen()
  expect(new ApprovedPlans(reopened,f.evidence,f.codec).list(f.ctx('patient-a'),f.first.id,{limit:20})).toEqual(page)
})
test('missing audit or ambiguous canonical rows never usable; backend does not insert canonical approvals',async()=>{
  const f=await canonicalFixture();await f.approve();f.write(false);f.finish();await f.reconciler.reconcile(f.review.id)
  expect(readReview(f.store,f.ctx(),f.review.id).state).toBe('DECISION_UNKNOWN')
  expect(f.approved.list(f.ctx('patient-a'),f.first.id,{limit:20}).items).toHaveLength(0)
  f.write();await f.reconciler.reconcile(f.review.id)
  expect(readReview(f.store,f.ctx(),f.review.id).state).toBe('DECISION_UNKNOWN')
  expect(f.store.all('SELECT * FROM approval_links')).toHaveLength(0)
  const db=new Database(f.path);expect(db.query<{count:number},[]>('SELECT count(*) count FROM approved_plans').get()?.count).toBe(2);db.close()
})
test('canonical commit before local transaction failure reconciles after restart with exactly one link',async()=>{
  const f=await canonicalFixture();await f.approve();f.write();f.finish()
  await f.store.transaction(tx=>tx.run("CREATE TRIGGER owned_review_fault BEFORE INSERT ON approval_links BEGIN SELECT RAISE(ABORT,'owned fault'); END"))
  await f.reconciler.reconcile(f.review.id);expect(f.store.all('SELECT * FROM approval_links')).toHaveLength(0)
  await f.store.transaction(tx=>tx.run('DROP TRIGGER owned_review_fault'));f.store.close();const reopened=f.reopen()
  const recovery=new ReviewReconciler(reopened,f.gateway,f.evidence);await recovery.recover();await recovery.reconcile(f.review.id);await recovery.reconcile(f.review.id)
  expect(readReview(reopened,f.ctx(),f.review.id).state).toBe('APPROVED');expect(reopened.all('SELECT * FROM approval_links')).toHaveLength(1);expect(f.calls).toHaveLength(1)
})
test('unavailable canonical file is distinct from no approved artifact',async()=>{
  const f=await canonicalFixture()
  expect(f.approved.list(f.ctx('patient-a'),f.first.id,{limit:20}).items).toHaveLength(0)
  const missing=new ApprovedPlans(f.store,new ApprovalEvidenceReader(`${f.path}.absent`),f.codec)
  expect(()=>missing.list(f.ctx('patient-a'),f.first.id,{limit:20})).toThrow()
})
test('corrupt linked canonical artifact or mismatched audit actor fail closed even after an earlier verified approval',async()=>{
  const f=await canonicalFixture();await f.approve();f.write();f.finish();await f.reconciler.reconcile(f.review.id)
  const db=new Database(f.path)
  db.query('UPDATE approved_plans SET plan_json=?').run('{broken')
  expect(()=>f.approved.list(f.ctx('patient-a'),f.first.id,{limit:20})).toThrow();expect(()=>f.approved.legacy(f.ctx('patient-a'),f.first.id)).toThrow()
  db.query('UPDATE approved_plans SET plan_json=?').run(JSON.stringify(f.draft.artifact));db.query('UPDATE audit_log SET actor=?').run('forged-actor')
  expect(()=>f.approved.list(f.ctx('patient-a'),f.first.id,{limit:20})).toThrow();db.close()
})
