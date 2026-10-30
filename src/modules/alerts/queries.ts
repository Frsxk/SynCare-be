import type { Store,Transaction } from '../../storage/database.ts'
import { DomainError,type RequestContext } from '../contracts/errors.ts'
import { CursorCodec,type Page,type PageInput } from '../contracts/pagination.ts'
import { assertPatientScope,currentIdentity,patientScope,requireCapability } from '../patients/service.ts'
import type { AlertRow,AlertSummary,AlertDetail,ActionRow,Timeline,AlertStatus,AlertSource } from './contracts.ts'
type Reader=Pick<Store,'get'|'all'>|Transaction
export function authorize(reader:Reader,ctx:RequestContext,patientId?:string){
  currentIdentity(reader,ctx.principal)
  if(ctx.principal.role==='nurse')requireCapability(reader,ctx.principal,'alert.manage')
  if(patientId)assertPatientScope(reader,ctx.principal,patientId)
}
function source(row:AlertRow):AlertSource {
  if(row.source_type==='F2'&&row.checkin_id&&row.attempt_id&&row.source_action==='escalate_immediately')
    return{type:'F2',reportId:row.checkin_id,attemptId:row.attempt_id,action:'escalate_immediately',reason:row.reason,reportedAt:row.reported_at,outcomeAt:row.source_at}
  if(row.source_type==='PATIENT_REQUEST'&&!row.checkin_id&&!row.attempt_id&&row.source_action==='request_immediate_help'&&row.requested_by)
    return{type:'PATIENT_REQUEST',requestId:row.id,action:'request_immediate_help',reason:row.reason,reportedAt:row.reported_at,outcomeAt:row.source_at}
  throw new DomainError('processing_failed')
}
function summary(reader:Reader,ctx:RequestContext,row:AlertRow):AlertSummary {
  const name=ctx.principal.role==='nurse'?reader.get<{profile_json:string}>('SELECT profile_json FROM patients WHERE id=?',[row.patient_id]):null
  const patientName=name?(JSON.parse(name.profile_json) as {displayName:string}).displayName:undefined
  return{id:row.id,patientId:row.patient_id,...(patientName?{patientName}:{}),source:source(row),
    urgency:'acute',status:row.status,version:row.version,acknowledgedAt:row.acknowledged_at,resolvedAt:row.resolved_at,createdAt:row.created_at,updatedAt:row.updated_at}
}
export class AlertQueries {
  constructor(private readonly store:Store,private readonly codec:CursorCodec){}
  read(ctx:RequestContext,id:string,page:PageInput={limit:20}):AlertDetail {
    if(!Number.isInteger(page.limit)||page.limit<1||page.limit>100)throw new DomainError('validation_failed')
    authorize(this.store,ctx)
    const row=this.store.get<AlertRow>('SELECT * FROM alerts WHERE id=?',[id])
    if(!row)throw new DomainError('not_found')
    authorize(this.store,ctx,row.patient_id)
    const scope=`alert-history:${ctx.principal.id}:${ctx.principal.role}:${id}`
    const boundary=page.cursor?this.codec.decode(scope,page.cursor):null
    if(boundary&&!/^[1-9]\d*$/.test(boundary.id))throw new DomainError('validation_failed')
    const rows=this.store.all<ActionRow>(`SELECT * FROM alert_actions WHERE alert_id=? ${boundary?'AND version<?':''} ORDER BY version DESC LIMIT ?`,[id,...(boundary?[Number(boundary.id)]:[]),page.limit+1])
    const entries=rows.slice(0,page.limit),last=entries.at(-1)
    if((!page.cursor&&entries[0]?.version!==row.version)||entries.some((entry,index)=>index>0&&entries[index-1]!.version!==entry.version+1))throw new DomainError('processing_failed')
    const timeline=entries.reverse().map((a):Timeline=>({id:a.id,version:a.version,status:a.to_status,recordedAt:a.recorded_at,patientSummary:a.patient_summary,
      ...(ctx.principal.role==='nurse'?{action:a.action,actorId:a.actor_id,occurredAt:a.occurred_at,actionType:a.action_type,internalNote:a.internal_note}:{})}))
    return{...summary(this.store,ctx,row),timeline,timelineNextCursor:rows.length>page.limit&&last?this.codec.encode(scope,{id:String(last.version),createdAt:last.recorded_at}):null}
  }
  list(ctx:RequestContext,patientId:string|undefined,page:PageInput,filter:'all'|'active'|AlertStatus='all',includePatientRequests=true):Page<AlertSummary>{
    if(!Number.isInteger(page.limit)||page.limit<1||page.limit>100)throw new DomainError('validation_failed')
    authorize(this.store,ctx,patientId)
    if(!patientId&&ctx.principal.role!=='nurse')throw new DomainError('forbidden')
    const scope=`alerts:${ctx.principal.id}:${ctx.principal.role}:${patientId??'assigned'}:${filter}${includePatientRequests?'':':legacy-f2'}`,allowed=patientScope(this.store,ctx.principal)
    const boundary=page.cursor?this.codec.decode(scope,page.cursor):null
    const where=filter==='all'?'':filter==='active'?"AND a.status!='RESOLVED'":'AND a.status=?'
    const rows=this.store.all<AlertRow>(`SELECT a.* FROM alerts a WHERE a.patient_id IN (SELECT id FROM patients WHERE ${allowed.sql}) ${patientId?'AND a.patient_id=?':''} ${includePatientRequests?'':"AND a.source_type='F2'"} ${where}
      ${boundary?'AND (julianday(a.created_at)<julianday(?) OR (julianday(a.created_at)=julianday(?) AND a.id<?))':''} ORDER BY julianday(a.created_at) DESC,a.id DESC LIMIT ?`,
      [...allowed.bindings,...(patientId?[patientId]:[]),...(!['all','active'].includes(filter)?[filter]:[]),...(boundary?[boundary.createdAt,boundary.createdAt,boundary.id]:[]),page.limit+1])
    const items=rows.slice(0,page.limit),last=items.at(-1)
    return{items:items.map(row=>summary(this.store,ctx,row)),nextCursor:rows.length>page.limit&&last?this.codec.encode(scope,{id:last.id,createdAt:last.created_at}):null}
  }
}
