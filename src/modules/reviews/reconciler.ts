import { randomUUID } from 'node:crypto'
import type { Store } from '../../storage/database.ts'
import { canonicalPayloadHash } from '../contracts/idempotency.ts'
import { DomainError } from '../contracts/errors.ts'
import type { DraftRow } from '../plans/contracts.ts'
import type { ReviewGateway,ReviewRow,DecisionRow } from './contracts.ts'
import { terminal } from './contracts.ts'
import { reviewRow,updateReview,unknownState } from './registry.ts'
import { normalizeReviewOutcome } from './outcomes.ts'
import type { ApprovalEvidenceReader } from './approval-evidence.ts'
export class ReviewReconciler {
  private readonly active=new Set<string>()
  private afterId=''
  constructor(private readonly store:Store,private readonly gateway:ReviewGateway,private readonly evidence:ApprovalEvidenceReader){}
  async recover(){
    await this.store.transaction(tx=>{
      const now=new Date().toISOString()
      tx.run("UPDATE care_plan_drafts SET state='UNKNOWN',version=2,failure_code='outcome_unknown',updated_at=? WHERE state='RUNNING'",[now])
      for(const row of tx.all<ReviewRow>("SELECT * FROM review_jobs WHERE state='STARTING'"))updateReview(tx,row,{state:'START_UNKNOWN',failure_code:'outcome_unknown'})
      for(const row of tx.all<ReviewRow>("SELECT * FROM review_jobs WHERE state='DECISION_PENDING'")){
        tx.run("UPDATE review_decisions SET state='UNKNOWN',updated_at=? WHERE review_id=? AND state IN ('CLAIMED','SENT')",[now,row.id])
        updateReview(tx,row,{state:'DECISION_UNKNOWN',failure_code:'outcome_unknown'})
      }
    })
  }
  async tick(){
    const rows=this.store.all<ReviewRow>("SELECT * FROM review_jobs WHERE id>? AND (upstream_id IS NOT NULL OR state='START_UNKNOWN') AND state NOT IN ('APPROVED','REVISION_DRAFT','ESCALATED','FAILED','EXPIRED','INVALID') ORDER BY id LIMIT 20",[this.afterId])
    this.afterId=rows.at(-1)?.id??''
    for(const row of rows)await this.reconcile(row.id)
  }
  async reconcile(id:string){
    if(this.active.has(id))return
    let initial=reviewRow(this.store,id);if(terminal(initial.state))return
    this.active.add(id)
    try{
      if(!initial.upstream_id){
        if(initial.state!=='START_UNKNOWN'||!this.gateway.discover)return
        const draft=this.store.get<DraftRow>('SELECT * FROM care_plan_drafts WHERE id=?',[initial.draft_id])!
        const found=await this.gateway.discover(initial.session_id,draft.artifact_hash!)
        if(!found)return
        await this.store.transaction(tx=>{const current=reviewRow(tx,id);if(!current.upstream_id&&current.state==='START_UNKNOWN')updateReview(tx,current,{upstream_id:found,state:'RUNNING',failure_code:null})})
        initial=reviewRow(this.store,id)
      }
      if(!initial.upstream_id)return
      const remote=await this.gateway.snapshot(initial.upstream_id,initial.session_id)
      await this.store.transaction(tx=>{
        const row=reviewRow(tx,id);if(terminal(row.state))return
        const draft=tx.get<DraftRow>('SELECT * FROM care_plan_drafts WHERE id=?',[row.draft_id])!,artifact=JSON.parse(draft.artifact_json!)
        const decision=tx.get<DecisionRow>('SELECT * FROM review_decisions WHERE review_id=? ORDER BY created_at DESC LIMIT 1',[id])
        if(remote.status==='suspended'){
          if(decision){if(row.upstream_status!==remote.status)updateReview(tx,row,{upstream_status:remote.status});return}
          if(!remote.gate||canonicalPayloadHash(remote.gatePlan)!==draft.artifact_hash)throw new DomainError('outcome_unknown')
          const gate=JSON.stringify(remote.gate)
          if(row.state!=='WAITING_FOR_HUMAN'||row.gate_json!==gate||row.upstream_status!==remote.status)updateReview(tx,row,{state:'WAITING_FOR_HUMAN',gate_json:gate,upstream_status:remote.status,failure_code:null},'gate')
        }else if(remote.status==='completed'){
          const outcome=normalizeReviewOutcome(remote.output,artifact,decision)
          if(outcome.kind==='approved'){
            const proof=this.evidence.match(row,draft,decision)
            if(!proof||proof.approvedAt!==outcome.approvedAt)throw new DomainError('outcome_unknown')
            tx.run('INSERT INTO approval_links VALUES (?,?,?,?,?,?,?,?)',[randomUUID(),id,row.draft_id,row.patient_id,proof.fingerprint,proof.planHash,proof.approvedAt,new Date().toISOString()])
          }
          let revised:string|null=null
          if(outcome.kind==='revision'){
            revised=randomUUID();const now=new Date().toISOString()
            tx.run(`INSERT INTO care_plan_drafts(id,patient_id,assessment_id,confirmation_id,parent_draft_id,source_review_id,requested_by,input_json,input_hash,artifact_json,artifact_hash,state,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'DRAFT',1,?,?)`,[revised,row.patient_id,draft.assessment_id,draft.confirmation_id,draft.id,row.id,decision!.actor_id,JSON.stringify(outcome.input),canonicalPayloadHash(outcome.input),JSON.stringify(outcome.artifact),canonicalPayloadHash(outcome.artifact),now,now])
          }
          if(decision&&decision.state!=='CONFIRMED')tx.run("UPDATE review_decisions SET state='CONFIRMED',updated_at=? WHERE id=?",[new Date().toISOString(),decision.id])
          const states={approved:'APPROVED',revision:'REVISION_DRAFT',escalated:'ESCALATED',invalid:'INVALID'} as const
          updateReview(tx,row,{state:states[outcome.kind],upstream_status:remote.status,result_json:JSON.stringify({output:remote.output??null}),revised_draft_id:revised,failure_code:outcome.kind==='invalid'?'invalid_flow_output':null},'result')
        }else if(['failed','cancelled','timed_out'].includes(remote.status))updateReview(tx,row,{state:remote.status==='timed_out'?'EXPIRED':'FAILED',upstream_status:remote.status,failure_code:'processing_failed'},'error')
        else if(['queued','in_progress'].includes(remote.status)){
          const state=decision?row.state:'RUNNING'
          if(row.upstream_status!==remote.status||row.state!==state)updateReview(tx,row,{state,upstream_status:remote.status})
        }else throw new DomainError('outcome_unknown')
      })
    }catch(error){
      await this.store.transaction(tx=>{const row=reviewRow(tx,id);if(terminal(row.state))return
        const state=unknownState(row),failure=error instanceof DomainError?error.code:'dependency_unavailable'
        if(row.state!==state||row.failure_code!==failure)updateReview(tx,row,{state,failure_code:failure},'error')
      })
    }finally{this.active.delete(id)}
  }
}
