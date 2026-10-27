import { randomUUID } from 'node:crypto'
import type { Store } from '../../storage/database.ts'
import { enqueueWork } from '../checkins/contracts.ts'
import { validF2 } from '../workflows/flow-gateway.ts'
interface Source {id:string;patient_id:string;baseline_score:number;created_at:string;attempt_id:string;output_json:string;updated_at:string}
const sources=`SELECT c.id,c.patient_id,c.baseline_score,c.created_at,p.id attempt_id,p.output_json,p.updated_at FROM checkins c JOIN processing_attempts p ON p.checkin_id=c.id WHERE p.state='SUCCEEDED'`
export class AlertProducer {
  constructor(private readonly store:Store,private readonly clock:()=>Date=()=>new Date()){}
  async reconcile(){
    const now=this.clock().toISOString()
    await this.store.transaction(tx=>{
      const rows=tx.all<Source>(`${sources} AND json_extract(p.output_json,'$.action')='escalate_immediately' AND NOT EXISTS(SELECT 1 FROM alerts a WHERE a.checkin_id=c.id) ORDER BY c.created_at,c.id LIMIT 50`)
      for(const row of rows){
        if(validF2(row.output_json,{patientId:row.patient_id,baselineScore:row.baseline_score})?.action!=='escalate_immediately')continue
        enqueueWork(tx,'ALERT_F2',row.id,{checkinId:row.id,attemptId:row.attempt_id,patientId:row.patient_id},now)
        // Replaying a local DB materialization is safe; this path never invokes an upstream flow.
        tx.run("UPDATE work_items SET state='PENDING',claim_token=NULL,updated_at=? WHERE kind='ALERT_F2' AND source_key=? AND (state IN ('FAILED','UNKNOWN','SUCCEEDED') OR (state='RUNNING' AND julianday(lease_expires_at)<=julianday(?)))",[now,row.id,now])
      }
      tx.run("UPDATE work_items SET state='SUCCEEDED',claim_token=NULL,updated_at=? WHERE kind='ALERT_F2' AND state!='SUCCEEDED' AND EXISTS(SELECT 1 FROM alerts a WHERE a.checkin_id=work_items.source_key)",[now])
    })
  }
  async processNext(){
    const work=await this.store.claimWork('ALERT_F2',this.clock().toISOString());if(!work)return false
    try{
      await this.store.transaction(tx=>{
        if(!tx.get("SELECT id FROM work_items WHERE id=? AND state='RUNNING' AND claim_token=?",[work.id,work.claimToken]))return
        const row=tx.get<Source>(`${sources} AND c.id=?`,[work.sourceKey])
        const output=row?validF2(row.output_json,{patientId:row.patient_id,baselineScore:row.baseline_score}):null
        if(!row||output?.action!=='escalate_immediately')throw Error('invalid_alert_source')
        if(!tx.get('SELECT id FROM alerts WHERE checkin_id=?',[row.id])){
          const id=randomUUID(),now=this.clock().toISOString()
          tx.run(`INSERT INTO alerts(id,patient_id,checkin_id,attempt_id,source_type,source_action,reason,reported_at,source_at,status,version,created_at,updated_at)
            VALUES (?,?,?,?,'F2','escalate_immediately',?,?,?,'PENDING_REVIEW',1,?,?)`,[id,row.patient_id,row.id,row.attempt_id,output.reason,row.created_at,row.updated_at,now,now])
          tx.run("INSERT INTO alert_actions VALUES (?,?,1,'created',NULL,'PENDING_REVIEW',NULL,?,?,NULL,NULL,NULL)",[randomUUID(),id,now,now])
        }
        tx.run("UPDATE work_items SET state='SUCCEEDED',claim_token=NULL,updated_at=?,last_error_code=NULL WHERE id=? AND claim_token=?",[this.clock().toISOString(),work.id,work.claimToken])
      })
    }catch{
      await this.store.transaction(tx=>tx.run("UPDATE work_items SET state='FAILED',claim_token=NULL,last_error_code='processing_failed',available_at=?,updated_at=? WHERE id=? AND claim_token=?",
        [new Date(this.clock().getTime()+30000).toISOString(),this.clock().toISOString(),work.id,work.claimToken]))
    }
    return true
  }
}
