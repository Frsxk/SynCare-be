import { expect,test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { alertFixture } from './alert-fixture.ts'
import { createAlertRoutes } from '../src/modules/alerts/routes.ts'
test('API-E1/E2/E3: authenticated scoped queue/detail, no GET acknowledgment, exact body/queries and patient-safe pages',async()=>{
  const f=await alertFixture(),{alert}=await f.create(),app=createAlertRoutes(f.auth,f.alerts)
  const patient=(await f.auth.login('patient-a@synthetic.invalid',f.password)).sessionToken,nurse=(await f.auth.login('nurse-a@synthetic.invalid',f.password)).sessionToken,foreign=(await f.auth.login('nurse-b@synthetic.invalid',f.password)).sessionToken
  const send=(p:string,token=patient,method='GET',body?:unknown,key=randomUUID())=>app.handle(new Request(`http://localhost/api/v1/${p}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':key},...(body?{body:JSON.stringify(body)}:{})}))
  expect((await app.handle(new Request('http://localhost/api/v1/alerts'))).status).toBe(401)
  expect((await send('alerts')).status).toBe(403);expect((await send(`patients/${f.first.id}/alerts`)).status).toBe(200)
  expect((await send(`patients/${f.second.id}/alerts`)).status).toBe(404);expect((await send(`alerts/${alert.id}`,foreign)).status).toBe(404)
  for(const q of ['limit=101','status=INVALID','status=active&status=all','extra=1'])expect((await send(`alerts?${q}`,nurse)).status).toBe(422)
  expect((await send(`alerts/${alert.id}?status=active`,nurse)).status).toBe(422)
  const initial=await send(`alerts/${alert.id}`,nurse);expect(initial.status).toBe(200);expect(initial.headers.get('cache-control')).toContain('no-store')
  expect(f.alerts.read(f.ctx(),alert.id).status).toBe('PENDING_REVIEW')
  const key=randomUUID(),body={expectedVersion:1,action:'acknowledge',note:'Private nurse note'}
  expect((await send(`alerts/${alert.id}/actions`,patient,'POST',body)).status).toBe(403)
  expect((await send(`alerts/${alert.id}/actions`,nurse,'POST',{...body,actorId:'patient-a'})).status).toBe(422)
  expect((await send(`alerts/${alert.id}/actions`,nurse,'POST',body,key)).status).toBe(200)
  expect((await send(`alerts/${alert.id}/actions`,nurse,'POST',body)).status).toBe(409)
  const replay=await send(`alerts/${alert.id}/actions`,nurse,'POST',body,key);expect((await replay.json() as {data:{replayed:boolean}}).data.replayed).toBe(true)
  const projected=JSON.stringify(await (await send(`alerts/${alert.id}`)).json());expect(projected).not.toContain('internalNote');expect(projected).not.toContain('Private nurse note');expect(projected).toContain('ACKNOWLEDGED')
})
