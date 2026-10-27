import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { FlowGateway, validF2, type F2Context } from '../src/modules/workflows/flow-gateway.ts'
const code='synthetic scorer fixture'
const binding={flowId:'flow',scorerId:'scorer',scorerCodeSha256:createHash('sha256').update(code).digest('hex'),verifiedAt:'2026-10-25T00:00:00Z'}
export const routine=(id='p',baseline=1)=>({patient_id:id,baseline_score:baseline,baseline_tier:'LOW',adjustments:[],score:1,tier:'LOW',tier_changed:false,
  action:'continue_monitoring',next_checkin_days:7,extraction:{symptoms:[],medication_adherence:'regular',red_flag:false,quote_of_red_flag:''},label:'demo-heuristic-v1',disclaimer:'Synthetic unit fixture only'})
const context=(patientId:string,baselineScore:number):F2Context=>({patientId,baselineScore,message:'synthetic message',assessmentId:`f1-${patientId}`,sessionId:`session-${patientId}`})
test('f2_context_concurrent_isolated: A1/B7 alternate and concurrent; only server context supplies tweaks and shared defaults unchanged',async()=>{
  const calls:unknown[]=[]
  const node={id:binding.scorerId,data:{node:{template:{baseline_score:{value:7},patient_id:{value:'chf-high'},code:{value:code}}}}}
  const gateway=new FlowGateway({binding,baseUrl:'https://synthetic.invalid',apiKey:'unit-private',fetchImpl:(async()=>Response.json({id:'flow',data:{nodes:[node]}})) as unknown as typeof fetch,
    run:async(id,input,options)=>{calls.push({id,input,options});return{raw:{synthetic:true},outputText:'{}',sessionId:options.sessionId!}}})
  for(const c of [context('A',1),context('B',7),context('A',1)])await gateway.runF2(c)
  await Promise.all([gateway.runF2(context('A',1)),gateway.runF2(context('B',7))])
  expect(calls).toHaveLength(5)
  expect(calls[0]).toEqual({id:'flow',input:JSON.stringify({patient_id:'A',message:'synthetic message'}),options:{sessionId:'session-A',tweaks:{scorer:{patient_id:'A',baseline_score:1}}}})
  expect(node.data.node.template.baseline_score.value).toBe(7)
  await expect(gateway.runF2({...context('A',1),baselineScore:NaN})).rejects.toMatchObject({code:'dependency_unavailable'})
})
test('binding drift fails closed before invocation; strict outcomes reject missing and foreign baseline without scoring',async()=>{
  let calls=0
  const gateway=new FlowGateway({binding,baseUrl:'https://synthetic.invalid',apiKey:'unit',fetchImpl:(async()=>Response.json({id:'flow',data:{nodes:[]}})) as unknown as typeof fetch,
    run:async()=>{calls++;throw Error('must not run')}})
  await expect(gateway.runF2(context('A',1))).rejects.toMatchObject({code:'dependency_unavailable'})
  expect(calls).toBe(0)
  expect(validF2(JSON.stringify(routine('A',1)),context('A',1))).not.toBeNull()
  expect(validF2(JSON.stringify(routine('B',7)),context('A',1))).toBeNull()
  expect(validF2('{"action":"escalate_immediately","reason":"server quote"}',context('A',1))).toEqual({action:'escalate_immediately',reason:'server quote'})
  expect(validF2('{}',context('A',1))).toBeNull()
})
