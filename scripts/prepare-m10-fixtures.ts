import {readPrivateJson,writePrivateJson} from '../src/security/private-files.cjs'
import {randomUUID,randomBytes} from 'node:crypto'
import {existsSync} from 'node:fs'
import {loadConfig} from '../src/config.ts'
import {Store} from '../src/storage/database.ts'
const fixtureFile=new URL('../data/m10-fixtures-private.json',import.meta.url),accounts=readPrivateJson(new URL('../data/local-demo-accounts.json',import.meta.url))
if(!process.argv.includes('--initialize'))throw Error('explicit_initialize_required')
const fixture=existsSync(fixtureFile)?readPrivateJson(fixtureFile):{runId:randomUUID(),createdAt:new Date().toISOString(),patients:[]}
const save=()=>writePrivateJson(fixtureFile,fixture);save()
const config=loadConfig(),store=Store.open({path:config.consoleStateDbPath,reviewPath:config.reviewDbPath}),sessions:string[]=[]
const call=(path:string,token:string|undefined,method='GET',body?:unknown,key?:string)=>fetch(`http://127.0.0.1:8080/api/v1/${path}`,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{ }),...(key?{'idempotency-key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})})
const data=async(response:Response)=>{if(!response.ok)throw Error(`fixture_request_${response.status}`);return(await response.json() as any).data}
const login=async(account:{identifier:string;password:string})=>{const grant=await data(await call('auth/login',undefined,'POST',{identifier:account.identifier,password:account.password}));sessions.push(grant.sessionToken);return grant}
let stage='nurse_login'
try{
 const nurse=await login(accounts.nurses[0]);stage='operator_login';const operator=await login(accounts.operator)
 fixture.nurseAccountId=nurse.principal.id;fixture.nativeVerified=false;fixture.scope='M10 synthetic only, original records preserved';save()
 for(const [slot,label] of [['high','H'],['low','L']]){
  let p=fixture.patients.find((v:any)=>v.slot===slot)
  if(!p){p={slot,label,displayName:`Pasien sintetis M10 ${label}`,identifier:`m10-${slot}-${fixture.runId}@synthetic.invalid`,password:randomBytes(32).toString('base64url'),createKey:randomUUID(),assignmentKey:randomUUID()};fixture.patients.push(p);save()}
  stage=`${slot}_profile`
  if(!p.patientId){const response=await data(await call('patients',nurse.sessionToken,'POST',{profile:{displayName:p.displayName},initialCondition:'DATA UJI SINTETIS M10, bukan pasien nyata.'},p.createKey));p.patientId=response.resource.id;p.createdVersion=response.resource.version;save()}
  stage=`${slot}_assignment`
  if(!p.assignmentId){const response=await data(await call(`patients/${p.patientId}/assignments`,operator.sessionToken,'POST',{nurseAccountId:nurse.principal.id,operation:'grant',expectedVersion:p.createdVersion},p.assignmentKey));p.assignmentId=response.resource.id;save()}
  stage=`${slot}_provision`
  if(!p.accountId){
   const existing=store.get<{id:string;patient_id:string}>('SELECT a.id,l.patient_id FROM accounts a JOIN patient_account_links l ON l.account_id=a.id WHERE a.identifier=?',[p.identifier])
   if(existing){if(existing.patient_id!==p.patientId)throw Error('fixture_link_mismatch');p.accountId=existing.id}
   else p.accountId=(await data(await call('accounts/patient-links',nurse.sessionToken,'POST',{patientId:p.patientId,identifier:p.identifier,activationInput:{password:p.password}}))).accountId
   save()
  }
  stage=`${slot}_login`;const patient=await login({identifier:p.identifier,password:p.password});if(patient.principal.patientId!==p.patientId)throw Error('fixture_identity_mismatch')
 }
 fixture.preparedAt=new Date().toISOString();save();
 const phase=process.argv.find(v=>v.startsWith('--runtime-phase='))?.split('=')[1];
 if(phase){if(!['identity_commit','identity_restore'].includes(phase))throw Error('unsupported_phase');writePrivateJson(new URL('../data/m10-e2e-private.json',import.meta.url),{phase,runId:fixture.runId,patients:fixture.patients.map((p:any)=>({identifier:p.identifier,password:p.password,patientId:p.patientId,slot:p.slot,uiReport:p.uiReport,baseline:p.sources.at(-1).confirmation}))});}
 console.log(JSON.stringify({result:'PASS',patients:fixture.patients.length,existingNurseAssignmentOnly:true,recordsDeleted:0,credentialsPrinted:false}))
}catch(error){console.error(JSON.stringify({result:'FAIL',stage,errorClass:error instanceof Error?error.name:'unknown',status:error instanceof Error&&/^fixture_request_\d{3}$/.test(error.message)?error.message:undefined,credentialsPrinted:false}));process.exitCode=1}
finally{for(const token of sessions)await call('auth/session',token,'DELETE').catch(()=>{});store.close()}
