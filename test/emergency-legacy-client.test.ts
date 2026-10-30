import {expect,test} from 'bun:test'
import {randomUUID} from 'node:crypto'
import {alertFixture} from './alert-fixture.ts'
import {createAlertRoutes} from '../src/modules/alerts/routes.ts'
test('legacy patient alert pages stay F2-only while new clients opt into manual requests',async()=>{
 const f=await alertFixture();const app=createAlertRoutes(f.auth,f.alerts)
 const patient=(await f.auth.login('patient-a@synthetic.invalid',f.password)).sessionToken
 const nurse=(await f.auth.login('nurse-a@synthetic.invalid',f.password)).sessionToken
 const path=`http://localhost/api/v1/patients/${f.first.id}/alerts?limit=1`
 const {alert:legacySource}=await f.create();f.advance(10)
 await f.alerts.requestEmergency({...f.ctx('patient-a'),idempotencyKey:randomUUID()},f.first.id,{reason:'Synthetic direct request'})
 const get=(url:string,token:string,optin=false)=>app.handle(new Request(url,{headers:{Authorization:`Bearer ${token}`,...(optin?{'X-SynCare-Alert-Sources':'all'}:{})}}))
 const legacy=await get(path,patient);expect(legacy.status).toBe(200);const legacyPage=await legacy.json()as any;expect(legacyPage.data.map((a:any)=>a.id)).toEqual([legacySource.id]);expect(legacyPage.nextCursor).toBeNull()
 const modern=await get(path,patient,true);expect(modern.status).toBe(200);const modernPage=await modern.json()as any;expect(modernPage.data[0].source.type).toBe('PATIENT_REQUEST');expect(modernPage.nextCursor).toBeTruthy()
 expect((await get(path+'&cursor='+encodeURIComponent(modernPage.nextCursor),patient)).status).toBe(422)
 const queue=await get('http://localhost/api/v1/alerts',nurse);expect(queue.status).toBe(200);expect((await queue.json()as any).data.map((a:any)=>a.source.type)).toEqual(['PATIENT_REQUEST','F2'])
})
