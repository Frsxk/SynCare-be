import {Database} from 'bun:sqlite'
import {canonicalPayloadHash} from '../contracts/idempotency.ts'
import {DomainError} from '../contracts/errors.ts'
import type {Store} from '../../storage/database.ts'
import {ApprovalEvidenceReader} from '../reviews/approval-evidence.ts'
import {reviewRow} from '../reviews/registry.ts'
import type {DraftRow} from '../plans/contracts.ts'
import type {DecisionRow} from '../reviews/contracts.ts'
import type {AnswerOutcome} from './contracts.ts'
export class QuestionGrounding {
  constructor(private readonly store:Store,private readonly path:string){}
  validate(patientId:string,answer:Extract<AnswerOutcome,{kind:'answer'}>){
    let db:Database|undefined
    try{
      db=new Database(this.path,{readonly:true,strict:true})
      const latest=db.query<{plan_json:string;approved_at:string},[string]>("SELECT plan_json,approved_at FROM approved_plans WHERE json_extract(plan_json,'$.patient_id')=? ORDER BY approved_at DESC,rowid DESC LIMIT 1").get(patientId)
      if(!latest)throw new DomainError('invalid_flow_output')
      const links=this.store.all<{review_id:string;draft_id:string;fingerprint:string}>('SELECT * FROM approval_links WHERE patient_id=? AND approved_at=?',[patientId,latest.approved_at])
      const proofs=links.map(link=>{
        const review=reviewRow(this.store,link.review_id),draft=this.store.get<DraftRow>('SELECT * FROM care_plan_drafts WHERE id=?',[link.draft_id])!,decision=this.store.get<DecisionRow>('SELECT * FROM review_decisions WHERE review_id=?',[review.id])
        const proof=new ApprovalEvidenceReader(this.path).match(review,draft,decision)
        return review.state==='APPROVED'&&proof?.fingerprint===link.fingerprint&&proof.planHash===canonicalPayloadHash(JSON.parse(latest.plan_json))?proof:null
      }).filter(p=>p!==null)
      if(proofs.length!==1)throw new DomainError('invalid_flow_output')
      const plan=proofs[0]!.plan,episode=plan.source_input.f1_scored_output.episode
      for(const citation of answer.citations.filter(c=>c.provenance==='approved_plan')){
        const [chunk,indexText]=citation.id.slice(patientId.length+1).split('#'),[field,position]=chunk!.split(':'),index=Number(indexText)-1
        const text=field==='plan_text'?plan.plan_text:field==='care_intensity'?plan.care_intensity?.[Number(position)]:field==='instruction'?episode.instructions?.[Number(position)]:episode.medications?.[Number(position)]
        if(typeof text!=='string'||text.trim().split(/(?<=[.!?])\s+/)[index]!==citation.quote)throw new DomainError('invalid_flow_output')
      }
    }catch(e){if(e instanceof DomainError)throw e;throw new DomainError('dependency_unavailable')}finally{db?.close()}
  }
}
