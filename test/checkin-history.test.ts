import { expect,test } from 'bun:test'
import { CheckinService } from '../src/modules/checkins/service.ts'
import { checkinFixture } from './checkin-submit.test.ts'
import { NOW } from './migrations/fixture.ts'
test('checkin_history_restart_order: equal timestamps stable across pages and cursor bound to patient/principal',async()=>{
  const f=await checkinFixture(),service=new CheckinService(f.store,{codec:f.codec,clock:()=>new Date(NOW)})
  for(let i=0;i<3;i++)await service.submit(f.ctx('patient-a'),f.first.id,{message:`synthetic ${i}`})
  const page=await service.list(f.ctx('patient-a'),f.first.id,{limit:2})
  const last=await service.list(f.ctx('patient-a'),f.first.id,{limit:2,cursor:page.nextCursor!})
  expect(new Set([...page.items,...last.items].map(r=>r.id)).size).toBe(3)
  await expect(service.list(f.ctx('nurse-a'),f.first.id,{limit:2,cursor:page.nextCursor!})).rejects.toMatchObject({code:'validation_failed'})
  await expect(service.read(f.ctx('patient-b'),page.items[0]!.id)).rejects.toMatchObject({code:'not_found'})
  f.store.close()
  const restored=new CheckinService(f.reopen(),{codec:f.codec})
  expect((await restored.list(f.ctx('patient-a'),f.first.id,{limit:10})).items).toHaveLength(3)
})
