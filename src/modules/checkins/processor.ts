import { randomUUID } from 'node:crypto'
import type { Store,WorkItem } from '../../storage/database.ts'
import { LangflowTimeoutError,type FlowRunResult } from '../../plugins/langflow.ts'
import { validF2,type F2Context } from '../workflows/flow-gateway.ts'
import { enqueueWork,type ProcessingState } from './contracts.ts'
import { storedCheckin } from './queries.ts'
import { DomainError } from '../contracts/errors.ts'

interface PendingRow {id:string;patient_id:string;message:string;baseline_score:number;baseline_assessment_id:string;submitted_by:string;attempt_id:string;session_id:string;state:ProcessingState}
export class CheckinProcessor {
  private readonly clock:()=>Date
  constructor(private readonly store:Store,private readonly options:{runF2:(context:F2Context)=>Promise<FlowRunResult>;clock?:()=>Date}){this.clock=options.clock??(()=>new Date())}
  async recoverExpired(){
    const now=this.clock().toISOString()
    await this.store.transaction(tx=>{
      const expired=tx.all<{id:string;source_key:string}>("SELECT id,source_key FROM work_items WHERE kind='CHECKIN_F2' AND state='RUNNING' AND julianday(lease_expires_at)<=julianday(?)",[now])
      for(const work of expired){
        tx.run("UPDATE processing_attempts SET state='RUNNING',version=2,updated_at=? WHERE checkin_id=? AND state='PENDING'",[now,work.source_key])
        tx.run("UPDATE processing_attempts SET state='UNKNOWN',version=3,updated_at=?,failure_code='outcome_unknown' WHERE checkin_id=? AND state='RUNNING'",[now,work.source_key])
        const row=tx.get<{state:string}>("SELECT state FROM processing_attempts WHERE checkin_id=?",[work.source_key])
        tx.run("UPDATE work_items SET state=?,claim_token=NULL,updated_at=? WHERE id=? AND state='RUNNING'",[row?.state==='SUCCEEDED'?'SUCCEEDED':'UNKNOWN',now,work.id])
      }
    })
  }
  async process(checkinId:string,attemptId:string){
    const record=storedCheckin(this.store,checkinId)
    if(!record||record.processing.id!==attemptId)throw new DomainError('not_found')
    if(record.processing.state==='PENDING')await this.processNext({checkinId,attemptId})
    return storedCheckin(this.store,checkinId)!
  }
  private async claimSpecific(checkinId:string,attemptId:string):Promise<WorkItem|null>{
    const now=this.clock().toISOString(),leaseExpiresAt=new Date(this.clock().getTime()+120000).toISOString()
    return this.store.transaction(tx=>{
      const row=tx.get<{id:string;attempt_count:number}>(`SELECT w.id,w.attempt_count FROM work_items w JOIN processing_attempts a ON a.checkin_id=w.source_key
        WHERE w.kind='CHECKIN_F2' AND w.source_key=? AND a.id=? AND a.state='PENDING' AND w.state='PENDING' AND julianday(w.available_at)<=julianday(?)`,[checkinId,attemptId,now])
      if(!row)return null
      const claimToken=randomUUID()
      tx.run("UPDATE work_items SET state='RUNNING',claim_token=?,claimed_at=?,lease_expires_at=?,attempt_count=attempt_count+1,updated_at=? WHERE id=? AND state='PENDING'",
        [claimToken,now,leaseExpiresAt,now,row.id])
      return{id:row.id,kind:'CHECKIN_F2',sourceKey:checkinId,payload:{checkinId},state:'RUNNING',claimToken,leaseExpiresAt,attemptCount:row.attempt_count+1}
    })
  }
  async processNext(target?:{checkinId:string;attemptId:string}):Promise<boolean>{
    const work=target?await this.claimSpecific(target.checkinId,target.attemptId):await this.store.claimWork('CHECKIN_F2',this.clock().toISOString(),120000)
    if(!work)return false
    const row=this.store.get<PendingRow>(`SELECT c.*,a.id attempt_id,a.session_id,a.state FROM checkins c JOIN processing_attempts a ON a.checkin_id=c.id WHERE c.id=?`,[work.sourceKey])
    if(!row||row.state!=='PENDING'){await this.store.finishWork(work.id,work.claimToken,'UNKNOWN');return true}
    await this.store.transaction(tx=>tx.run("UPDATE processing_attempts SET state='RUNNING',version=2,updated_at=? WHERE id=? AND state='PENDING'",[this.clock().toISOString(),row.attempt_id]))
    const context:F2Context={patientId:row.patient_id,message:row.message,baselineScore:row.baseline_score,assessmentId:row.baseline_assessment_id,sessionId:row.session_id}
    let state:ProcessingState='FAILED',raw:string|null=null,output:ReturnType<typeof validF2>=null,failure:string|null='dependency_unavailable'
    try{
      const result=await this.options.runF2(context)
      raw=JSON.stringify({raw:result.raw,outputText:result.outputText,sessionId:result.sessionId})
      output=validF2(result.outputText,context);state=output?'SUCCEEDED':'INVALID';failure=output?null:'invalid_flow_output'
    }catch(error){state=error instanceof LangflowTimeoutError?'UNKNOWN':'FAILED';failure=state==='UNKNOWN'?'outcome_unknown':'dependency_unavailable'}
    await this.store.transaction(tx=>{
      const now=this.clock().toISOString()
      tx.run('UPDATE processing_attempts SET state=?,version=3,updated_at=?,output_json=?,raw_json=?,failure_code=? WHERE id=? AND state=?',
        [state,now,output?JSON.stringify(output):null,raw,failure,row.attempt_id,'RUNNING'])
      tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)',[randomUUID(),row.submitted_by,`checkin.${state.toLowerCase()}`,'checkin',row.id,now,JSON.stringify({attemptId:row.attempt_id,assessmentId:row.baseline_assessment_id})])
    })
    if(output?.action==='escalate_immediately'){
      // Alert persistence cannot hide an already committed urgent outcome.
      try{await this.store.transaction(tx=>enqueueWork(tx,'ALERT_F2',row.id,{checkinId:row.id,attemptId:row.attempt_id,patientId:row.patient_id},this.clock().toISOString()))}catch{}
    }
    await this.store.finishWork(work.id,work.claimToken,state==='SUCCEEDED'?'SUCCEEDED':state==='UNKNOWN'?'UNKNOWN':'FAILED')
    return true
  }
}
