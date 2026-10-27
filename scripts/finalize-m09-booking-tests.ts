import {readPrivateJson} from '../src/security/private-files.cjs'
import {writeFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
const accounts=readPrivateJson(new URL('../data/local-demo-accounts.json',import.meta.url)) as {nurses:{identifier:string;password:string}[]}
const since=(readPrivateJson(new URL('../data/m09-regression-start.json',import.meta.url)) as {startedAt:string}).startedAt
if(!Number.isFinite(Date.parse(since)))throw Error('explicit_regression_start_required')
const apply=process.argv.includes('--apply');let token:string|undefined
const call=(path:string,method='GET',body?:unknown)=>fetch(`http://127.0.0.1:8080/api/v1/${path}`,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}) ,...(method==='POST'?{'idempotency-key':randomUUID()}:{})},...(body?{body:JSON.stringify(body)}:{})})
try{
 const account=accounts.nurses[0]!,response=await call('auth/login','POST',{identifier:account.identifier,password:account.password});if(response.status!==200)throw Error('login_failed');token=(await response.json() as {data:{sessionToken:string}}).data.sessionToken
 const listed=await call('bookings?status=active&limit=100');if(listed.status!==200)throw Error('queue_unavailable')
 const rows=(await listed.json() as {data:{id:string;version:number;createdAt:string;visitNote:string}[]}).data
 const candidates=rows.filter(row=>Date.parse(row.createdAt)>=Date.parse(since)&&(row.visitNote==='Pengajuan sintetis browser.'||row.visitNote.startsWith('DATA UJI M06:')))
 let closed=0,conflicts=0
 for(const row of candidates){if(!apply)continue;const result=await call(`bookings/${row.id}/transitions`,'POST',{expectedVersion:row.version,toStatus:'Cancelled',reason:'Skenario regresi booking pada M09 selesai diuji. Histori simulasi dipertahankan.'});if(result.status===200)closed++;else if(result.status===409)conflicts++;else throw Error('test_closure_failed')}
 if(apply)writeFileSync(new URL('../data/m09-booking-finalization.json',import.meta.url),JSON.stringify({verifiedAt:new Date().toISOString(),since,ids:candidates.map(row=>row.id),closed,conflicts,recordsDeleted:0},null,2))
 console.log(JSON.stringify({result:'PASS',mode:apply?'apply':'preview',candidates:candidates.length,closed,conflicts,recordsDeleted:0,credentialsPrinted:false}))
}catch{console.error('M09 test finalization failed; credentials not printed.');process.exitCode=1}
finally{if(token)await call('auth/session','DELETE').catch(()=>{})}
