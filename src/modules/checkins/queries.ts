import type { Store } from '../../storage/database.ts'
import { DomainError, type RequestContext } from '../contracts/errors.ts'
import { CursorCodec,seekBoundary,type Page,type PageInput } from '../contracts/pagination.ts'
import { assertPatientScope } from '../patients/service.ts'
import type { CheckinRecord,ProcessingState } from './contracts.ts'
import type { F2Outcome } from '../workflows/flow-gateway.ts'
import { monitoringRows,type MonitoringRow } from './monitoring.ts'

interface Row {
  id:string;patient_id:string;message:string;submitted_by:string;created_at:string;version:number
  baseline_assessment_id:string|null;baseline_confirmation_id:string|null;baseline_score:number|null
  attempt_id:string;state:ProcessingState;attempt_version:number;updated_at:string;failure_code:string|null;output_json:string|null
  discharge_id:string|null;source_version:number|null;applicable:number;alert_queued:number
}
const selection=`SELECT c.*,p.id attempt_id,p.state,p.version attempt_version,p.updated_at,p.failure_code,p.output_json,
  a.discharge_id,a.source_version,CASE WHEN a.discharge_id=h.current_discharge_id THEN 1 ELSE 0 END applicable,
  EXISTS(SELECT 1 FROM work_items w WHERE w.kind='ALERT_F2' AND w.source_key=c.id) alert_queued
  FROM checkins c JOIN processing_attempts p ON p.checkin_id=c.id LEFT JOIN assessments a ON a.id=c.baseline_assessment_id
  LEFT JOIN patient_episode_heads h ON h.patient_id=c.patient_id`
function project(row:Row):CheckinRecord {
  const outcome=row.output_json?JSON.parse(row.output_json) as F2Outcome:null
  return{id:row.id,patientId:row.patient_id,message:row.message,submittedBy:row.submitted_by,createdAt:row.created_at,version:row.version,
    baseline:row.baseline_assessment_id?{assessmentId:row.baseline_assessment_id,confirmationId:row.baseline_confirmation_id!,score:row.baseline_score!,
      dischargeId:row.discharge_id!,sourceVersion:row.source_version!,applicable:row.applicable===1}:null,
    processing:{id:row.attempt_id,state:row.state,version:row.attempt_version,updatedAt:row.updated_at,failureCode:row.failure_code},outcome,
    alertEvidence:outcome?.action==='escalate_immediately'?(row.alert_queued?'queued':'unavailable'):'not_applicable'}
}
export function storedCheckin(store:Store,id:string):CheckinRecord|null {
  const row=store.get<Row>(`${selection} WHERE c.id=?`,[id])
  return row?project(row):null
}
export function latestCheckin(store:Store,ctx:RequestContext,patientId:string):CheckinRecord|null {
  assertPatientScope(store,ctx.principal,patientId)
  const row=store.get<Row>(`${selection} WHERE c.patient_id=? ORDER BY julianday(c.created_at) DESC,c.id DESC LIMIT 1`,[patientId])
  return row?project(row):null
}
export class CheckinQueries {
  constructor(private readonly store:Store,private readonly codec:CursorCodec){}
  read(ctx:RequestContext,id:string):CheckinRecord {
    const row=this.store.get<Row>(`${selection} WHERE c.id=?`,[id])
    if(!row)throw new DomainError('not_found')
    assertPatientScope(this.store,ctx.principal,row.patient_id)
    return project(row)
  }
  latest(ctx:RequestContext,patientId:string):CheckinRecord|null {
    return latestCheckin(this.store,ctx,patientId)
  }
  list(ctx:RequestContext,patientId:string,input:PageInput):Page<CheckinRecord>{
    assertPatientScope(this.store,ctx.principal,patientId)
    if(!Number.isInteger(input.limit)||input.limit<1||input.limit>100)throw new DomainError('validation_failed')
    const scope=`${ctx.principal.id}:checkins:${patientId}`,boundary=input.cursor?seekBoundary(this.codec.decode(scope,input.cursor)):null
    const where=boundary?.sql.replace(/\bcreated_at\b/g,'c.created_at').replace(/\bid\b/g,'c.id')
    const rows=this.store.all<Row>(`${selection} WHERE c.patient_id=?${where?` AND ${where}`:''} ORDER BY julianday(c.created_at) DESC,c.id DESC LIMIT ?`,
      [patientId,...(boundary?.bindings??[]),input.limit+1])
    const items=rows.slice(0,input.limit).map(project),last=items.at(-1)
    return{items,nextCursor:rows.length>input.limit&&last?this.codec.encode(scope,last):null}
  }
  monitoring(ctx:RequestContext,input:PageInput):Page<MonitoringRow>{
    return monitoringRows(this.store,this.codec,ctx,input,id=>this.latest(ctx,id))
  }
}
