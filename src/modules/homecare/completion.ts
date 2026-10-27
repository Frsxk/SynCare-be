import type { Transaction } from '../../storage/database.ts'
import { DomainError } from '../contracts/errors.ts'
import type { BookingRow,BookingTransition } from './contracts.ts'

export function applyCompletion(tx:Transaction,row:BookingRow,input:Extract<BookingTransition,{toStatus:'Completed'}>,now:string){
  if(row.status!=='Scheduled'||!row.confirmed_start_at||Date.parse(input.completedAt)>Date.parse(now)
    ||Date.parse(input.completedAt)<Date.parse(row.confirmed_start_at))throw new DomainError('validation_failed')
  tx.run("UPDATE bookings SET status='Completed',version=version+1,updated_at=?,completed_at=?,completion_note=? WHERE id=? AND version=?",
    [now,input.completedAt,input.completionNote,row.id,row.version])
}
