import { randomUUID } from 'node:crypto'
import type { Store } from '../../storage/database.ts'
import { DomainError,type RequestContext } from '../contracts/errors.ts'
import { withIdempotency } from '../contracts/idempotency.ts'
import { PlanService,currentPlanSource,authorizePlan } from '../plans/service.ts'
import type { DraftRow } from '../plans/contracts.ts'
import type { ReviewGateway } from './contracts.ts'
import { readReview,reviewRow,updateReview,reviewEvent } from './registry.ts'
export async function startReview(store:Store,plans:PlanService,gateway:ReviewGateway,ctx:RequestContext,draftId:string,input:unknown){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new DomainError('validation_failed')
  const draft=plans.read(ctx,draftId)
  const receipt=await withIdempotency(store,{principalId:ctx.principal.id,method:'POST',resourceKey:`/care-plan-drafts/${draftId}/reviews`,key:ctx.idempotencyKey??'',payload:{}},tx=>{
    authorizePlan(tx,ctx,draft.patientId)
    const row=tx.get<DraftRow>('SELECT * FROM care_plan_drafts WHERE id=?',[draftId])!;currentPlanSource(tx,row)
    if(row.state!=='DRAFT'||tx.get('SELECT id FROM review_jobs WHERE draft_id=?',[draftId]))throw new DomainError('version_conflict')
    const id=randomUUID(),now=new Date().toISOString()
    tx.run(`INSERT INTO review_jobs(id,draft_id,patient_id,session_id,started_by,state,version,created_at,updated_at) VALUES (?,?,?,?,?,'STARTING',1,?,?)`,[id,draftId,row.patient_id,`review:${id}:${randomUUID()}`,ctx.principal.id,now,now])
    reviewEvent(tx,reviewRow(tx,id),'snapshot');return{resourceId:id,status:202,data:{id}}
  })
  if(!receipt.replayed){
    const claimed=await store.transaction(tx=>{const row=reviewRow(tx,receipt.resourceId);return updateReview(tx,row,{dispatch_at:new Date().toISOString()})})
    let patch
    try{const handle=await gateway.start(JSON.stringify(draft.artifact),claimed.session_id);if(!handle.jobId)throw Error('missing_handle');patch={upstream_id:handle.jobId,state:'RUNNING' as const,upstream_status:handle.status}}
    catch{patch={state:'START_UNKNOWN' as const,failure_code:'outcome_unknown'}}
    await store.transaction(tx=>{const row=reviewRow(tx,claimed.id);updateReview(tx,row,patch)})
  }
  return{resource:readReview(store,ctx,receipt.resourceId),replayed:receipt.replayed}
}
