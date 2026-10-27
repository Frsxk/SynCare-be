import { randomUUID } from 'node:crypto'
import { checkinFixture } from './checkin-submit.test.ts'
import { PlanService } from '../src/modules/plans/service.ts'
export const makeDraft=(input:Record<string,any>)=>({patient_id:input.patient_id,tier:input.f1_scored_output.tier,status:'DRAFT pending human approval',label:'demo-heuristic-v1',missing_facts:[],disclaimer:'Data sintetis, belum divalidasi klinis.',plan_text:'Narasi F3 sintetis khusus unit test.',care_intensity:['Aktivitas dari fixture F3'],satuseshat:{careplan:{activity:['Aktivitas dari fixture F3']},servicerequest:{patientInstruction:`${input.followup_date}; ${input.hotline}`,priority:'routine'},task:[{code:'fixture',status:'requested',priority:'routine'}]},source_input:input})
export async function reviewFixture(){
  const f=await checkinFixture()
  await f.store.transaction(tx=>{for(const id of ['nurse-a','nurse-b'])tx.run('INSERT INTO capability_grants VALUES (?,?,?,?,?,?,?)',[randomUUID(),id,'review.decide','operator','2026-10-24T00:00:00.000Z',null,null])})
  const calls:string[]=[],plans=new PlanService(f.store,async input=>{calls.push(input);return{raw:{unit:true},outputText:JSON.stringify(makeDraft(JSON.parse(input))),sessionId:null}})
  const draft=async()=> (await plans.draft(f.ctx(),f.first.id,{assessmentId:f.assessment.id,followupDate:'2026-11-02',hotline:'Kontak demo sintetis'})).resource
  return{...f,plans,calls,draft}
}
