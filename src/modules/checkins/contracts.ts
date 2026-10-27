import { randomUUID } from 'node:crypto'
import type { Transaction } from '../../storage/database.ts'
import type { F2Outcome } from '../workflows/flow-gateway.ts'
export type ProcessingState='PENDING'|'BLOCKED_BASELINE'|'RUNNING'|'SUCCEEDED'|'INVALID'|'FAILED'|'UNKNOWN'
export interface CheckinRecord {
  id:string;patientId:string;message:string;submittedBy:string;createdAt:string;version:number
  baseline:{assessmentId:string;confirmationId:string;score:number;dischargeId:string;sourceVersion:number;applicable:boolean}|null
  processing:{id:string;state:ProcessingState;version:number;updatedAt:string;failureCode:string|null}
  outcome:F2Outcome|null;alertEvidence:'not_applicable'|'queued'|'unavailable'
}
export function enqueueWork(tx:Transaction,kind:'CHECKIN_F2'|'ALERT_F2',sourceKey:string,payload:unknown,now:string){
  tx.run(`INSERT INTO work_items(id,kind,source_key,payload_json,available_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(kind,source_key) DO NOTHING`,[randomUUID(),kind,sourceKey,JSON.stringify(payload),now,now,now])
}
