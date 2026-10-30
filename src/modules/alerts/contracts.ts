import { DomainError } from '../contracts/errors.ts'
export const alertStatuses=['PENDING_REVIEW','ACKNOWLEDGED','IN_PROGRESS','RESOLVED'] as const
export type AlertStatus=typeof alertStatuses[number]
export const actionTypes=['contact_attempt','evaluation_guidance','homecare_review','other'] as const
export type ActionType=typeof actionTypes[number]
export const EMERGENCY_REASON_MAX=8000
export interface AlertRow {id:string;patient_id:string;checkin_id:string|null;attempt_id:string|null;source_type:'F2'|'PATIENT_REQUEST';source_action:'escalate_immediately'|'request_immediate_help';reason:string;reported_at:string;source_at:string;status:AlertStatus;version:number;acknowledged_at:string|null;resolved_at:string|null;created_at:string;updated_at:string;request_origin:string|null;requested_by:string|null}
export interface ActionRow {id:string;alert_id:string;version:number;action:'created'|'acknowledge'|'follow_up'|'resolve';from_status:AlertStatus|null;to_status:AlertStatus;actor_id:string|null;recorded_at:string;occurred_at:string;action_type:ActionType|null;internal_note:string|null;patient_summary:string|null}
export interface AlertSourceF2 {type:'F2';reportId:string;attemptId:string;action:'escalate_immediately';reason:string;reportedAt:string;outcomeAt:string}
export interface AlertSourcePatientRequest {type:'PATIENT_REQUEST';requestId:string;action:'request_immediate_help';reason:string;reportedAt:string;outcomeAt:string}
export type AlertSource=AlertSourceF2|AlertSourcePatientRequest
export interface AlertSummary {id:string;patientId:string;patientName?:string;source:AlertSource;urgency:'acute';status:AlertStatus;version:number;acknowledgedAt:string|null;resolvedAt:string|null;createdAt:string;updatedAt:string}
export interface Timeline {id:string;version:number;status:AlertStatus;recordedAt:string;patientSummary:string|null;action?:ActionRow['action'];actorId?:string|null;occurredAt?:string;actionType?:ActionType|null;internalNote?:string|null}
export interface AlertDetail extends AlertSummary {timeline:Timeline[];timelineNextCursor:string|null}
export type AlertAction={action:'acknowledge';expectedVersion:number;note?:string}|{action:'follow_up';expectedVersion:number;note:string;patientSummary?:string;actionType:ActionType;occurredAt:string}|{action:'resolve';expectedVersion:number;note:string;patientSummary?:string}
export function parseAction(input:unknown):AlertAction {
  const fail=()=>{throw new DomainError('validation_failed')}
  if(!input||typeof input!=='object'||Array.isArray(input))return fail()
  const b=input as Record<string,unknown>,action=b.action
  if(!['acknowledge','follow_up','resolve'].includes(action as string)||!Number.isSafeInteger(b.expectedVersion)||Number(b.expectedVersion)<1)return fail()
  const keys=action==='acknowledge'?['action','expectedVersion','note']:action==='follow_up'?['action','expectedVersion','note','patientSummary','actionType','occurredAt']:['action','expectedVersion','note','patientSummary']
  if(Object.keys(b).some(key=>!keys.includes(key)))return fail()
  const text=(value:unknown)=>typeof value==='string'&&!!value.trim()&&[...value].length<=4000
  if((action!=='acknowledge'&&!text(b.note))||('note'in b&&!text(b.note))||('patientSummary'in b&&!text(b.patientSummary)))return fail()
  if(action==='follow_up'&&(!actionTypes.includes(b.actionType as ActionType)||typeof b.occurredAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(b.occurredAt)||!Number.isFinite(Date.parse(b.occurredAt))||new Date(b.occurredAt).toISOString()!==b.occurredAt))return fail()
  return b as unknown as AlertAction
}
export interface EmergencyRequest {reason:string}
export function parseEmergencyRequest(input:unknown):EmergencyRequest {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new DomainError('validation_failed')
  const body=input as Record<string,unknown>
  if(Object.keys(body).length!==1||!Object.hasOwn(body,'reason')||typeof body.reason!=='string')throw new DomainError('validation_failed')
  const reason=body.reason.trim()
  if(!reason||[...reason].length>EMERGENCY_REASON_MAX)throw new DomainError('validation_failed')
  return{reason}
}
export function parseAlertFilter(input:unknown):'active'|'all'|AlertStatus {
  if(input===undefined||input==='all')return'all'
  if(input==='active'||alertStatuses.includes(input as AlertStatus))return input as 'active'|AlertStatus
  throw new DomainError('validation_failed')
}
