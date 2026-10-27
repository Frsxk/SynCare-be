import { DomainError } from '../contracts/errors.ts'
import type { AlertAction,AlertRow,AlertStatus } from './contracts.ts'
export function followupStatus(row:AlertRow,body:Exclude<AlertAction,{action:'acknowledge'}>,now:string):AlertStatus {
  if(body.action==='follow_up'){
    if(!['ACKNOWLEDGED','IN_PROGRESS'].includes(row.status))throw new DomainError('version_conflict',{resourceId:row.id,currentVersion:row.version})
    if(Date.parse(body.occurredAt)<Date.parse(row.source_at)||Date.parse(body.occurredAt)>Date.parse(now))throw new DomainError('validation_failed')
    return'IN_PROGRESS'
  }
  if(row.status!=='IN_PROGRESS')throw new DomainError('version_conflict',{resourceId:row.id,currentVersion:row.version})
  return'RESOLVED'
}
