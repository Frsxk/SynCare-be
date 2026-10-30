import { expect,test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createAlertRoutes } from '../src/modules/alerts/routes.ts'
import { createApp } from '../src/app.ts'
import { alertFixture } from './alert-fixture.ts'

const uuid=()=>randomUUID()
const send=(app:{handle:(request:Request)=>Promise<Response>},path:string,token?:string,init:{method?:string;body?:unknown;key?:string|null;contentType?:string}={})=>
  app.handle(new Request(`http://localhost/api/v1/${path}`,{method:init.method??'GET',headers:{
    ...(token?{authorization:`Bearer ${token}`}:{}),
    'content-type':init.contentType??'application/json',
    ...(init.key===null?{}:{'idempotency-key':init.key??uuid()}),
  },...(init.body===undefined?{}:{body:typeof init.body==='string'?init.body:JSON.stringify(init.body)})}))

test('emergency route: 401/403/404, strict body/query/key, 201 mutation envelope and idempotent replay',async()=>{
  const f=await alertFixture(),app=createAlertRoutes(f.auth,f.alerts)
  const patient=(await f.auth.login('patient-a@synthetic.invalid',f.password)).sessionToken
  const foreign=(await f.auth.login('patient-b@synthetic.invalid',f.password)).sessionToken
  const nurse=(await f.auth.login('nurse-a@synthetic.invalid',f.password)).sessionToken
  const path=`patients/${f.first.id}/emergencies`
  expect((await send(app,path,undefined,{method:'POST',body:{reason:'Nyeri'}})).status).toBe(401)
  expect((await send(app,path,nurse,{method:'POST',body:{reason:'Nyeri'}})).status).toBe(403)
  expect((await send(app,`patients/${f.second.id}/emergencies`,patient,{method:'POST',body:{reason:'Nyeri'}})).status).toBe(404)
  expect((await send(app,path,patient,{method:'POST',body:{reason:'Nyeri'},key:null})).status).toBe(422)
  expect((await send(app,path,patient,{method:'POST',body:{reason:'Nyeri'},key:'not-a-uuid'})).status).toBe(422)
  expect((await send(app,`${path}?reason=query`,patient,{method:'POST',body:{reason:'Nyeri'}})).status).toBe(422)
  expect((await send(app,path,patient,{method:'POST',body:{reason:'Nyeri',extra:'x'}})).status).toBe(422)
  expect((await send(app,path,patient,{method:'POST',body:'{',contentType:'application/json'})).status).toBe(422)
  expect((await send(app,path,patient,{method:'POST',body:{reason:'Nyeri'},contentType:'text/plain'})).status).toBe(422)
  const key=uuid(),created=await send(app,path,patient,{method:'POST',body:{reason:'  Nyeri dada hebat  '},key})
  expect(created.status).toBe(201)
  expect(created.headers.get('cache-control')).toContain('no-store')
  const payload=await created.json() as {data:{resource:{id:string;source:{type:string;requestId:string;reason:string;reportedAt:string;outcomeAt:string};status:string;version:number};replayed:boolean};requestId:string}
  expect(payload.data.replayed).toBe(false)
  expect(payload.data.resource.source).toMatchObject({type:'PATIENT_REQUEST',action:'request_immediate_help',reason:'Nyeri dada hebat',requestId:payload.data.resource.id})
  expect(payload.data.resource.status).toBe('PENDING_REVIEW')
  const replay=await send(app,path,patient,{method:'POST',body:{reason:'  Nyeri dada hebat  '},key})
  expect(replay.status).toBe(201)
  expect((await replay.json() as {data:{replayed:boolean;resource:{id:string}}}).data).toMatchObject({replayed:true,resource:{id:payload.data.resource.id}})
  const queue=await send(app,'alerts',nurse)
  expect(queue.status).toBe(200)
  expect((await queue.json() as {data:{source:{type:string}}[]}).data.map(item=>item.source.type)).toEqual(['PATIENT_REQUEST'])
  const detail=await send(app,`alerts/${payload.data.resource.id}`,patient)
  expect(detail.status).toBe(200)
  expect(JSON.stringify(await detail.json())).not.toContain('internalNote')
  expect((await send(app,`alerts/${payload.data.resource.id}/actions`,nurse,{method:'POST',body:{action:'acknowledge',expectedVersion:1}})).status).toBe(200)
  expect((await send(app,`alerts/${payload.data.resource.id}/actions`,patient,{method:'POST',body:{action:'acknowledge',expectedVersion:2}})).status).toBe(403)
  expect((await send(app,`patients/${f.first.id}/emergencies`,foreign,{method:'POST',body:{reason:'Nyeri'}})).status).toBe(404)
  expect(f.store.all("SELECT * FROM alerts WHERE source_type='PATIENT_REQUEST'")).toHaveLength(1)
})

test('mounted application routes patient emergencies to the alert domain without weakening origin/auth gates',async()=>{
  const f=await alertFixture()
  const config={langflowBaseUrl:'http://127.0.0.1:59999',langflowApiKey:'EMERGENCY_SYNTHETIC_KEY',apiKey:'EMERGENCY_SYNTHETIC_KEY',
    reviewDbPath:import.meta.filename,consoleStateDbPath:f.store.path,host:'localhost',port:8080,readOnly:false}
  const app=createApp({store:f.store,auth:f.auth,cursorSecret:'emergency-test-cursor-key-longer-than-32-bytes',config,
    security:{backendOrigin:'http://localhost',webOrigin:'http://localhost:3000',allowLocalHttp:true},
    flows:{f1_register_discharge_summary:'11111111-1111-4111-8111-111111111111',f3_draft_followup_plan:'33333333-3333-4333-8333-333333333333',
      f4_review_care_plan:'44444444-4444-4444-8444-444444444444',f5_answer_care_questions:'55555555-5555-4555-8555-555555555555'},
    runFlowImpl:async()=>{throw Error('emergency request must not call a flow')}})
  const patient=(await f.auth.login('patient-a@synthetic.invalid',f.password)).sessionToken
  const nurse=(await f.auth.login('nurse-a@synthetic.invalid',f.password)).sessionToken
  const request=(path:string,token:string,init:{method?:string;body?:unknown;origin?:string}={})=>new Request(`http://localhost/api/v1/${path}`,{
    method:init.method??'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':uuid(),
      ...(init.origin?{origin:init.origin}:{})},...(init.body===undefined?{}:{body:JSON.stringify(init.body)})})
  const created=await app.handle(request(`patients/${f.first.id}/emergencies`,patient,{method:'POST',body:{reason:'Nyeri dada hebat'}}))
  expect(created.status).toBe(201)
  const resource=(await created.json() as {data:{resource:{id:string;source:{type:string}}}}).data.resource
  expect(resource.source.type).toBe('PATIENT_REQUEST')
  const queue=await app.handle(request('alerts',nurse))
  expect(queue.status).toBe(200)
  expect((await queue.json() as {data:{source:{type:string}}[]}).data.map(item=>item.source.type)).toEqual(['PATIENT_REQUEST'])
  expect((await app.handle(request(`alerts/${resource.id}`,nurse))).status).toBe(200)
  expect((await app.handle(request(`patients/${f.first.id}/emergencies`,patient,{method:'POST',body:{reason:'Nyeri'},origin:'http://evil.invalid'}))).status).toBe(403)
})
