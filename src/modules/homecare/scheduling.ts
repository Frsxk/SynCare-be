import type { Store,Transaction } from '../../storage/database.ts'
import { DomainError,type RequestContext } from '../contracts/errors.ts'
import { CursorCodec,type Page,type PageInput } from '../contracts/pagination.ts'
import { assertPatientScope,requireCapability } from '../patients/service.ts'
import type { BookingRow,BookingTransition } from './contracts.ts'

export interface Staff {id:string;displayName:string;version:number}
interface StaffRow {account_id:string;display_name:string;version:number;created_at:string}
const eligible=`s.active=1 AND a.active=1 AND a.role='nurse'
  AND EXISTS (SELECT 1 FROM capability_grants g WHERE g.account_id=s.account_id AND g.capability='booking.manage' AND g.revoked_at IS NULL)
  AND EXISTS (SELECT 1 FROM patient_assignments p WHERE p.nurse_account_id=s.account_id AND p.patient_id=? AND p.revoked_at IS NULL AND julianday(p.effective_at)<=julianday(?))`
export async function staff(store:Store,ctx:RequestContext,patientId:string,page:PageInput,codec:CursorCodec,clock:()=>Date):Promise<Page<Staff>>{
  requireCapability(store,ctx.principal,'booking.manage');assertPatientScope(store,ctx.principal,patientId)
  const scope=`homecare-staff:${ctx.principal.id}:${patientId}`,position=page.cursor?codec.decode(scope,page.cursor):null
  const rows=store.all<StaffRow>(`SELECT s.*,a.created_at FROM homecare_staff s JOIN accounts a ON a.id=s.account_id WHERE ${eligible}
    ${position?'AND (julianday(a.created_at)<julianday(?) OR (julianday(a.created_at)=julianday(?) AND s.account_id<?))':''}
    ORDER BY julianday(a.created_at) DESC,s.account_id DESC LIMIT ?`,[patientId,clock().toISOString(),...(position?[position.createdAt,position.createdAt,position.id]:[]),page.limit+1])
  const items=rows.slice(0,page.limit),last=items.at(-1)
  return {items:items.map(row=>({id:row.account_id,displayName:row.display_name,version:row.version})),nextCursor:rows.length>page.limit&&last?codec.encode(scope,{id:last.account_id,createdAt:last.created_at}):null}
}
export function applySchedule(tx:Transaction,row:BookingRow,input:Extract<BookingTransition,{toStatus:'Scheduled'}>,now:string){
  if(row.status!=='Under Review'||Date.parse(input.confirmedSlot.startAt)<=Date.parse(now))throw new DomainError('validation_failed')
  const nurse=tx.get(`SELECT s.account_id FROM homecare_staff s JOIN accounts a ON a.id=s.account_id WHERE s.account_id=? AND ${eligible}`,[input.assignedStaffId,row.patient_id,now])
  if(!nurse)throw new DomainError('validation_failed')
  const overlap=tx.get(`SELECT id FROM bookings WHERE assigned_staff_id=? AND status='Scheduled' AND id!=?
    AND julianday(confirmed_start_at)<julianday(?) AND julianday(confirmed_end_at)>julianday(?) LIMIT 1`,[input.assignedStaffId,row.id,input.confirmedSlot.endAt,input.confirmedSlot.startAt])
  if(overlap)throw new DomainError('booking_schedule_conflict',{resourceId:row.id,currentVersion:row.version})
  tx.run(`UPDATE bookings SET status='Scheduled',version=version+1,updated_at=?,assigned_staff_id=?,confirmed_start_at=?,confirmed_end_at=?,confirmed_timezone=? WHERE id=? AND version=?`,
    [now,input.assignedStaffId,input.confirmedSlot.startAt,input.confirmedSlot.endAt,input.confirmedSlot.timezone,row.id,row.version])
}
