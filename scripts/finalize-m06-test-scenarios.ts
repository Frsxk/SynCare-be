import {readPrivateJson} from '../src/security/private-files.cjs'
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const accounts=readPrivateJson(new URL('../data/local-demo-accounts.json',import.meta.url)) as {nurses:{identifier:string;password:string}[]}
const apply=process.argv.includes('--apply'),since='2026-10-25T17:33:35.000Z'
let token:string|undefined
const call=(path:string,method='GET',body?:unknown)=>fetch(`http://127.0.0.1:8080/api/v1/${path}`,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}) ,...(method==='POST'?{'idempotency-key':randomUUID()}:{})},...(body?{body:JSON.stringify(body)}:{})})
try{
  const account=accounts.nurses[0]!,login=await call('auth/login','POST',{identifier:account.identifier,password:account.password});if(login.status!==200)throw Error('login_failed');token=(await login.json() as {data:{sessionToken:string}}).data.sessionToken
  const response=await call('bookings?status=active&limit=100');if(response.status!==200)throw Error('queue_unavailable')
  const rows=(await response.json() as {data:{id:string;version:number;status:string;visitNote:string;createdAt:string}[]}).data
  const owned=rows.filter(row=>Date.parse(row.createdAt)>=Date.parse(since)&&(row.visitNote.startsWith('DATA UJI M06:')||row.visitNote==='Pengajuan sintetis browser.'))
  let closed=0,conflicts=0
  for(const row of owned){if(!apply)continue;const result=await call(`bookings/${row.id}/transitions`,'POST',{expectedVersion:row.version,toStatus:'Cancelled',reason:'Penutupan skenario verifikasi M06/regresi yang sudah selesai dijalankan. Seluruh histori pengujian dipertahankan.'});if(result.status===200)closed++;else if(result.status===409)conflicts++;else throw Error('test_closure_failed')}
  if(apply)writeFileSync(new URL('../data/m06-test-finalization.json',import.meta.url),JSON.stringify({verifiedAt:new Date().toISOString(),candidateIds:owned.map(row=>row.id),closed,conflicts,recordsDeleted:0,onlyNewOwnedTestScenarios:true},null,2))
  console.log(JSON.stringify({status:'pass',mode:apply?'apply':'preview',candidates:owned.length,closed,conflicts,recordsDeleted:0,credentialsPrinted:false}))
}catch{console.error(JSON.stringify({status:'fail',credentialsPrinted:false}));process.exitCode=1}
finally{if(token)await call('auth/session','DELETE').catch(()=>{})}
