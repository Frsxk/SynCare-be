import {readPrivateJson} from '../src/security/private-files.cjs'
import {existsSync,writeFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {runFlow} from '../src/plugins/langflow.ts'
const file=new URL('../data/m10-f3-guard-evidence.json',import.meta.url),fixture=readPrivateJson(new URL('../data/m10-fixtures-private.json',import.meta.url)),patient=fixture.patients.find((p:{slot:string})=>p.slot==='high'),original=patient.sources.at(-1).output,flows=readPrivateJson(new URL('../flows.json',import.meta.url))
const input={patient_id:patient.patientId,followup_date:new Date(Date.now()+7*86400000).toISOString().slice(0,10),hotline:'Kontak simulasi M10, tidak menerima panggilan',f1_scored_output:{...original,score:null,tier:null}},sessionId=`m10-guard:${randomUUID()}`
try{
 let evidence=existsSync(file)?readPrivateJson(file):null
 if(evidence&&evidence.runStatus!=='COMPLETED')throw Error('existing_execution_unknown')
 if(!evidence){
  writeFileSync(file,JSON.stringify({preparedAt:new Date().toISOString(),input,sessionId,runStatus:'STARTED'},null,2))
  const result=await runFlow(flows.f3_draft_followup_plan,JSON.stringify(input),{sessionId}),output=JSON.parse(result.outputText??'null')
  evidence={verifiedAt:new Date().toISOString(),actualF3:true,controlledMissingFacts:true,input,output,sessionId,runStatus:'COMPLETED',registeredAsApproved:false};writeFileSync(file,JSON.stringify(evidence,null,2))
 }
 const output=evidence.output
 if(!output||output.ok!==false||output.error!=='missing_or_invalid_facts'||typeof output.reason!=='string'||!output.reason||!Array.isArray(output.missing_facts)||output.plan_text)throw Error('guard_not_proven')
 writeFileSync(file,JSON.stringify({...evidence,guardVerified:true},null,2));console.log(JSON.stringify({result:'PASS',actualF3:true,missingFacts:output.missing_facts.length,guarded:true,noPublishedPlan:true,credentialsPrinted:false}))
}catch(error){console.error(JSON.stringify({result:'FAIL',errorClass:error instanceof Error?error.name:'unknown',credentialsPrinted:false}));process.exitCode=1}
