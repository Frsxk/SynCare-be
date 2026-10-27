import {readPrivateJson} from '../src/security/private-files.cjs'
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const accounts=readPrivateJson(new URL('../data/local-demo-accounts.json',import.meta.url)) as {nurses:{identifier:string;password:string}[];patients:{identifier:string;password:string}[]}
const tokens:string[]=[];let checks=0
class CheckFailure extends Error{}
const check=(value:boolean,label:string)=>{if(!value)throw new CheckFailure(label);checks++}
const call=(path:string,token?:string,method='GET',body?:unknown,key?:string)=>fetch(`http://127.0.0.1:8080/api/v1/${path}`,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}) ,...(key?{'idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{})})
const data=async<T>(response:Response)=>(await response.json() as {data:T}).data
const login=async(account:{identifier:string;password:string})=>{const response=await call('auth/login',undefined,'POST',{identifier:account.identifier,password:account.password});check(response.status===200,'login');const grant=await data<{sessionToken:string;principal:{patientId?:string}}>(response);tokens.push(grant.sessionToken);return grant}
try{
  const a=await login(accounts.patients[0]!),b=await login(accounts.patients[1]!),nurse=await login(accounts.nurses[0]!),foreign=await login(accounts.nurses[1]!)
  const services=await data<{id:string}[]>(await call('homecare/services?limit=1',a.sessionToken));check(services.length===1,'actual_active_catalog')
  const input={serviceId:services[0]!.id,address:{fullAddress:'Alamat pengujian sintetis M05 nomor 1',kelurahan:'Kelurahan uji',kecamatan:'Kecamatan uji',city:'Jakarta Pusat'},preferredWindow:{startAt:'2030-01-02T01:00:00.000Z',endAt:'2030-01-02T02:00:00.000Z',timezone:'Asia/Jakarta'},visitNote:'Bukan pasien atau kunjungan nyata.'}
  const key=randomUUID(),path=`patients/${a.principal.patientId}/bookings`
  const response=await call(path,a.sessionToken,'POST',input,key);check(response.status===201,'request_committed')
  type Booking={id:string;patientId:string;status:string;version:number;assignedStaff:unknown;confirmedSlot:unknown;timeline:unknown[]}
  const saved=(await data<{resource:Booking}>(response)).resource
  check(saved.status==='Requested'&&saved.assignedStaff===null&&saved.confirmedSlot===null,'preference_not_schedule')
  const replay=await data<{resource:Booking;replayed:boolean}>(await call(path,a.sessionToken,'POST',input,key));check(replay.replayed&&replay.resource.id===saved.id,'lost_response_replay')
  check((await call(path,a.sessionToken,'POST',{...input,visitNote:'different'},key)).status===409,'different_body_conflict')
  check((await call(`patients/${b.principal.patientId}/bookings`,a.sessionToken,'POST',input,randomUUID())).status===404,'cross_patient_write_denied')
  check((await call(`bookings/${saved.id}`,foreign.sessionToken)).status===404,'foreign_nurse_denied')
  check((await call('bookings',a.sessionToken)).status===403,'patient_global_queue_denied')
  const outcomes=await Promise.all([1,2].map(()=>call(`bookings/${saved.id}/transitions`,nurse.sessionToken,'POST',{expectedVersion:1,toStatus:'Under Review'},randomUUID())))
  check(outcomes.map(r=>r.status).sort().join(',')==='200,409','concurrent_review_one_commit')
  const reviewed=await data<Booking>(await call(`bookings/${saved.id}`,a.sessionToken))
  check(reviewed.status==='Under Review'&&reviewed.version===2&&reviewed.timeline.length===2,'stored_review_history')
  check(!JSON.stringify(reviewed).includes('internalNote'),'patient_note_redaction')
  check((await call(`bookings/${saved.id}/transitions`,nurse.sessionToken,'POST',{expectedVersion:2,toStatus:'Completed'},randomUUID())).status===422,'future_transition_denied')
  const list=await data<Booking[]>(await call(`${path}?limit=100`,a.sessionToken));check(list.filter(x=>x.id===saved.id).length===1,'one_booking_only')
  const queue=await data<Booking[]>(await call('bookings?limit=100',nurse.sessionToken));check(queue.some(x=>x.id===saved.id)&&queue.every(x=>x.patientId!==b.principal.patientId),'assigned_queue')
  writeFileSync(new URL('../data/m05-live-evidence.json',import.meta.url),JSON.stringify({verifiedAt:new Date().toISOString(),bookingId:saved.id,patientId:saved.patientId,status:reviewed.status,checks,simulationOnly:true},null,2))
  console.log(JSON.stringify({status:'pass',checks,bookingId:saved.id,simulationOnly:true,credentialsPrinted:false}))
}catch(error){console.error(JSON.stringify({status:'fail',checks,check:error instanceof CheckFailure?error.message:'homecare_verification_failed',credentialsPrinted:false}));process.exitCode=1}
finally{for(const token of tokens)await call('auth/session',token,'DELETE').catch(()=>{})}
