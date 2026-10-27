import { expect,test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { homecareFixture,bookingInput } from './homecare-fixture.ts'
import { createHomecareRoutes } from '../src/modules/homecare/routes.ts'

test('API-H1-H4: actual sessions, own request, scoped review, replay, query limits and public note boundary',async()=>{
  const {bookings,auth,password,first,second}=await homecareFixture()
  const app=createHomecareRoutes(auth,bookings)
  const patient=(await auth.login('patient-a@synthetic.invalid',password)).sessionToken
  const nurse=(await auth.login('nurse-a@synthetic.invalid',password)).sessionToken
  const json=async(response:Response)=>(await response.json()) as {data:{resource:{id:string};replayed:boolean;status:string}}
  const send=(path:string,token=patient,method='GET',body?:unknown,key=randomUUID())=>app.handle(new Request(`http://localhost/api/v1/${path}`,{
    method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':key},...(body?{body:JSON.stringify(body)}:{})}))
  expect((await send('homecare/services')).status).toBe(200)
  expect((await send('homecare/services?limit=101')).status).toBe(422)
  expect((await send('homecare/services?limit=1&limit=2')).status).toBe(422)
  const key=randomUUID(),response=await send(`patients/${first.id}/bookings`,patient,'POST',bookingInput(),key)
  expect(response.status).toBe(201)
  expect(response.headers.get('cache-control')).toContain('no-store')
  const saved=(await json(response)).data.resource
  expect((await json(await send(`patients/${first.id}/bookings`,patient,'POST',bookingInput(),key))).data.resource.id).toBe(saved.id)
  expect((await send(`patients/${second.id}/bookings`,patient,'POST',bookingInput())).status).toBe(404)
  expect((await send('bookings',patient)).status).toBe(403)
  expect((await send('bookings',nurse)).status).toBe(200)
  const transitionKey=randomUUID()
  const review=()=>send(`bookings/${saved.id}/transitions`,nurse,'POST',{expectedVersion:1,toStatus:'Under Review'},transitionKey)
  expect((await review()).status).toBe(200)
  expect((await json(await review())).data.replayed).toBe(true)
  expect((await send(`bookings/${saved.id}/transitions`,nurse,'POST',{expectedVersion:1,toStatus:'Under Review'})).status).toBe(409)
  expect((await json(await send(`bookings/${saved.id}`))).data.status).toBe('Under Review')
  expect((await send('bookings?status=Unknown',nurse)).status).toBe(422)
  expect((await send('bookings?status=active&status=all',nurse)).status).toBe(422)
  expect((await send(`bookings/${saved.id}/transitions`,patient,'POST',{expectedVersion:2,toStatus:'Cancelled',reason:'Pembatalan dari pasien.'})).status).toBe(200)
  expect((await send('bookings?status=Cancelled',nurse)).status).toBe(200)
})
