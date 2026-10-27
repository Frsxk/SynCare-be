import { Database } from 'bun:sqlite'
import { realpathSync } from 'node:fs'
import { canonicalPayloadHash } from '../contracts/idempotency.ts'
import { DomainError } from '../contracts/errors.ts'
import type { DraftRow } from '../plans/contracts.ts'
import type { DecisionRow,ReviewRow } from './contracts.ts'
export interface ApprovalEvidence {fingerprint:string;planHash:string;approvedAt:string;plan:Record<string,any>}
export class ApprovalEvidenceReader {
  constructor(private readonly path:string){}
  assertAvailable(){let db:Database|undefined;try{db=new Database(realpathSync.native(this.path),{readonly:true,strict:true});db.query('SELECT plan_json,approved_at,reviewer_note FROM approved_plans LIMIT 0').all();db.query('SELECT action,actor,timestamp,payload FROM audit_log LIMIT 0').all()}catch{throw new DomainError('dependency_unavailable')}finally{db?.close()}}
  match(review:ReviewRow,draft:DraftRow,decision:DecisionRow|null):ApprovalEvidence|null{
    if(!decision||decision.action_id!=='approve'||!draft.artifact_json||!draft.artifact_hash||!review.gate_json)return null
    let db:Database|undefined
    try{
      const realPath=realpathSync.native(this.path);db=new Database(realPath,{readonly:true,strict:true})
      const audits=db.query<{rowid:number;action:string;actor:string;timestamp:string;payload:string},[string,string]>(`SELECT rowid,* FROM audit_log WHERE CASE WHEN json_valid(payload) THEN json_extract(payload,'$.request_id') END=? AND CASE WHEN json_valid(payload) THEN json_extract(payload,'$.session_id') END=?`).all(decision.request_id,review.session_id)
      if(!audits.length)return null
      if(audits.length!==1)throw new DomainError('invalid_flow_output')
      const a=audits[0]!,payload=JSON.parse(a.payload)
      if(a.action!=='Approve'||a.actor!==decision.actor_id||payload.decision?.action_id!=='approve'||payload.decision?.actor!==decision.actor_id||payload.decision?.reviewer_note!==decision.reviewer_note
        ||canonicalPayloadHash(payload.plan_json)!==draft.artifact_hash||!Number.isFinite(Date.parse(a.timestamp)))throw new DomainError('invalid_flow_output')
      const candidates=db.query<{rowid:number;plan_json:string;approved_at:string;reviewer_note:string},[string]>('SELECT rowid,* FROM approved_plans WHERE approved_at=?').all(a.timestamp)
      const matches=candidates.filter(p=>{try{return p.reviewer_note===decision.reviewer_note&&canonicalPayloadHash(JSON.parse(p.plan_json))===draft.artifact_hash}catch{return false}})
      if(matches.length!==1)throw new DomainError('invalid_flow_output')
      const plan=JSON.parse(matches[0]!.plan_json)
      if(plan.patient_id!==review.patient_id)throw new DomainError('invalid_flow_output')
      return{fingerprint:canonicalPayloadHash({path:process.platform==='win32'?realPath.toLowerCase():realPath,reviewId:review.id,requestId:decision.request_id,sessionId:review.session_id,auditRow:a.rowid,planRow:matches[0]!.rowid,planHash:draft.artifact_hash,timestamp:a.timestamp}),planHash:draft.artifact_hash,approvedAt:a.timestamp,plan}
    }catch(error){if(error instanceof DomainError)throw error;throw new DomainError('dependency_unavailable')}finally{db?.close()}
  }
}
