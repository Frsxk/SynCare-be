import {readPrivateJson} from '../src/security/private-files.cjs'
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { AlertDetail,AlertSummary } from '../src/modules/alerts/contracts.ts'
import type { CheckinRecord } from '../src/modules/checkins/contracts.ts'
const accounts=readPrivateJson(new URL('../data/local-demo-accounts.json',import.meta.url)) as {nurses:{identifier:string;password:string}[];patients:{identifier:string;password:string}[]}
const prior=readPrivateJson(new URL('../data/m07-source-evidence.json',import.meta.url)) as {alerts:{id:string}[]}
const demo=readPrivateJson(new URL('../data/m07-demo-evidence.json',import.meta.url)) as {alertId:string}
const ids=[...new Set([...prior.alerts.map(a=>a.id),demo.alertId])],tokens:string[]=[]
let checks=0
const check=(value:unknown)=>{checks++;if(!value)throw Error('alert_verification_failed')}
const call=(p:string,token:string|undefined,method='GET',body?:unknown)=>fetch(`http://127.0.0.1:8080/api/v1/${p}`,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}) ,...(method==='POST'?{'idempotency-key':randomUUID()}:{})},...(body?{body:JSON.stringify(body)}:{})})
const login=async(account:{identifier:string;password:string})=>{const response=await call('auth/login',undefined,'POST',{identifier:account.identifier,password:account.password});check(response.status===200);const grant=(await response.json() as {data:{sessionToken:string;principal:{patientId?:string}}}).data;tokens.push(grant.sessionToken);return grant}
try{
  const nurse=await login(accounts.nurses[0]!),foreignNurse=await login(accounts.nurses[1]!),patient=await login(accounts.patients[0]!),foreignPatient=await login(accounts.patients[1]!)
  const all=await call('alerts?status=all&limit=100',nurse.sessionToken);check(all.status===200)
  const rows=(await all.json() as {data:AlertSummary[]}).data.filter(a=>ids.includes(a.id));check(rows.length===ids.length)
  check((await call('alerts',patient.sessionToken)).status===403)
  const own=await call(`patients/${patient.principal.patientId}/alerts?limit=100`,patient.sessionToken);check(own.status===200);check(!(JSON.stringify(await own.json()).includes('internalNote')))
  for(const row of rows){
    const response=await call(`alerts/${row.id}`,nurse.sessionToken);check(response.status===200);check(response.headers.get('cache-control')?.includes('no-store'))
    const alert=(await response.json() as {data:AlertDetail}).data
    check(alert.source.type==='F2'&&alert.source.action==='escalate_immediately'&&alert.urgency==='acute')
    const original=await call(`checkins/${alert.source.reportId}`,nurse.sessionToken);check(original.status===200)
    const report=(await original.json() as {data:CheckinRecord}).data
    check(report.processing.state==='SUCCEEDED'&&report.outcome?.action==='escalate_immediately')
    check(report.outcome?.action==='escalate_immediately'&&report.outcome.reason===alert.source.reason)
    check(report.patientId===alert.patientId&&report.processing.id===alert.source.attemptId&&report.createdAt===alert.source.reportedAt&&report.processing.updatedAt===alert.source.outcomeAt)
    const projected=await call(`alerts/${row.id}`,patient.sessionToken);check(projected.status===200)
    const safe=(await projected.json() as {data:AlertDetail}).data,text=JSON.stringify(safe)
    check(!text.includes('INTERNAL M07')&&!text.includes('internalNote')&&!text.includes('actorId')&&!text.includes('actionType')&&!('patientName'in safe))
    check(safe.version===alert.version&&safe.status===alert.status&&safe.timeline.length===alert.timeline.length)
    safe.timeline.forEach((event,index)=>{
      check(Object.keys(event).length===5&&Object.keys(event).every(key=>['id','version','status','recordedAt','patientSummary'].includes(key)))
      check(event.id===alert.timeline[index]?.id&&event.status===alert.timeline[index]?.status&&event.patientSummary===alert.timeline[index]?.patientSummary)
    })
    check((await call(`alerts/${row.id}`,foreignNurse.sessionToken)).status===404)
    check((await call(`alerts/${row.id}`,foreignPatient.sessionToken)).status===404)
    check((await call(`alerts/${row.id}/actions`,patient.sessionToken,'POST',{action:'acknowledge',expectedVersion:alert.version})).status===403)
    check((await call(`alerts/${row.id}/actions`,nurse.sessionToken,'POST',{action:'acknowledge',expectedVersion:alert.version,actorId:patient.principal.patientId})).status===422)
    if(row.id!==demo.alertId){
      check(alert.status==='RESOLVED'&&alert.version===4&&alert.timeline.length===4&&!!alert.acknowledgedAt&&!!alert.resolvedAt)
      check(alert.timeline.filter(a=>a.internalNote?.includes('INTERNAL M07')).length===2)
      check((await call(`alerts/${row.id}/actions`,nurse.sessionToken,'POST',{action:'acknowledge',expectedVersion:4})).status===409)
      const first=(await(await call(`alerts/${row.id}?limit=2`,patient.sessionToken)).json() as {data:AlertDetail}).data
      check(first.timeline.length===2&&!!first.timelineNextCursor)
      const older=(await(await call(`alerts/${row.id}?limit=2&cursor=${encodeURIComponent(first.timelineNextCursor!)}`,patient.sessionToken)).json() as {data:AlertDetail}).data
      check(older.timeline.length===2&&older.timelineNextCursor===null&&older.timeline[0]?.version===1)
      check((await call(`alerts/${row.id}?limit=2&cursor=${encodeURIComponent(first.timelineNextCursor!)}`,nurse.sessionToken)).status===422)
    }else check(alert.timeline[0]?.status==='PENDING_REVIEW'&&report.message.startsWith('DATA UJI SINTETIS M07 DEMO.'))
    const unchanged=(await(await call(`alerts/${row.id}`,patient.sessionToken)).json() as {data:AlertDetail}).data;check(unchanged.version===alert.version)
  }
  const active=(await(await call('alerts?status=active&limit=100',nurse.sessionToken)).json() as {data:AlertSummary[]}).data
  check(!active.some(a=>ids.includes(a.id)&&a.id!==demo.alertId))
  const paged=(await(await call('alerts?status=all&limit=1',nurse.sessionToken)).json() as {nextCursor:string|null});check(!!paged.nextCursor)
  check((await call(`alerts?status=active&limit=1&cursor=${encodeURIComponent(paged.nextCursor!)}`,nurse.sessionToken)).status===422)
  for(const query of ['status=unknown','status=all&status=active','limit=101','extra=1'])check((await call(`alerts?${query}`,nurse.sessionToken)).status===422)
  const guidance=await call('emergency-guidance',patient.sessionToken);check(guidance.status===200)
  check((await guidance.json() as {data:{contacts:{action:string}[]}}).data.contacts.every(c=>c.action==='information_only'))
  writeFileSync(new URL('../data/m07-live-evidence.json',import.meta.url),JSON.stringify({verifiedAt:new Date().toISOString(),ids,checks,sourceIdentityVerified:true,patientPrivacyVerified:true,nativeDevice:false},null,2))
  console.log(JSON.stringify({result:'PASS',checks,actualAlerts:ids.length,sourceIdentityVerified:true,patientProjectionPrivate:true,credentialsPrinted:false}))
}catch{console.error(JSON.stringify({result:'FAIL',checks,credentialsPrinted:false}));process.exitCode=1}
finally{for(const token of tokens)await call('auth/session',token,'DELETE').catch(()=>{})}
