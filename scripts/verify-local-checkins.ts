import {readPrivateJson} from '../src/security/private-files.cjs'
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
interface Account {identifier:string;password:string}
const accounts=readPrivateJson(new URL('../data/local-demo-accounts.json',import.meta.url)) as {nurses:Account[];patients:Account[]}
const manifest=readPrivateJson(new URL('../data/local-demo-manifest.json',import.meta.url)) as {patients:{patientId:string}[]}
const base='http://127.0.0.1:8080/api/v1',tokens:string[]=[]
let checks=0
function check(value:unknown,label:string):asserts value {if(!value)throw Error(label);checks++}
async function login(account:Account){
  const response=await fetch(`${base}/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identifier:account.identifier,password:account.password})})
  check(response.ok,'login')
  const data=(await response.json() as {data:{sessionToken:string}}).data
  tokens.push(data.sessionToken);return data.sessionToken
}
const request=(path:string,token:string,method='GET',body?:unknown,key=randomUUID())=>fetch(base+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':key},...(body===undefined?{}:{body:JSON.stringify(body)})})
async function data<T>(response:Response):Promise<T>{check(response.ok,`http_${response.status}`);return(await response.json() as {data:T}).data}
interface Overview {profile:{id:string;version:number};confirmedRisk:{current:{assessmentId:string;score:number;category:string}|null}}
interface Report {id:string;patientId:string;message:string;baseline:{score:number;assessmentId:string}|null;processing:{state:string};outcome:{action:string;patient_id?:string;baseline_score?:number}|null;alertEvidence:string}
async function poll(token:string,id:string){
  for(let i=0;i<120;i++){
    const report=await data<Report>(await request(`/checkins/${id}`,token))
    if(!['PENDING','RUNNING'].includes(report.processing.state))return report
    await Bun.sleep(500)
  }
  throw Error('processing_timeout')
}
try{
  const nurseB=await login(accounts.nurses[1]!),patientA=await login(accounts.patients[0]!),patientB=await login(accounts.patients[1]!)
  const idA=manifest.patients[0]!.patientId,idB=manifest.patients[1]!.patientId
  const a=await data<Overview>(await request(`/patients/${idA}/overview`,patientA))
  let b=await data<Overview>(await request(`/patients/${idB}/overview`,nurseB))
  if(!b.confirmedRisk.current){
    const source=await data<{resource:{id:string}}>(await request(`/patients/${idB}/discharges`,nurseB,'POST',{
      sourceText:'DATA SINTETIS DEMO SYNCARE. BUKAN PASIEN NYATA. Diagnosis congestive heart failure (CHF). length_of_stay_days: 2. admission_type: emergency. comorbidity_count: 1. admissions_prior_12m: 0. Obat: furosemide 40 mg sekali sehari. Instruksi: pembatasan garam dan kontrol sesuai arahan dokter. Kebutuhan tindak lanjut: pemantauan gejala dan kepatuhan obat.',expectedPatientVersion:b.profile.version}))
    const assessment=await data<{id:string;version:number;state:string;output:{score:number;tier:string}}>(await request(`/discharges/${source.resource.id}/assessments`,nurseB,'POST',{}))
    check(assessment.state==='SUCCEEDED','actual_f1_succeeded')
    await data(await request(`/assessments/${assessment.id}/confirmations`,nurseB,'POST',{category:assessment.output.tier,expectedVersion:assessment.version}))
    b=await data<Overview>(await request(`/patients/${idB}/overview`,nurseB))
  }
  check(a.confirmedRisk.current&&b.confirmedRisk.current,'both_actual_baselines')
  check(a.confirmedRisk.current.score!==b.confirmedRisk.current.score,'different_actual_baselines')
  const guidance=await data<{contacts:{action:string;number:string}[];source:string;verifiedAt:string}>(await request('/emergency-guidance',patientA))
  check(guidance.contacts.every(c=>c.action==='information_only'),'no_phone_action')
  check(!!guidance.source&&!!guidance.verifiedAt,'guidance_provenance')
  check((await request(`/patients/${idB}/checkins`,patientA,'POST',{message:'foreign'})).status===404,'foreign_submit_denied')
  check((await request(`/patients/${idA}/checkins`,patientA,'POST',{message:'x',baselineScore:99})).status===422,'client_baseline_denied')
  const reports:Report[]=[]
  const submit=async(token:string,id:string,message:string,key=randomUUID())=>{
    const response=await request(`/patients/${id}/checkins`,token,'POST',{message},key)
    check(response.status===202,'committed_202')
    const saved=await data<{resource:Report}>(response)
    check(['PENDING','RUNNING','SUCCEEDED'].includes(saved.resource.processing.state),'saved_before_analysis')
    return saved.resource
  }
  const message='DATA SINTETIS. Hari ini merasa baik, tidak ada keluhan. Obat diminum teratur.',key=randomUUID()
  const first=await submit(patientA,idA,message,key)
  check((await submit(patientA,idA,message,key)).id===first.id,'same_key_one_report')
  const pair=await Promise.all([submit(patientA,idA,message),submit(patientB,idB,message)])
  for(const report of [first,...pair]){
    const result=await poll(report.patientId===idA?patientA:patientB,report.id)
    check(result.processing.state==='SUCCEEDED','actual_f2_complete')
    check(result.outcome?.patient_id===result.patientId,'actual_patient_echo')
    check(result.outcome?.baseline_score===result.baseline?.score,'actual_baseline_echo')
    reports.push(result)
  }
  const review=await submit(patientB,idB,'DATA SINTETIS. Dua keluhan ringan hari ini: batuk ringan dan bengkak ringan pada kaki. Beberapa dosis obat terlewat, minum obat tidak teratur.')
  const reviewResult=await poll(patientB,review.id)
  check(reviewResult.processing.state==='SUCCEEDED'&&reviewResult.outcome?.action==='trigger_plan_review','actual_plan_review_branch')
  check(reviewResult.alertEvidence==='not_applicable','plan_review_not_acute_alert')
  reports.push(reviewResult)
  const urgent=await submit(patientA,idA,'DATA SINTETIS. Saya mengalami sesak napas berat saat istirahat dan nyeri dada hebat sekarang.')
  const urgentResult=await poll(patientA,urgent.id)
  check(urgentResult.processing.state==='SUCCEEDED'&&urgentResult.outcome?.action==='escalate_immediately','actual_urgent_branch')
  check(urgentResult.alertEvidence==='queued','actual_alert_work_only')
  reports.push(urgentResult)
  check((await request(`/checkins/${first.id}`,patientB)).status===404,'foreign_detail_denied')
  const after=await data<Overview>(await request(`/patients/${idA}/overview`,patientA))
  check(after.confirmedRisk.current?.assessmentId===a.confirmedRisk.current.assessmentId,'f2_does_not_replace_f1_confirmation')
  writeFileSync(new URL('../data/m04-live-evidence.json',import.meta.url),JSON.stringify({verifiedAt:new Date().toISOString(),baselines:[a.confirmedRisk.current,b.confirmedRisk.current],reports,checks},null,2))
  console.log(JSON.stringify({checks,result:'PASS',actualBaselineScores:[a.confirmedRisk.current.score,b.confirmedRisk.current.score],reportIds:reports.map(r=>r.id),urgentAlert:'queued_not_received'}))
}catch(error){console.error(error instanceof Error?error.message:'verification_failed');process.exitCode=1}
finally{for(const token of tokens)await request('/auth/session',token,'DELETE').catch(()=>{});}
