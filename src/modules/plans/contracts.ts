import { DomainError } from '../contracts/errors.ts'
import { canonicalPayloadHash } from '../contracts/idempotency.ts'
export const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)
export const text=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()
export interface DraftArtifact {id:string;patientId:string;assessmentId:string;confirmationId:string;parentDraftId:string|null;sourceReviewId:string|null;state:'RUNNING'|'DRAFT'|'INVALID'|'FAILED'|'UNKNOWN';version:number;input:Record<string,unknown>;artifact:Record<string,any>|null;fingerprint:string|null;failureCode:string|null;createdAt:string;updatedAt:string}
export interface DraftRow {id:string;patient_id:string;assessment_id:string;confirmation_id:string;parent_draft_id:string|null;source_review_id:string|null;requested_by:string;input_json:string;input_hash:string;artifact_json:string|null;artifact_hash:string|null;state:DraftArtifact['state'];version:number;failure_code:string|null;created_at:string;updated_at:string}
export const projectDraft=(r:DraftRow):DraftArtifact=>({id:r.id,patientId:r.patient_id,assessmentId:r.assessment_id,confirmationId:r.confirmation_id,parentDraftId:r.parent_draft_id,sourceReviewId:r.source_review_id,state:r.state,version:r.version,input:JSON.parse(r.input_json),artifact:r.artifact_json?JSON.parse(r.artifact_json):null,fingerprint:r.artifact_hash,failureCode:r.failure_code,createdAt:r.created_at,updatedAt:r.updated_at})
export function validDraft(value:unknown,input:Record<string,unknown>):value is Record<string,any>{
  try{return object(value)&&Object.keys(value).every(k=>['plan_text','satuseshat','patient_id','tier','care_intensity','status','label','missing_facts','disclaimer','source_input'].includes(k))&&value.patient_id===input.patient_id&&value.status==='DRAFT pending human approval'&&value.label==='demo-heuristic-v1'
    &&text(value.plan_text)&&text(value.disclaimer)&&['LOW','MEDIUM','HIGH'].includes(value.tier)&&value.tier===(input.f1_scored_output as Record<string,unknown>)?.tier
    &&Array.isArray(value.missing_facts)&&value.missing_facts.length===0&&Array.isArray(value.care_intensity)&&value.care_intensity.every(text)
    &&object(value.satuseshat)&&object(value.satuseshat.careplan)&&Array.isArray(value.satuseshat.careplan.activity)&&value.satuseshat.careplan.activity.every(text)
    &&object(value.satuseshat.servicerequest)&&text(value.satuseshat.servicerequest.patientInstruction)&&Array.isArray(value.satuseshat.task)&&value.satuseshat.task.every((v:unknown)=>object(v)&&text(v.code)&&text(v.status)&&text(v.priority))
    &&object(value.source_input)&&canonicalPayloadHash(value.source_input)===canonicalPayloadHash(input)}catch{return false}
}
export function draftInput(value:unknown):{assessmentId:string;followupDate:string;hotline:string}{
  if(!object(value)||Object.keys(value).length!==3||!['assessmentId','followupDate','hotline'].every(k=>text(value[k]))||value.assessmentId.length>128||value.hotline.length>400
    ||!/^\d{4}-\d{2}-\d{2}$/.test(value.followupDate)||!Number.isFinite(Date.parse(value.followupDate))||new Date(value.followupDate).toISOString().slice(0,10)!==value.followupDate)throw new DomainError('validation_failed')
  return value as {assessmentId:string;followupDate:string;hotline:string}
}
