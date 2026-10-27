import { randomUUID } from 'node:crypto'
import type { Store } from '../../storage/database.ts'
import { DomainError,type RequestContext } from '../contracts/errors.ts'
import { withIdempotency } from '../contracts/idempotency.ts'
import { requireCapability } from '../patients/service.ts'
import { parseTransition,type BookingRow } from './contracts.ts'
import { authorize,read } from './queries.ts'
import { applySchedule } from './scheduling.ts'
import { applyCompletion } from './completion.ts'
import { applyTerminal } from './cancellation.ts'

export async function transition(store:Store,ctx:RequestContext,id:string,input:unknown,clock:()=>Date){
  const body=parseTransition(input)
  if(ctx.principal.role==='patient'){
    if(body.toStatus!=='Cancelled')throw new DomainError('forbidden')
  }else requireCapability(store,ctx.principal,'booking.manage')
  read(store,ctx,id)
  const saved=await withIdempotency(store,{principalId:ctx.principal.id,method:'POST',resourceKey:`/bookings/${id}/transitions`,key:ctx.idempotencyKey??'',payload:body},tx=>{
    const row=tx.get<BookingRow>('SELECT * FROM bookings WHERE id=?',[id])
    if(!row)throw new DomainError('not_found')
    authorize(tx,ctx,row.patient_id)
    if(row.version!==body.expectedVersion)throw new DomainError('version_conflict',{resourceId:id,currentVersion:row.version})
    const now=clock().toISOString(),version=row.version+1
    if(body.toStatus==='Scheduled')applySchedule(tx,row,body,now)
    else if(body.toStatus==='Completed')applyCompletion(tx,row,body,now)
    else if(body.toStatus==='Cancelled'||body.toStatus==='Rejected')applyTerminal(tx,ctx,row,body,now)
    else {
      if(row.status!=='Requested')throw new DomainError('version_conflict',{resourceId:id,currentVersion:row.version})
      tx.run("UPDATE bookings SET status='Under Review',version=?,updated_at=? WHERE id=? AND version=?",[version,now,id,row.version])
    }
    tx.run('INSERT INTO booking_history VALUES (?,?,?,?,?,?,?,?,?)',[randomUUID(),id,version,row.status,body.toStatus,ctx.principal.id,now,'reason' in body?body.reason:null,null])
    return {resourceId:id,status:200,data:{id}}
  })
  return {resource:read(store,ctx,id),replayed:saved.replayed}
}
