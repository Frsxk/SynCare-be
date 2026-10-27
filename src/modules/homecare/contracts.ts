import { DomainError } from '../contracts/errors.ts'
import { strictTextObject } from '../contracts/validation.ts'
import { exactObject } from '../patients/service.ts'

export const BOOKING_STATUSES=['Requested','Under Review','Scheduled','Completed','Cancelled','Rejected'] as const
export type BookingStatus=typeof BOOKING_STATUSES[number]
export type BookingFilter=BookingStatus|'active'
export function parseFilter(value:unknown):BookingFilter|undefined{
  if(value===undefined||value==='all')return undefined
  if(value==='active'||BOOKING_STATUSES.includes(value as BookingStatus))return value as BookingFilter
  throw new DomainError('validation_failed')
}
export const CITIES=['Jakarta Pusat','Jakarta Utara','Jakarta Barat','Jakarta Selatan','Jakarta Timur','Kepulauan Seribu'] as const
export const TIMEZONE='Asia/Jakarta'
export interface Service { id:string; name:string; description:string; version:number; synthetic:true; coverageProvince:'DKI Jakarta'; coverageCities:readonly string[]; timezone:typeof TIMEZONE }
export interface Window { startAt:string; endAt:string; timezone:typeof TIMEZONE }
export interface Address { fullAddress:string; kelurahan:string; kecamatan:string; city:string }
export interface BookingInput { serviceId:string; preferredWindow:Window; address:Address; visitNote:string }
export interface History { id:string; version:number; fromStatus:BookingStatus|null; toStatus:BookingStatus; actorId:string; occurredAt:string; reason:string|null; internalNote?:string|null }
export interface Booking { id:string; patientId:string; patientName:string; service:Service; address:Address; preferredWindow:Window; visitNote:string; status:BookingStatus; version:number;
  assignedStaff:{id:string;displayName:string}|null; confirmedSlot:Window|null; completedAt:string|null; completionNote:string|null; createdAt:string; updatedAt:string; timeline:History[] }
export interface BookingRow {id:string;patient_id:string;service_id:string;service_snapshot_json:string;address_json:string;visit_note:string;
  preferred_start_at:string;preferred_end_at:string;preferred_timezone:string;status:string;version:number;assigned_staff_id:string|null;
  confirmed_start_at:string|null;confirmed_end_at:string|null;confirmed_timezone:string|null;completed_at:string|null;completion_note:string|null;created_by:string;created_at:string;updated_at:string}
export function status(value:string):BookingStatus {
  if(!BOOKING_STATUSES.includes(value as BookingStatus))throw new DomainError('processing_failed')
  return value as BookingStatus
}
export function instant(value:unknown):string{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw new DomainError('validation_failed')
  return value
}
export function parseWindow(value:unknown):Window{
  const window=exactObject(value,['startAt','endAt','timezone'])
  const startAt=instant(window.startAt),endAt=instant(window.endAt)
  if(Date.parse(endAt)<=Date.parse(startAt)||window.timezone!==TIMEZONE)throw new DomainError('validation_failed')
  return {startAt,endAt,timezone:TIMEZONE}
}
export type BookingTransition={expectedVersion:number;toStatus:'Under Review'}|{expectedVersion:number;toStatus:'Scheduled';confirmedSlot:Window;assignedStaffId:string}
  |{expectedVersion:number;toStatus:'Completed';completedAt:string;completionNote:string}
  |{expectedVersion:number;toStatus:'Cancelled'|'Rejected';reason:string}
export function parseTransition(value:unknown):BookingTransition{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new DomainError('validation_failed')
  const status=(value as Record<string,unknown>).toStatus
  const body=exactObject(value,status==='Scheduled'?['expectedVersion','toStatus','confirmedSlot','assignedStaffId']:
    status==='Completed'?['expectedVersion','toStatus','completedAt','completionNote']:
    status==='Cancelled'||status==='Rejected'?['expectedVersion','toStatus','reason']:['expectedVersion','toStatus'])
  if(!Number.isSafeInteger(body.expectedVersion)||(body.expectedVersion as number)<1)throw new DomainError('validation_failed')
  const expectedVersion=body.expectedVersion as number
  if(status==='Under Review')return {expectedVersion,toStatus:status}
  if(status==='Scheduled')return {expectedVersion,toStatus:status,confirmedSlot:parseWindow(body.confirmedSlot),assignedStaffId:strictTextObject({id:body.assignedStaffId},{id:128}).id.trim()}
  if(status==='Completed')return {expectedVersion,toStatus:status,completedAt:instant(body.completedAt),completionNote:strictTextObject({note:body.completionNote},{note:2000}).note.trim()}
  if(status==='Cancelled'||status==='Rejected')return {expectedVersion,toStatus:status,reason:strictTextObject({reason:body.reason},{reason:2000}).reason.trim()}
  throw new DomainError('validation_failed')
}
export function parseInput(value:unknown):BookingInput{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new DomainError('validation_failed')
  const raw=value as Record<string,unknown>
  const body=exactObject({...raw,visitNote:raw.visitNote===undefined?'':raw.visitNote},['serviceId','preferredWindow','address','visitNote'])
  const serviceId=strictTextObject({serviceId:body.serviceId},{serviceId:128}).serviceId.trim()
  const address=strictTextObject(body.address,{fullAddress:1000,kelurahan:160,kecamatan:160,city:160}) as unknown as Address
  for(const key of Object.keys(address) as (keyof Address)[])address[key]=address[key].trim()
  if(!CITIES.includes(address.city as typeof CITIES[number]))throw new DomainError('validation_failed')
  const window=exactObject(body.preferredWindow,['startAt','endAt','timezone'])
  const startAt=instant(window.startAt),endAt=instant(window.endAt)
  if(Date.parse(endAt)<=Date.parse(startAt)||window.timezone!==TIMEZONE)throw new DomainError('validation_failed')
  if(typeof body.visitNote!=='string'||body.visitNote.length>2000)throw new DomainError('validation_failed')
  return {serviceId,address,preferredWindow:{startAt,endAt,timezone:TIMEZONE},visitNote:body.visitNote.trim()}
}
