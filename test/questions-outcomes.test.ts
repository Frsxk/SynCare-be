import {expect,test} from 'bun:test'
import {normalizeAnswer,F5_REFUSAL,F5_DISCLAIMER} from '../src/modules/questions/contracts.ts'
const patient='patient-a'
const citation=(id:string,label='rencana_disetujui_workflow_sintetis')=>`[${id} | ${label}]`
test('qa_multiple_provenance: preserves exact answer and all citation labels without treating education as approved',()=>{
  const text=`${F5_DISCLAIMER} Aktivitas satu. ${citation(`${patient}:care_intensity:0#1`)} Edukasi dua. ${citation('hf-aftercare:section:0#1','draf_edukasi_tidak_disetujui')} Aktivitas tiga. ${citation(`${patient}:plan_text#2`)}`
  const value=normalizeAnswer(text,patient)
  expect(value.kind).toBe('answer');if(value.kind!=='answer')throw Error('answer_expected')
  expect(value.text).toBe(text);expect(value.citations).toHaveLength(3);expect(value.citations[1]?.provenance).toBe('unapproved_education');expect(value.disclaimer).toBe(F5_DISCLAIMER)
  expect(normalizeAnswer(F5_REFUSAL,patient)).toEqual({kind:'refusal',text:F5_REFUSAL})
})
test('qa_structural_boundary: unknown, foreign, malformed or JSON outputs never become narrative answers',()=>{
  for(const output of [null,'',{},'Unknown narrative',JSON.stringify({unexpected:true}),`${F5_DISCLAIMER} ${citation('patient-b:plan_text#1')}`,`${F5_DISCLAIMER} [broken]`,`${F5_DISCLAIMER} ${citation(`${patient}:plan_text#1`,'unknown')}`])expect(()=>normalizeAnswer(output,patient)).toThrow()
})
test('qa_urgent_independent_of_alert: actual F5 action is typed without lexical triage or invented alert state',()=>{
  expect(normalizeAnswer(JSON.stringify({action:'escalate_immediately',reason:'Saya mengalami nyeri dada.'}),patient)).toEqual({kind:'emergency',reason:'Saya mengalami nyeri dada.',guidance:null})
  expect(()=>normalizeAnswer(JSON.stringify({action:'escalate_immediately',reason:''}),patient)).toThrow()
})
test('retrieval and model failure diagnostics are codes, never raw patient narrative or credential-bearing reason',()=>{
  const value=normalizeAnswer(JSON.stringify({ok:false,kind:'error',error:'retrieval_failed',reason:'PRIVATE fixture credential and path'}),patient)
  expect(value).toEqual({kind:'error',code:'retrieval_failed'});expect(JSON.stringify(value)).not.toContain('PRIVATE')
  expect(normalizeAnswer(JSON.stringify({kind:'error',error:'invalid_generated_selection',reason:'private'}),patient)).toEqual({kind:'error',code:'invalid_generated_selection'})
})
