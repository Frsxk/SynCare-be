import { expect,test } from 'bun:test'
import { gateFixture } from './review-decision.test.ts'
import { ReviewService } from '../src/modules/reviews/service.ts'
import { createPlanRoutes } from '../src/modules/plans/routes.ts'
test('review_cursor_resync: persisted snapshot survives client disconnect; foreign job denied, bad cursor resyncs, revoked stream stops',async()=>{
  const f=await gateFixture(),service=new ReviewService(f.store,{codec:f.codec,gateway:f.gateway,reviewDbPath:`${f.store.path}.absent`,runF3:async()=>{throw Error('not_called')}})
  const routes=createPlanRoutes(f.auth,service),nurse=await f.auth.login('nurse-a@synthetic.invalid',f.password),other=await f.auth.login('nurse-b@synthetic.invalid',f.password)
  const call=(path:string,token=nurse.sessionToken,headers:Record<string,string>={})=>routes.handle(new Request(`http://localhost/api/v1/${path}`,{headers:{authorization:`Bearer ${token}`,...headers}}))
  const response=await call(`reviews/${f.review.id}`);expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('no-store')
  expect((await call(`reviews/${f.review.id}`,other.sessionToken)).status).toBe(404)
  expect((await call(`reviews?patientId=${f.first.id}&limit=1&limit=2`)).status).toBe(422)
  const page=await call(`reviews?patientId=${f.first.id}&limit=1`);expect((await page.json() as {data:unknown[]}).data).toHaveLength(1)
  const stream=await call(`reviews/${f.review.id}/stream`,nurse.sessionToken,{'Last-Event-ID':'foreign:999999'}),reader=stream.body!.getReader()
  const first=new TextDecoder().decode((await reader.read()).value)
  expect(first).toContain(`id: ${f.review.id}:${f.review.version}`);expect(first).toContain('WAITING_FOR_HUMAN')
  await reader.cancel();expect(service.read(f.ctx(),f.review.id).state).toBe('WAITING_FOR_HUMAN')
  const live=await call(`reviews/${f.review.id}/stream`),liveReader=live.body!.getReader();await liveReader.read()
  await f.store.transaction(tx=>tx.run('UPDATE patient_assignments SET revoked_at=?,revoked_by=? WHERE nurse_account_id=?',[new Date().toISOString(),'operator','nurse-a']))
  let tail='';for(let i=0;i<5;i++){const part=await liveReader.read();if(part.done)break;tail+=new TextDecoder().decode(part.value)}
  expect(tail).toContain('session_or_scope_unavailable');expect(tail).not.toContain(f.first.id);await liveReader.cancel()
  expect((await call(`reviews/${f.review.id}`)).status).toBe(404)
})
