import { DomainError } from '../contracts/errors.ts'
import { object,text } from '../plans/contracts.ts'
export type ReviewState='STARTING'|'START_UNKNOWN'|'RUNNING'|'WAITING_FOR_HUMAN'|'DECISION_PENDING'|'DECISION_UNKNOWN'|'REVISION_DRAFT'|'APPROVED'|'ESCALATED'|'FAILED'|'EXPIRED'|'UNKNOWN'|'INVALID'
export interface Gate {requestId:string;options:{actionId:string;label:string}[]}
export interface ReviewRow {id:string;draft_id:string;patient_id:string;session_id:string;upstream_id:string|null;started_by:string;state:ReviewState;version:number;upstream_status:string|null;gate_json:string|null;result_json:string|null;revised_draft_id:string|null;failure_code:string|null;dispatch_at:string|null;created_at:string;updated_at:string}
export interface DecisionRow {id:string;review_id:string;request_id:string;actor_id:string;action_id:string;reviewer_note:string;expected_version:number;state:'CLAIMED'|'SENT'|'UNKNOWN'|'CONFIRMED';created_at:string;updated_at:string}
export interface ReviewSnapshot {id:string;patientId:string;draftId:string;state:ReviewState;version:number;upstreamStatus:string|null;gate:Gate|null;decision:{actionId:string;actorId:string;state:DecisionRow['state'];recordedAt:string}|null;revisedDraftId:string|null;failureCode:string|null;createdAt:string;updatedAt:string}
export interface UpstreamSnapshot {status:string;gate?:Gate|null;gatePlan?:unknown;output?:string|null;sessionId?:string|null}
export interface ReviewGateway {start(draft:string,sessionId:string):Promise<{jobId:string;status:string}>;snapshot(jobId:string,sessionId:string):Promise<UpstreamSnapshot>;discover?(sessionId:string,planHash:string):Promise<string|null>;resume(jobId:string,requestId:string,actionId:string,actorId:string,note:string):Promise<unknown>}
export const terminal=(state:ReviewState)=>['APPROVED','REVISION_DRAFT','ESCALATED','FAILED','EXPIRED','INVALID'].includes(state)
export function parseDecision(v:unknown):{expectedVersion:number;requestId:string;actionId:string;reviewerNote?:string}{
  if(!object(v)||Object.keys(v).some(k=>!['expectedVersion','requestId','actionId','reviewerNote'].includes(k))||!Number.isSafeInteger(v.expectedVersion)||v.expectedVersion<1
    ||!text(v.requestId)||v.requestId.length>256||!text(v.actionId)||v.actionId.length>128||('reviewerNote'in v&&(typeof v.reviewerNote!=='string'||v.reviewerNote.length>4000)))throw new DomainError('validation_failed')
  return v as {expectedVersion:number;requestId:string;actionId:string;reviewerNote?:string}
}
