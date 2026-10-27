import {Database} from 'bun:sqlite'
import {expect,test} from 'bun:test'
import {patientFixture} from './patients.test.ts'
import {canonicalFixture} from './approval-evidence.test.ts'
import {QuestionService} from '../src/modules/questions/service.ts'
import {QuestionGrounding} from '../src/modules/questions/grounding.ts'
import {createQuestionRoutes} from '../src/modules/questions/routes.ts'
import {F5_REFUSAL,F5_DISCLAIMER,normalizeAnswer} from '../src/modules/questions/contracts.ts'
const result=(outputText:string)=>({raw:{private:'not published'},outputText,sessionId:null})
test('f5_patient_scope: rejects foreign identity and injected session before upstream; unique alternating sessions and revoked access',async()=>{
  const f=await patientFixture(),calls:{patient:string;session:string}[]=[],service=new QuestionService(f.store,{verify:async()=>{},grounding:{validate:()=>{}},runF5:async(input,session)=>{calls.push({patient:JSON.parse(input).patient_id,session});return result(F5_REFUSAL)}})
  await expect(service.ask(f.ctx('patient-a'),f.second.id,{query:'other'})).rejects.toMatchObject({status:404})
  await expect(service.ask(f.ctx('patient-a'),f.first.id,{query:'own',sessionId:'forged'})).rejects.toMatchObject({status:422});expect(calls).toHaveLength(0)
  for(const [principal,id] of [['patient-a',f.first.id],['patient-b',f.second.id],['patient-a',f.first.id]])expect(await service.ask(f.ctx(principal),id!,{query:'Own plan?'})).toEqual({kind:'refusal',text:F5_REFUSAL})
  expect(new Set(calls.map(c=>c.session)).size).toBe(3);expect(calls.map(c=>c.patient)).toEqual([f.first.id,f.second.id,f.first.id])
  await f.store.transaction(tx=>tx.run('UPDATE patient_assignments SET revoked_at=?,revoked_by=? WHERE patient_id=?',['2026-10-25T00:00:00Z','operator',f.first.id]))
  await expect(service.ask(f.ctx(),f.first.id,{query:'own'})).rejects.toMatchObject({status:404});expect(calls).toHaveLength(3)
})
test('same-patient retrieval serializes while distinct patients can proceed; authority rechecked after suspended upstream',async()=>{
  const f=await patientFixture();let release!:()=>void,started=0,active=0,peak=0
  const hold=new Promise<void>(resolve=>{release=resolve}),service=new QuestionService(f.store,{verify:async()=>{},grounding:{validate:()=>{}},runF5:async()=>{started++;active++;peak=Math.max(peak,active);if(started===1)await hold;active--;return result(F5_REFUSAL)}})
  const first=service.ask(f.ctx(),f.first.id,{query:'one'}),second=service.ask(f.ctx(),f.first.id,{query:'two'});await Bun.sleep(10);expect(started).toBe(1)
  expect((await service.ask(f.ctx('nurse-b'),f.second.id,{query:'other patient'})).kind).toBe('refusal');expect(peak).toBe(2)
  const outcomes=Promise.allSettled([first,second])
  await f.store.transaction(tx=>tx.run('UPDATE patient_assignments SET revoked_at=?,revoked_by=? WHERE patient_id=?',['2026-10-25T00:00:00Z','operator',f.first.id]));release()
  for(const outcome of await outcomes){expect(outcome.status).toBe('rejected');if(outcome.status==='rejected')expect(outcome.reason.status).toBe(404)}expect(started).toBe(2)
})
test('approvedrowwithoutaudit fails grounding; exact registered approval required and altered quote/latest row rejected',async()=>{
  const f=await canonicalFixture(),grounding=new QuestionGrounding(f.store,f.path),text=`${F5_DISCLAIMER} ${f.draft.artifact!.care_intensity[0]}. [${f.first.id}:care_intensity:0#1 | rencana_disetujui_workflow_sintetis]`
  const validText=text.replace('fixture F3.','fixture F3'),answer=normalizeAnswer(validText,f.first.id);if(answer.kind!=='answer')throw Error('expected_answer')
  await f.approve();f.write(false);expect(()=>grounding.validate(f.first.id,answer)).toThrow()
  const db=new Database(f.path);db.query('DELETE FROM approved_plans').run();db.close();f.write();f.finish();await f.reconciler.reconcile(f.review.id)
  expect(()=>grounding.validate(f.first.id,answer)).not.toThrow()
  expect(()=>grounding.validate(f.first.id,{...answer,citations:answer.citations.map(c=>({...c,quote:'invented treatment'}))})).toThrow()
  const changed=new Database(f.path);changed.query('INSERT INTO approved_plans VALUES (?,?,?)').run(JSON.stringify({...f.draft.artifact,plan_text:'unregistered newer artifact'}),'2099-01-01T00:00:00Z','');changed.close()
  expect(()=>grounding.validate(f.first.id,answer)).toThrow()
})
test('typed routes preserve refusal and emergency without raw fields; session revoked during upstream has no patient response',async()=>{
  const f=await patientFixture();let revoke=false
  const service=new QuestionService(f.store,{verify:async()=>{},grounding:{validate:()=>{throw Error('must_not_read_for_urgent')}},runF5:async()=>{if(revoke)await f.auth.revoke((await f.auth.inspect(token)).sessionId);return result(revoke?F5_REFUSAL:JSON.stringify({action:'escalate_immediately',reason:'Nyeri dada sintetis.'}))}})
  const routes=createQuestionRoutes(f.auth,service),grant=await f.auth.login('patient-a@synthetic.invalid',f.password),token=grant.sessionToken
  const call=(body:unknown)=>routes.handle(new Request(`http://localhost/api/v1/patients/${f.first.id}/questions`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)}))
  const response=await call({query:'question'});expect(response.status).toBe(200);const body=await response.json() as any
  expect(body.data).toEqual({kind:'emergency',reason:'Nyeri dada sintetis.',guidance:null});expect(response.headers.get('cache-control')).toContain('no-store');expect(JSON.stringify(body)).not.toContain('raw')
  expect((await call({query:'question',patientId:f.second.id})).status).toBe(422)
  revoke=true;expect((await call({query:'question'})).status).toBe(401)
})
test('upstream failure and unavailable verification are honest errors without manufactured medical fallback',async()=>{
  const f=await patientFixture(),service=new QuestionService(f.store,{verify:async()=>{},grounding:{validate:()=>{}},runF5:async()=>{throw Error('PRIVATE upstream secret')}})
  await expect(service.ask(f.ctx('patient-a'),f.first.id,{query:'own'})).rejects.toMatchObject({code:'dependency_unavailable'})
})
