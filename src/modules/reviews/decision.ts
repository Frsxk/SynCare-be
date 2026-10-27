import { randomUUID } from 'node:crypto'
import type { Store } from '../../storage/database.ts'
import type { RequestContext } from '../contracts/errors.ts'
import { DomainError } from '../contracts/errors.ts'
import { withIdempotency } from '../contracts/idempotency.ts'
import { authorizePlan,currentPlanSource } from '../plans/service.ts'
import type { DraftRow } from '../plans/contracts.ts'
import { parseDecision,type ReviewGateway,type Gate } from './contracts.ts'
import { readReview,reviewRow,updateReview } from './registry.ts'
export async function decideReview(store:Store,gateway:ReviewGateway,ctx:RequestContext,id:string,input:unknown){
  const body=parseDecision(input);readReview(store,ctx,id)
  const receipt=await withIdempotency(store,{principalId:ctx.principal.id,method:'POST',resourceKey:`/reviews/${id}/decisions`,key:ctx.idempotencyKey??'',payload:body},tx=>{
    const row=reviewRow(tx,id);authorizePlan(tx,ctx,row.patient_id)
    if(row.state!=='WAITING_FOR_HUMAN'||row.version!==body.expectedVersion||!row.upstream_id||!row.gate_json)throw new DomainError('version_conflict',{resourceId:id,currentVersion:row.version})
    currentPlanSource(tx,tx.get<DraftRow>('SELECT * FROM care_plan_drafts WHERE id=?',[row.draft_id])!)
    const gate=JSON.parse(row.gate_json) as Gate
    if(gate.requestId!==body.requestId||!gate.options.some(o=>o.actionId===body.actionId))throw new DomainError('version_conflict',{resourceId:id,currentVersion:row.version})
    const decisionId=randomUUID(),now=new Date().toISOString()
    tx.run(`INSERT INTO review_decisions VALUES (?,?,?,?,?,?,?,'CLAIMED',?,?)`,[decisionId,id,body.requestId,ctx.principal.id,body.actionId,body.reviewerNote??'',body.expectedVersion,now,now])
    updateReview(tx,row,{state:'DECISION_PENDING'});return{resourceId:id,status:202,data:{decisionId}}
  })
  if(!receipt.replayed){
    const row=reviewRow(store,id)
    let state='SENT'
    try{await gateway.resume(row.upstream_id!,body.requestId,body.actionId,ctx.principal.id,body.reviewerNote??'')}catch{state='UNKNOWN'}
    await store.transaction(tx=>{
      const current=reviewRow(tx,id)
      tx.run("UPDATE review_decisions SET state=?,updated_at=? WHERE review_id=? AND request_id=? AND state='CLAIMED'",[state,new Date().toISOString(),id,body.requestId])
      if(current.state==='DECISION_PENDING')updateReview(tx,current,{state:state==='UNKNOWN'?'DECISION_UNKNOWN':'DECISION_PENDING',failure_code:state==='UNKNOWN'?'outcome_unknown':null})
    })
  }
  return{resource:readReview(store,ctx,id),replayed:receipt.replayed}
}
