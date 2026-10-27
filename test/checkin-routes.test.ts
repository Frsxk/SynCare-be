import { expect,test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createApp } from '../src/app.ts'
import { checkinFixture } from './checkin-submit.test.ts'
test('API M1/M2/M3/E4 public gateway commits before analysis; exact own identity, no injected context or guessed phone',async()=>{
  const f=await checkinFixture()
  const config={langflowBaseUrl:'https://synthetic.invalid',langflowApiKey:'unit',reviewDbPath:'unavailable',consoleStateDbPath:f.store.path,
    port:8080,host:'127.0.0.1',readOnly:false,apiKey:'fixture-master'}
  const app=createApp({config,security:{backendOrigin:'http://127.0.0.1:8080',webOrigin:'http://127.0.0.1:3000',allowLocalHttp:true},store:f.store,auth:f.auth,cursorSecret:'unit-secret-at-least-thirty-two-characters'})
  const patient=await f.auth.login('patient-a@synthetic.invalid',f.password)
  const nurse=await f.auth.login('nurse-a@synthetic.invalid',f.password)
  const request=(path:string,token:string,method='GET',body?:unknown,key=randomUUID())=>app.handle(new Request('http://127.0.0.1:8080/api/v1'+path,
    {method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':key},...(body===undefined?{}:{body:JSON.stringify(body)})}))
  const url=`/patients/${f.first.id}/checkins`,key=randomUUID()
  expect((await request(url,patient.sessionToken,'POST',{message:'x',baselineScore:7})).status).toBe(422)
  expect((await request(url,nurse.sessionToken,'POST',{message:'x'})).status).toBe(403)
  expect((await request(`/patients/${f.second.id}/checkins`,patient.sessionToken,'POST',{message:'x'})).status).toBe(404)
  const result=await request(url,patient.sessionToken,'POST',{message:'Synthetic report'},key)
  expect(result.status).toBe(202)
  expect(result.headers.get('cache-control')).toContain('no-store')
  const body=await result.json() as {data:{resource:{id:string;processing:{state:string}}}}
  expect(body.data.resource.processing.state).toBe('PENDING')
  expect((await request(url,patient.sessionToken,'POST',{message:'Synthetic report'},key)).status).toBe(202)
  expect(f.store.all('SELECT * FROM checkins')).toHaveLength(1)
  expect((await request(`/checkins/${body.data.resource.id}`,patient.sessionToken)).status).toBe(200)
  expect((await request(url+'?limit=1&limit=2',patient.sessionToken)).status).toBe(422)
  expect((await request('/monitoring',patient.sessionToken)).status).toBe(403)
  expect((await request('/monitoring',nurse.sessionToken)).status).toBe(200)
  expect((await request('/emergency-guidance',patient.sessionToken)).status).toBe(503)
})
