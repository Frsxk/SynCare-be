import type { Transaction } from '../../storage/database.ts'
import { DomainError,type RequestContext } from '../contracts/errors.ts'
import type { BookingRow,BookingTransition } from './contracts.ts'

export function applyTerminal(tx:Transaction,ctx:RequestContext,row:BookingRow,input:Extract<BookingTransition,{reason:string}>,now:string){
  if(['Completed','Cancelled','Rejected'].includes(row.status))throw new DomainError('version_conflict',{resourceId:row.id,currentVersion:row.version})
  if(input.toStatus==='Rejected'){
    if(ctx.principal.role!=='nurse')throw new DomainError('forbidden')
    if(row.status!=='Under Review')throw new DomainError('validation_failed')
  }else{
    if(ctx.principal.role==='patient'&&row.status==='Scheduled')throw new DomainError('forbidden')
    if(!['Requested','Under Review','Scheduled'].includes(row.status))throw new DomainError('validation_failed')
  }
  tx.run('UPDATE bookings SET status=?,version=version+1,updated_at=? WHERE id=? AND version=?',[input.toStatus,now,row.id,row.version])
}
