import { randomUUID } from 'node:crypto'
import type { Store } from '../../storage/database.ts'
import { DomainError,type RequestContext } from '../contracts/errors.ts'
import { withIdempotency } from '../contracts/idempotency.ts'
import { requireCapability,assertPatientScope,currentIdentity } from '../patients/service.ts'
import { parseAction,parseEmergencyRequest,type AlertRow,type AlertStatus } from './contracts.ts'
import { authorize,AlertQueries } from './queries.ts'
import type { CursorCodec } from '../contracts/pagination.ts'
import { followupStatus } from './followup.ts'
export class AlertService extends AlertQueries {
  constructor(private readonly state:Store,options:{codec:CursorCodec;clock?:()=>Date}){super(state,options.codec);this.clock=options.clock??(()=>new Date())}
  private readonly clock:()=>Date
  async requestEmergency(ctx:RequestContext,patientId:string,input:unknown){
    const body=parseEmergencyRequest(input)
    const identity=currentIdentity(this.state,ctx.principal)
    if(identity.role!=='patient')throw new DomainError('forbidden')
    assertPatientScope(this.state,ctx.principal,patientId)
    let id=''
    const saved=await withIdempotency(this.state,{principalId:ctx.principal.id,method:'POST',resourceKey:`/patients/${patientId}/emergencies`,key:ctx.idempotencyKey??'',payload:body},tx=>{
      currentIdentity(tx,ctx.principal)
      assertPatientScope(tx,ctx.principal,patientId)
      const now=this.clock().toISOString();id=randomUUID()
      tx.run(`INSERT INTO alerts(id,patient_id,checkin_id,attempt_id,source_type,source_action,reason,reported_at,source_at,status,version,acknowledged_at,resolved_at,created_at,updated_at,request_origin,requested_by)
        VALUES (?,?,NULL,NULL,'PATIENT_REQUEST','request_immediate_help',?,?,?,'PENDING_REVIEW',1,NULL,NULL,?,?,'patient_status_page',?)`,
        [id,patientId,body.reason,now,now,now,now,ctx.principal.id])
      tx.run("INSERT INTO alert_actions VALUES (?,?,1,'created',NULL,'PENDING_REVIEW',NULL,?,?,NULL,NULL,NULL)",[randomUUID(),id,now,now])
      tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)',[randomUUID(),ctx.principal.id,'alert.requested_immediate_help','alert',id,now,
        JSON.stringify({sourceType:'PATIENT_REQUEST'})])
      return{resourceId:id,status:201,data:{id}}
    })
    return{resource:this.read(ctx,saved.resourceId),replayed:saved.replayed}
  }
  async act(ctx:RequestContext,id:string,input:unknown){
    const body=parseAction(input)
    requireCapability(this.state,ctx.principal,'alert.manage');this.read(ctx,id)
    const result=await withIdempotency(this.state,{principalId:ctx.principal.id,method:'POST',resourceKey:`/alerts/${id}/actions`,key:ctx.idempotencyKey??'',payload:body},tx=>{
      const row=tx.get<AlertRow>('SELECT * FROM alerts WHERE id=?',[id]);if(!row)throw new DomainError('not_found')
      authorize(tx,ctx,row.patient_id)
      if(row.version!==body.expectedVersion)throw new DomainError('version_conflict',{resourceId:id,currentVersion:row.version})
      const now=this.clock().toISOString(),version=row.version+1
      let status:AlertStatus
      if(body.action==='acknowledge'){if(row.status!=='PENDING_REVIEW')throw new DomainError('version_conflict',{resourceId:id,currentVersion:row.version});status='ACKNOWLEDGED'}
      else status=followupStatus(row,body,now)
      if(body.action==='resolve'&&!tx.get("SELECT id FROM alert_actions WHERE alert_id=? AND action='follow_up' LIMIT 1",[id]))throw new DomainError('version_conflict',{resourceId:id,currentVersion:row.version})
      tx.run('UPDATE alerts SET status=?,version=?,updated_at=?,acknowledged_at=?,resolved_at=? WHERE id=? AND version=?',
        [status,version,now,body.action==='acknowledge'?now:row.acknowledged_at,body.action==='resolve'?now:null,id,row.version])
      tx.run('INSERT INTO alert_actions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',[randomUUID(),id,version,body.action,row.status,status,ctx.principal.id,now,
        body.action==='follow_up'?body.occurredAt:now,body.action==='follow_up'?body.actionType:null,body.note??null,'patientSummary'in body?body.patientSummary??null:null])
      tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)',[randomUUID(),ctx.principal.id,`alert.${body.action}`,'alert',id,now,JSON.stringify({version})])
      return{resourceId:id,status:200,data:{id}}
    })
    return{resource:this.read(ctx,id),replayed:result.replayed}
  }
}
