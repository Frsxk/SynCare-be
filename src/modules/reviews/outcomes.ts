import { canonicalPayloadHash } from '../contracts/idempotency.ts'
import { object,validDraft } from '../plans/contracts.ts'
export type ParsedOutcome={kind:'approved';approvedAt:string}|{kind:'revision';artifact:Record<string,any>;input:Record<string,unknown>}|{kind:'escalated'}|{kind:'invalid'}
export function normalizeReviewOutcome(text:string|null|undefined,draft:Record<string,any>,decision:{action_id:string;reviewer_note:string}|null):ParsedOutcome {
  try{
    const v:unknown=JSON.parse(text??'null');if(!object(v))return{kind:'invalid'}
    if(v.action==='approved'&&decision?.action_id==='approve'&&v.patient_id===draft.patient_id&&typeof v.approved_at==='string'&&Number.isFinite(Date.parse(v.approved_at)))return{kind:'approved',approvedAt:v.approved_at}
    if(v.action==='escalate_to_clinician'&&canonicalPayloadHash(v.plan_json)===canonicalPayloadHash(draft)&&(!decision||['escalate','fallback'].includes(decision.action_id)))return{kind:'escalated'}
    if(decision?.action_id==='request_changes'){
      const input={...draft.source_input,reviewer_note:decision.reviewer_note}
      if(validDraft(v,input))return{kind:'revision',artifact:v,input}
    }
  }catch{}
  return{kind:'invalid'}
}
