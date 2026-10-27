import { randomUUID } from 'node:crypto'
import type { Store,Transaction } from '../../storage/database.ts'
import type { FlowRunResult } from '../../plugins/langflow.ts'
import { DomainError,type RequestContext } from '../contracts/errors.ts'
import { withIdempotency,canonicalPayloadHash } from '../contracts/idempotency.ts'
import { assertPatientScope,requireCapability } from '../patients/service.ts'
import { validF1,type AssessmentRow } from '../assessments/service.ts'
import { draftInput,projectDraft,validDraft,type DraftRow } from './contracts.ts'
export function authorizePlan(store:Store|Transaction,ctx:RequestContext,patientId:string){requireCapability(store,ctx.principal,'review.decide');assertPatientScope(store,ctx.principal,patientId)}
export function currentPlanSource(store:Store|Transaction,row:Pick<DraftRow,'patient_id'|'assessment_id'|'confirmation_id'>){
  const assessment=store.get<AssessmentRow>(`SELECT a.* FROM assessments a JOIN risk_confirmations c ON c.assessment_id=a.id JOIN patient_episode_heads h ON h.current_discharge_id=a.discharge_id WHERE a.id=? AND c.id=? AND a.patient_id=? AND a.state='SUCCEEDED'`,[row.assessment_id,row.confirmation_id,row.patient_id])
  if(!assessment||!validF1(assessment.output_json))throw new DomainError('version_conflict')
  return assessment
}
export class PlanService {
  constructor(readonly store:Store,private readonly runF3:(input:string,sessionId:string)=>Promise<FlowRunResult>){}
  read(ctx:RequestContext,id:string){const row=this.store.get<DraftRow>('SELECT * FROM care_plan_drafts WHERE id=?',[id]);if(!row)throw new DomainError('not_found');authorizePlan(this.store,ctx,row.patient_id);return projectDraft(row)}
  async draft(ctx:RequestContext,patientId:string,input:unknown){
    const body=draftInput(input);authorizePlan(this.store,ctx,patientId)
    const receipt=await withIdempotency(this.store,{principalId:ctx.principal.id,method:'POST',resourceKey:`/patients/${patientId}/care-plan-drafts`,key:ctx.idempotencyKey??'',payload:body},tx=>{
      authorizePlan(tx,ctx,patientId)
      const a=tx.get<AssessmentRow>('SELECT * FROM assessments WHERE id=? AND patient_id=?',[body.assessmentId,patientId])
      const c=tx.get<{id:string}>('SELECT id FROM risk_confirmations WHERE assessment_id=?',[body.assessmentId])
      if(!a||!c)throw new DomainError('validation_failed')
      currentPlanSource(tx,{patient_id:patientId,assessment_id:a.id,confirmation_id:c.id})
      const source={patient_id:patientId,f1_scored_output:JSON.parse(a.output_json!),followup_date:body.followupDate,hotline:body.hotline},id=randomUUID(),now=new Date().toISOString()
      tx.run(`INSERT INTO care_plan_drafts(id,patient_id,assessment_id,confirmation_id,requested_by,input_json,input_hash,state,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'RUNNING',1,?,?)`,[id,patientId,a.id,c.id,ctx.principal.id,JSON.stringify(source),canonicalPayloadHash(source),now,now])
      return{resourceId:id,status:202,data:{id}}
    })
    if(!receipt.replayed){
      const row=this.store.get<DraftRow>('SELECT * FROM care_plan_drafts WHERE id=?',[receipt.resourceId])!
      let state='INVALID',artifact:Record<string,unknown>|null=null,failure:string|null='invalid_flow_output'
      try{const result=await this.runF3(row.input_json,`draft:${row.id}`),value=JSON.parse(result.outputText??'null');if(validDraft(value,JSON.parse(row.input_json))){artifact=value;state='DRAFT';failure=null}}
      catch{state='UNKNOWN';failure='outcome_unknown'}
      await this.store.transaction(tx=>tx.run('UPDATE care_plan_drafts SET state=?,version=2,artifact_json=?,artifact_hash=?,failure_code=?,updated_at=? WHERE id=? AND state=?',[state,artifact?JSON.stringify(artifact):null,artifact?canonicalPayloadHash(artifact):null,failure,new Date().toISOString(),row.id,'RUNNING']))
    }
    return{resource:this.read(ctx,receipt.resourceId),replayed:receipt.replayed}
  }
}
