import type { Store } from '../../storage/database.ts'
import { DomainError,type RequestContext } from '../contracts/errors.ts'
import { CursorCodec,seekBoundary,type PageInput } from '../contracts/pagination.ts'
import { assertPatientScope,patientScope } from '../patients/service.ts'
import { authorizePlan } from './service.ts'
import type { DraftRow } from './contracts.ts'
import { ApprovalEvidenceReader } from '../reviews/approval-evidence.ts'
import { reviewRow } from '../reviews/registry.ts'
import type { DecisionRow } from '../reviews/contracts.ts'
export class ApprovedPlans {
  constructor(private readonly store:Store,private readonly evidence:ApprovalEvidenceReader,private readonly codec:CursorCodec){}
  legacy(ctx:RequestContext,patientId?:string){
    if(patientId)assertPatientScope(this.store,ctx.principal,patientId)
    const scope=patientScope(this.store,ctx.principal)
    const links=this.store.all<{review_id:string;draft_id:string;patient_id:string;fingerprint:string}>(`SELECT * FROM approval_links WHERE patient_id IN (SELECT id FROM patients WHERE ${scope.sql})${patientId?' AND patient_id=?':''} ORDER BY julianday(approved_at) DESC,id DESC`,[...scope.bindings,...(patientId?[patientId]:[])])
    const plans=[],audit=[]
    for(const link of links){
      const review=reviewRow(this.store,link.review_id),draft=this.store.get<DraftRow>('SELECT * FROM care_plan_drafts WHERE id=?',[link.draft_id])!,decision=this.store.get<DecisionRow>('SELECT * FROM review_decisions WHERE review_id=?',[review.id])
      const proof=this.evidence.match(review,draft,decision)
      if(!proof||proof.fingerprint!==link.fingerprint||review.state!=='APPROVED')throw new DomainError('invalid_flow_output')
      const {source_input,...safePlan}=proof.plan,plan=ctx.principal.role==='patient'?safePlan:proof.plan
      plans.push({plan_json:JSON.stringify(plan),approved_at:proof.approvedAt,reviewer_note:ctx.principal.role==='patient'?'':decision!.reviewer_note,plan,isApproved:true,patientId:link.patient_id})
      if(ctx.principal.role==='nurse'){const data={plan_json:plan};audit.push({action:'Approve',actor:decision!.actor_id,timestamp:proof.approvedAt,payload:JSON.stringify(data),data,patientId:link.patient_id})}
    }
    return{plans,audit}
  }
  list(ctx:RequestContext,patientId:string,input:PageInput){
    if(ctx.principal.role==='nurse')authorizePlan(this.store,ctx,patientId);else assertPatientScope(this.store,ctx.principal,patientId)
    this.evidence.assertAvailable()
    const namespace=`${ctx.principal.id}:approved:${patientId}`,boundary=input.cursor?seekBoundary(this.codec.decode(namespace,input.cursor)):null
    const rows=this.store.all<{id:string;review_id:string;draft_id:string;fingerprint:string;created_at:string}>(`SELECT * FROM approval_links WHERE patient_id=?${boundary?` AND ${boundary.sql}`:''} ORDER BY julianday(created_at) DESC,id DESC LIMIT ?`,[patientId,...(boundary?.bindings??[]),input.limit+1])
    const items=rows.slice(0,input.limit).map(link=>{
      const review=reviewRow(this.store,link.review_id),draft=this.store.get<DraftRow>('SELECT * FROM care_plan_drafts WHERE id=?',[link.draft_id])!,decision=this.store.get<DecisionRow>('SELECT * FROM review_decisions WHERE review_id=?',[review.id])
      const proof=this.evidence.match(review,draft,decision)
      if(!proof||proof.fingerprint!==link.fingerprint||review.state!=='APPROVED')throw new DomainError('invalid_flow_output')
      const {source_input,...plan}=proof.plan
      const a=this.store.get<{discharge_id:string;source_version:number}>('SELECT discharge_id,source_version FROM assessments WHERE id=?',[draft.assessment_id])!
      const applicable=!!this.store.get('SELECT patient_id FROM patient_episode_heads WHERE patient_id=? AND current_discharge_id=?',[patientId,a.discharge_id])
      return{id:link.id,patientId,reviewId:review.id,approvedAt:proof.approvedAt,plan,source:{assessmentId:draft.assessment_id,dischargeId:a.discharge_id,sourceVersion:a.source_version,applicable},createdAt:link.created_at}
    })
    const last=rows[Math.min(rows.length,input.limit)-1]
    return{items,nextCursor:rows.length>input.limit&&last?this.codec.encode(namespace,{id:last.id,createdAt:last.created_at}):null}
  }
}
