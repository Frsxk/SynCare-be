import {readPrivateJson} from '../src/security/private-files.cjs'
import {randomUUID} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {loadConfig} from '../src/config.ts'
import {Store} from '../src/storage/database.ts'
const file=new URL('../data/m10-fixtures-private.json',import.meta.url),fixture=readPrivateJson(file),accounts=readPrivateJson(new URL('../data/local-demo-accounts.json',import.meta.url)),sessions:string[]=[],checks:string[]=[]
const save=()=>writeFileSync(file,JSON.stringify(fixture,null,2)),check=(condition:unknown,name:string)=>{if(!condition)throw Error(name);checks.push(name)}
const config=loadConfig(),store=Store.open({path:config.consoleStateDbPath,reviewPath:config.reviewDbPath})
const request=(path:string,token:string,method='GET',body?:unknown,key?:string)=>fetch(`http://127.0.0.1:8080/api/v1/${path}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...(key?{'idempotency-key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})})
async function data(response:Response):Promise<any>{check(response.ok,`http_${response.status}`);return(await response.json() as any).data}
async function login(account:any){const response=await fetch('http://127.0.0.1:8080/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identifier:account.identifier,password:account.password})}),grant=await data(response);sessions.push(grant.sessionToken);return grant.sessionToken as string}
let stage='login'
try{
 const tokens=new Map<string,string>();for(const p of fixture.patients)tokens.set(p.patientId,await login(p));const nurse=await login(accounts.nurses[0]),unassignedNurse=await login(accounts.nurses[1]);
 for(const p of fixture.patients)check((await request(`patients/${p.patientId}/overview`,unassignedNurse)).status===404,'unassigned_nurse_denied');
 const submit=async(p:any,kind:string)=>{
  p.apiReports??=[];let intent=p.apiReports.find((r:any)=>r.kind===kind)
  if(!intent){intent={kind,key:randomUUID(),message:`DATA SINTETIS M10 ${fixture.runId} ${p.slot} ${kind}. Hari ini merasa baik, tidak ada keluhan. Obat diminum teratur.`};p.apiReports.push(intent);save()}
  const result=await data(await request(`patients/${p.patientId}/checkins`,tokens.get(p.patientId)!,'POST',{message:intent.message},intent.key));
  if(intent.id)check(intent.id===result.resource.id,'resume_original_id');intent.id=result.resource.id;save();return {p,intent}
 }
 stage='alternating';for(const p of fixture.patients)await submit(p,'alternating');
 stage='concurrent';await Promise.all(fixture.patients.map((p:any)=>submit(p,'concurrent')));
 stage='real_F2';for(const p of fixture.patients){for(const intent of p.apiReports){
  let report:any;for(let i=0;i<180;i++){report=await data(await request(`checkins/${intent.id}`,tokens.get(p.patientId)!));if(!['RUNNING','PENDING'].includes(report.processing.state))break;await Bun.sleep(500)}
  check(report.processing.state==='SUCCEEDED','real_F2_succeeded');const baseline=p.sources.at(-1).confirmation;
  check(report.patientId===p.patientId&&report.baseline.assessmentId===baseline.assessmentId&&report.baseline.score===baseline.score,'persisted_baseline_bound');
  check(report.outcome.patient_id===p.patientId&&report.outcome.baseline_score===baseline.score,'real_F2_identity_echo');check(report.outcome.action!=='escalate_immediately','routine_not_acute');
  const replay=await data(await request(`patients/${p.patientId}/checkins`,tokens.get(p.patientId)!,'POST',{message:intent.message},intent.key));check(replay.resource.id===report.id&&replay.replayed===true,'same_key_single_effect');
  check(store.get<{count:number}>('SELECT count(*) AS count FROM checkins WHERE patient_id=? AND message=?',[p.patientId,intent.message])?.count===1,'stored_once');
  const nurseCopy=await data(await request(`checkins/${report.id}`,nurse));check(JSON.stringify(nurseCopy)===JSON.stringify(report),'same_nurse_patient_projection');intent.record=report;save();
 }
 const overview=await data(await request(`patients/${p.patientId}/overview`,tokens.get(p.patientId)!));check(overview.confirmedRisk.current.assessmentId===p.sources.at(-1).assessmentId,'F1_confirmation_preserved');
 check(p.apiReports[0].id!==p.apiReports[1].id,'genuine_same_day_new_report');}
 check(fixture.patients[0].sources.at(-1).output.score!==fixture.patients[1].sources.at(-1).output.score,'two_actual_baselines');
 const [a,b]=fixture.patients;check((await request(`patients/${b.patientId}/checkins`,tokens.get(a.patientId)!,'POST',{message:'foreign'},randomUUID())).status===404,'foreign_submit_denied');
 check((await request(`patients/${a.patientId}/checkins`,tokens.get(a.patientId)!,'POST',{message:'synthetic',baselineScore:99},randomUUID())).status===422,'client_baseline_denied');
 fixture.monitoringVerifiedAt=new Date().toISOString();save();writeFileSync(new URL('../data/m10-monitoring-evidence.json',import.meta.url),JSON.stringify({verifiedAt:fixture.monitoringVerifiedAt,checks,realF2Reports:4,concurrent:2,alternate:2,oldRecordsDeleted:0},null,2));console.log(JSON.stringify({result:'PASS',checks:checks.length,actualF2Reports:4,credentialsPrinted:false}));
}catch(error){console.error(JSON.stringify({result:'FAIL',stage,checksCompleted:checks.length,errorClass:error instanceof Error?error.name:'unknown',check:error instanceof Error&&/^[a-zA-Z0-9_]+$/.test(error.message)?error.message:undefined,credentialsPrinted:false}));process.exitCode=1}
finally{for(const token of sessions)await request('auth/session',token,'DELETE').catch(()=>{});store.close()}
