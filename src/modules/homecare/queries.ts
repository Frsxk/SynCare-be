import type { Store,Transaction } from '../../storage/database.ts'
import { DomainError,type RequestContext } from '../contracts/errors.ts'
import { CursorCodec,type Page,type PageInput } from '../contracts/pagination.ts'
import { assertPatientScope,currentIdentity,patientScope,requireCapability } from '../patients/service.ts'
import { parseInput,status,type Booking,type BookingRow,type History,type Service,type Address,type BookingFilter,TIMEZONE } from './contracts.ts'

type Reader=Pick<Store,'get'|'all'>|Transaction
export function authorize(reader:Reader,ctx:RequestContext,patientId?:string){
  currentIdentity(reader,ctx.principal)
  if(ctx.principal.role==='nurse')requireCapability(reader,ctx.principal,'booking.manage')
  if(patientId)assertPatientScope(reader,ctx.principal,patientId)
}
export function project(reader:Reader,ctx:RequestContext,row:BookingRow):Booking{
  const service=JSON.parse(row.service_snapshot_json) as Service,address=JSON.parse(row.address_json) as Address
  const patient=reader.get<{profile_json:string}>('SELECT profile_json FROM patients WHERE id=?',[row.patient_id])
  const patientName=patient?(JSON.parse(patient.profile_json) as {displayName?:unknown}).displayName:null
  if(typeof patientName!=='string'||!patientName.trim())throw new DomainError('processing_failed')
  try{
    parseInput({serviceId:row.service_id,address,preferredWindow:{startAt:row.preferred_start_at,endAt:row.preferred_end_at,timezone:row.preferred_timezone},visitNote:row.visit_note})
    if(service.id!==row.service_id||typeof service.name!=='string'||!service.name.trim()||typeof service.description!=='string'||!service.description.trim()
      ||!Number.isSafeInteger(service.version)||service.version<1||service.synthetic!==true||service.coverageProvince!=='DKI Jakarta'
      ||service.timezone!==TIMEZONE||!Array.isArray(service.coverageCities)||service.coverageCities.length===0||service.coverageCities.some(c=>typeof c!=='string'||!c.trim()))throw new Error('invalid_snapshot')
  }catch{throw new DomainError('processing_failed')}
  const timeline=reader.all<{id:string;version:number;from_status:string|null;to_status:string;actor_id:string;occurred_at:string;reason:string|null;internal_note:string|null}>(
    'SELECT * FROM booking_history WHERE booking_id=? ORDER BY version ASC,id ASC LIMIT 101',[row.id])
  if(timeline.length>100)throw new DomainError('processing_failed')
  const staff=row.assigned_staff_id?reader.get<{display_name:string}>('SELECT display_name FROM homecare_staff WHERE account_id=?',[row.assigned_staff_id]):null
  return {id:row.id,patientId:row.patient_id,patientName,service,address,visitNote:row.visit_note,status:status(row.status),version:row.version,
    preferredWindow:{startAt:row.preferred_start_at,endAt:row.preferred_end_at,timezone:TIMEZONE},
    assignedStaff:row.assigned_staff_id&&staff?{id:row.assigned_staff_id,displayName:staff.display_name}:null,
    confirmedSlot:row.confirmed_start_at&&row.confirmed_end_at?{startAt:row.confirmed_start_at,endAt:row.confirmed_end_at,timezone:TIMEZONE}:null,
    completedAt:row.completed_at,completionNote:row.completion_note,createdAt:row.created_at,updatedAt:row.updated_at,
    timeline:timeline.map((entry):History=>({id:entry.id,version:entry.version,fromStatus:entry.from_status?status(entry.from_status):null,toStatus:status(entry.to_status),
      actorId:entry.actor_id,occurredAt:entry.occurred_at,reason:entry.reason,...(ctx.principal.role==='nurse'?{internalNote:entry.internal_note}:{})}))}
}
export function read(store:Store,ctx:RequestContext,id:string):Booking{
  authorize(store,ctx)
  const row=store.get<BookingRow>('SELECT * FROM bookings WHERE id=?',[id])
  if(!row)throw new DomainError('not_found')
  authorize(store,ctx,row.patient_id)
  return project(store,ctx,row)
}
export async function list(store:Store,ctx:RequestContext,patientId:string|undefined,page:PageInput,codec:CursorCodec,filterStatus?:BookingFilter):Promise<Page<Booking>>{
  authorize(store,ctx,patientId)
  if(!patientId&&ctx.principal.role!=='nurse')throw new DomainError('forbidden')
  const scope=`bookings:${ctx.principal.id}:${patientId??'assigned'}${filterStatus?`:${filterStatus}`:''}`,filter=patientScope(store,ctx.principal)
  const statuses=filterStatus==='active'?['Requested','Under Review','Scheduled']:filterStatus?[filterStatus]:[]
  const position=page.cursor?codec.decode(scope,page.cursor):null
  const rows=store.all<BookingRow>(`SELECT b.* FROM bookings b WHERE b.patient_id IN (SELECT id FROM patients WHERE ${filter.sql})
    ${patientId?'AND b.patient_id=?':''} ${position?'AND (julianday(b.created_at)<julianday(?) OR (julianday(b.created_at)=julianday(?) AND b.id<?))':''}
    ${statuses.length?`AND b.status IN (${statuses.map(()=>'?').join(',')})`:''}
    ORDER BY julianday(b.created_at) DESC,b.id DESC LIMIT ?`,[...filter.bindings,...(patientId?[patientId]:[]),
    ...(position?[position.createdAt,position.createdAt,position.id]:[]),...statuses,page.limit+1])
  const items=rows.slice(0,page.limit),last=items.at(-1)
  return {items:items.map(row=>project(store,ctx,row)),nextCursor:rows.length>page.limit&&last?codec.encode(scope,{id:last.id,createdAt:last.created_at}):null}
}
