import {readPrivateJson} from '../src/security/private-files.cjs'
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const accounts=readPrivateJson(new URL('../data/local-demo-accounts.json',import.meta.url)) as {nurses:{identifier:string;password:string}[];patients:{identifier:string;password:string}[]}
const browser=readPrivateJson(new URL('../data/m06-browser-evidence.json',import.meta.url)) as Record<string,{id:string}>
const flutter=readPrivateJson(new URL('../data/m06-flutter-evidence.json',import.meta.url)) as {id:string}
const expected=[['completed',browser.completed?.id,'Completed'],['schedule',browser.schedule?.id,'Cancelled'],['cancelled',browser.cancelled?.id,'Cancelled'],['rejected',browser.rejected?.id,'Rejected'],['flutter',flutter.id,'Cancelled']] as const
const tokens:string[]=[];let checks=0
class CheckFailure extends Error{}
const check=(value:boolean,label:string)=>{if(!value)throw new CheckFailure(label);checks++}
const call=(path:string,token?:string,method='GET',body?:unknown)=>fetch(`http://127.0.0.1:8080/api/v1/${path}`,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}) ,...(method==='POST'?{'idempotency-key':randomUUID()}:{})},...(body?{body:JSON.stringify(body)}:{})})
const data=async<T>(response:Response)=>(await response.json() as {data:T}).data
const login=async(account:{identifier:string;password:string})=>{const response=await call('auth/login',undefined,'POST',{identifier:account.identifier,password:account.password});check(response.status===200,'login');const grant=await data<{sessionToken:string;principal:{id:string;patientId?:string}}>(response);tokens.push(grant.sessionToken);return grant}
interface LifecycleRecord {id:string;patientId:string;status:string;version:number;assignedStaff:{id:string}|null;confirmedSlot:{startAt:string;endAt:string;timezone:string}|null;completedAt:string|null;completionNote:string|null;timeline:{toStatus:string;reason:string|null;internalNote?:string|null}[]}
try{
  check(expected.every(([,id])=>typeof id==='string'&&id.length>0),'actual_evidence_ids')
  const a=await login(accounts.patients[0]!),b=await login(accounts.patients[1]!),nurse=await login(accounts.nurses[0]!),other=await login(accounts.nurses[1]!)
  const active=await data<LifecycleRecord[]>(await call('bookings?status=active&limit=100',nurse.sessionToken));check(active.every(r=>['Requested','Under Review','Scheduled'].includes(r.status)),'active_filter')
  const records:LifecycleRecord[]=[]
  for(const [scenario,id,status] of expected){
    const response=await call(`bookings/${id}`,a.sessionToken);check(response.status===200,`${scenario}_own_read`)
    const record=await data<LifecycleRecord>(response);records.push(record)
    check(record.status===status&&record.patientId===a.principal.patientId,`${scenario}_actual_state`)
    check(record.timeline.at(-1)?.toStatus===status,`${scenario}_terminal_history`)
    check(!record.timeline.some(event=>Object.hasOwn(event,'internalNote')),`${scenario}_private_note_redacted`)
    check(!active.some(r=>r.id===id),`${scenario}_not_active`)
    check((await call(`bookings/${id}`,b.sessionToken)).status===404,`${scenario}_foreign_patient_denied`)
    check((await call(`bookings/${id}`,other.sessionToken)).status===404,`${scenario}_foreign_nurse_denied`)
    if(status==='Completed'){
      check(!!record.completedAt&&!!record.completionNote&&!!record.confirmedSlot&&!!record.assignedStaff,'completed_required_fields')
      check(Date.parse(record.completedAt!)<=Date.now()&&Date.parse(record.completedAt!)>=Date.parse(record.confirmedSlot!.startAt),'actual_completion_time')
    }else check(!!record.timeline.at(-1)?.reason,`${scenario}_patient_reason`)
    const filtered=await data<LifecycleRecord[]>(await call(`bookings?status=${status}&limit=100`,nurse.sessionToken));check(filtered.every(r=>r.status===status)&&filtered.some(r=>r.id===id),`${scenario}_server_filter`)
    check((await call(`bookings/${id}/transitions`,nurse.sessionToken,'POST',{expectedVersion:record.version,toStatus:'Under Review'})).status===409,`${scenario}_terminal_not_reopened`)
  }
  const staff=await data<{id:string}[]>(await call(`homecare/staff?patientId=${a.principal.patientId}&limit=20`,nurse.sessionToken));check(staff.length===1&&staff[0]!.id===nurse.principal.id,'current_eligible_staff')
  check((await call(`homecare/staff?patientId=${a.principal.patientId}`,a.sessionToken)).status===403,'patient_staff_query_denied')
  check((await call(`homecare/staff?patientId=${a.principal.patientId}`,other.sessionToken)).status===404,'foreign_staff_scope_denied')
  check(records.find(r=>r.id===browser.schedule?.id)?.confirmedSlot!==null,'cancelled_schedule_retained_as_history')
  writeFileSync(new URL('../data/m06-live-evidence.json',import.meta.url),JSON.stringify({verifiedAt:new Date().toISOString(),ids:records.map(r=>r.id),checks,simulationOnly:true},null,2))
  console.log(JSON.stringify({status:'pass',checks,actualRecords:records.length,simulationOnly:true,credentialsPrinted:false}))
}catch(error){console.error(JSON.stringify({status:'fail',checks,check:error instanceof CheckFailure?error.message:'lifecycle_verification_failed',credentialsPrinted:false}));process.exitCode=1}
finally{for(const token of tokens)await call('auth/session',token,'DELETE').catch(()=>{})}
