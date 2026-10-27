import { existsSync,readFileSync,writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Store } from '../src/storage/database.ts'
import { loadConfig } from '../src/config.ts'
import { runFlow,startReviewJob,resumeReviewJob } from '../src/plugins/langflow.ts'
const config=loadConfig(),file=new URL('../data/m08-probe-private.json',import.meta.url),mode=process.argv[2]
const map=JSON.parse(readFileSync(new URL('../flows.json',import.meta.url),'utf8'))
const save=(data:unknown)=>writeFileSync(file,JSON.stringify(data,null,2))
const request=async(p:string)=>{const response=await fetch(`${config.langflowBaseUrl}${p}`,{headers:{'x-api-key':config.langflowApiKey},signal:AbortSignal.timeout(10000)});return{status:response.status,body:await response.json()}}
let data:Record<string,any>=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{}
try{
  if(mode==='start'){
    if(data.startAttempted)throw Error('existing_probe_do_not_restart')
    const store=Store.open({path:config.consoleStateDbPath})
    const source=store.get<{patient_id:string;id:string;output_json:string}>(`SELECT a.* FROM assessments a JOIN risk_confirmations c ON c.assessment_id=a.id JOIN patient_episode_heads h ON h.current_discharge_id=a.discharge_id WHERE a.state='SUCCEEDED' ORDER BY a.created_at DESC LIMIT 1`)
    store.close();if(!source)throw Error('missing_trusted_F1')
    const input={patient_id:source.patient_id,f1_scored_output:JSON.parse(source.output_json),followup_date:new Date(Date.now()+7*86400000).toISOString().slice(0,10),hotline:'Kontak demo sintetis, tidak menerima panggilan'}
    data={sessionId:`m08-probe-${randomUUID()}`,assessmentId:source.id,input,f3AttemptedAt:new Date().toISOString()};save(data)
    const result=await runFlow(map.f3_draft_followup_plan,JSON.stringify(input),{sessionId:data.sessionId})
    data.f3=result;save(data)
    const draft=JSON.parse(result.outputText??'null')
    if(draft?.status!=='DRAFT pending human approval'||draft.error||draft.patient_id!==source.patient_id)throw Error('F3_not_guarded')
    data.draft=draft;data.startAttempted=true;save(data)
    data.handle=await startReviewJob(map.f4_review_care_plan,JSON.stringify(draft),data.sessionId);save(data)
    console.log(JSON.stringify({result:'PASS',actualF3:true,startBound:!!data.handle.jobId,links:data.handle.links,status:data.handle.status,credentialsPrinted:false}))
  }else if(mode==='observe'){
    if(!data.handle?.jobId)throw Error('probe_handle_missing')
    data.snapshot=await request(`/api/v2/workflows?job_id=${encodeURIComponent(data.handle.jobId)}`);save(data)
    data.pending=await request(`/api/v2/workflows/pending?flow_id=${map.f4_review_care_plan}`);save(data)
    const s=data.snapshot.body,pending=Array.isArray(data.pending.body)?data.pending.body.filter((v:any)=>v.job_id===data.handle.jobId):[]
    console.log(JSON.stringify({result:'PASS',http:data.snapshot.status,keys:Object.keys(s),status:s.status,pending:pending.map((v:any)=>({jobId:v.job_id,sessionMatches:v.session_id===data.sessionId,requestId:v.request_id,options:v.options,allowed:v.allowed_decisions})),gate:s.human_request,output:s.output,credentialsPrinted:false}))
  }else if(mode==='finish'){
    const gate=data.snapshot?.body?.human_request??data.pending?.body?.find((v:any)=>v.job_id===data.handle.jobId)
    if(!gate?.request_id||data.decisionAttempted)throw Error('gate_missing_or_already_claimed')
    data.decisionAttempted=true;save(data)
    data.resume=await resumeReviewJob(data.handle.jobId,{request_id:gate.request_id,action_id:'escalate',actor:'m08-runtime-probe-synthetic',reviewer_note:'Pengujian teknis sintetis Q10, tanpa tindakan atau kontak nyata.'});save(data)
    console.log(JSON.stringify({result:'PASS',resumeStatus:data.resume.status,credentialsPrinted:false}))
  }else throw Error('choose_start_observe_finish')
}catch(error){console.error(JSON.stringify({result:'FAIL',mode,errorClass:error instanceof Error?error.name:'unknown',credentialsPrinted:false}));process.exitCode=1}
