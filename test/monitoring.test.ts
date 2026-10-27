import { expect,test } from 'bun:test'
import { checkinFixture } from './checkin-submit.test.ts'
import { CheckinService } from '../src/modules/checkins/service.ts'
import { NOW } from './migrations/fixture.ts'
test('monitoring_scoped_latest: assigned-only bounded latest; revoked assignment removes response',async()=>{
  const f=await checkinFixture()
  const service=new CheckinService(f.store,{codec:f.codec,clock:()=>new Date(NOW)})
  const first=await service.submit(f.ctx('patient-a'),f.first.id,{message:'first synthetic'})
  const second=await service.submit(f.ctx('patient-a'),f.first.id,{message:'same-time synthetic'})
  await service.submit(f.ctx('patient-b'),f.second.id,{message:'foreign synthetic'})
  const page=await f.checkins.monitoring(f.ctx('nurse-a'),{limit:1})
  expect(page.items.map(r=>r.id)).toEqual([f.first.id])
  expect(page.items[0]?.latestReport?.id).toBe([first.resource.id,second.resource.id].sort().at(-1))
  await expect(f.checkins.monitoring(f.ctx('patient-a'),{limit:20})).rejects.toMatchObject({code:'forbidden'})
  await expect(f.checkins.monitoring(f.ctx('nurse-a'),{limit:101})).rejects.toMatchObject({code:'validation_failed'})
  await f.store.transaction(tx=>tx.run("UPDATE patient_assignments SET revoked_at=?,revoked_by='operator' WHERE nurse_account_id='nurse-a'",[new Date().toISOString()]))
  expect((await f.checkins.monitoring(f.ctx('nurse-a'),{limit:20})).items).toHaveLength(0)
})
