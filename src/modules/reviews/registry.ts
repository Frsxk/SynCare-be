import type { Store,Transaction } from '../../storage/database.ts'
import { DomainError,type RequestContext } from '../contracts/errors.ts'
import { authorizePlan } from '../plans/service.ts'
import type { ReviewRow,ReviewSnapshot,DecisionRow,ReviewState } from './contracts.ts'
export function snapshot(store:Store|Transaction,row:ReviewRow):ReviewSnapshot {
  const d=store.get<DecisionRow>('SELECT * FROM review_decisions WHERE review_id=? ORDER BY created_at DESC LIMIT 1',[row.id])
  return{id:row.id,patientId:row.patient_id,draftId:row.draft_id,state:row.state,version:row.version,upstreamStatus:row.upstream_status,gate:row.gate_json?JSON.parse(row.gate_json):null,
    decision:d?{actionId:d.action_id,actorId:d.actor_id,state:d.state,recordedAt:d.created_at}:null,revisedDraftId:row.revised_draft_id,failureCode:row.failure_code,createdAt:row.created_at,updatedAt:row.updated_at}
}
export function reviewRow(store:Store|Transaction,id:string){const row=store.get<ReviewRow>('SELECT * FROM review_jobs WHERE id=?',[id]);if(!row)throw new DomainError('not_found');return row}
export function readReview(store:Store,ctx:RequestContext,id:string){const row=reviewRow(store,id);authorizePlan(store,ctx,row.patient_id);if(!store.get('SELECT id FROM review_events WHERE review_id=? AND version=?',[id,row.version]))throw new DomainError('invalid_flow_output');return snapshot(store,row)}
export function reviewEvent(tx:Transaction,row:ReviewRow,kind='state'){
  tx.run('INSERT INTO review_events(review_id,version,kind,snapshot_json,created_at) VALUES (?,?,?,?,?)',[row.id,row.version,kind,JSON.stringify(snapshot(tx,row)),row.updated_at])
}
export function updateReview(tx:Transaction,row:ReviewRow,patch:Partial<Pick<ReviewRow,'state'|'upstream_id'|'upstream_status'|'gate_json'|'result_json'|'revised_draft_id'|'failure_code'|'dispatch_at'>>,kind='state'){
  const fields=Object.keys(patch) as (keyof typeof patch)[]
  if(!fields.length)return row
  tx.run(`UPDATE review_jobs SET ${fields.map(k=>`${k}=?`).join(',')},version=version+1,updated_at=? WHERE id=? AND version=?`,[...fields.map(k=>patch[k]??null),new Date().toISOString(),row.id,row.version])
  const next=reviewRow(tx,row.id);reviewEvent(tx,next,kind);return next
}
export const unknownState=(r:ReviewRow):ReviewState=>r.state==='DECISION_PENDING'||r.state==='DECISION_UNKNOWN'?'DECISION_UNKNOWN':r.upstream_id?'UNKNOWN':'START_UNKNOWN'
