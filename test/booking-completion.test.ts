import { expect,test } from 'bun:test'
import { scheduleFixture } from './booking-schedule.test.ts'
import { BookingService } from '../src/modules/homecare/request.ts'

test('completion_requires_scheduled: required note/actual nonfuture time, one committed event/replay and public closure data',async()=>{
  const {bookings,ctx,request,scheduleInput,store,codec}=await scheduleFixture()
  const row=await request()
  const complete={expectedVersion:2,toStatus:'Completed',completedAt:'2030-01-01T18:05:00.000Z',completionNote:'Kunjungan simulasi selesai; bukan kesimpulan pasien pulih.'}
  await expect(bookings.transition(ctx(),row.id,complete)).rejects.toMatchObject({status:422})
  await bookings.transition(ctx(),row.id,scheduleInput())
  const after=new BookingService(store,{codec,clock:()=>new Date('2030-01-01T19:00:00.000Z')})
  const valid={...complete,expectedVersion:3}
  for(const patch of [{completionNote:''},{completedAt:'2030-01-01T20:00:00.000Z'},{completedAt:'2030-01-01T16:59:00.000Z'},{completedAt:'invalid'}]){
    await expect(after.transition(ctx(),row.id,{...valid,...patch})).rejects.toMatchObject({status:422})
  }
  const intent=ctx(),saved=await after.transition(intent,row.id,valid)
  expect(saved.resource).toMatchObject({status:'Completed',completedAt:valid.completedAt,completionNote:valid.completionNote,version:4})
  expect((await after.transition(intent,row.id,valid)).replayed).toBe(true)
  expect(store.all("SELECT * FROM booking_history WHERE to_status='Completed'")).toHaveLength(1)
  expect(JSON.stringify(await after.read(ctx('patient-a'),row.id))).not.toContain('internalNote')
  await expect(after.transition(ctx(),row.id,{expectedVersion:4,toStatus:'Under Review'})).rejects.toMatchObject({status:409})
})
test('completion denied actor/history failure cannot partially close a visit',async()=>{
  const {bookings,ctx,request,scheduleInput,store,codec}=await scheduleFixture()
  const row=await request();await bookings.transition(ctx(),row.id,scheduleInput())
  const after=new BookingService(store,{codec,clock:()=>new Date('2030-01-01T19:00:00.000Z')})
  const input={expectedVersion:3,toStatus:'Completed',completedAt:'2030-01-01T18:05:00.000Z',completionNote:'Catatan sintetis untuk pasien.'}
  await expect(after.transition(ctx('patient-a'),row.id,input)).rejects.toMatchObject({status:403})
  await expect(after.transition(ctx('nurse-b'),row.id,input)).rejects.toMatchObject({status:404})
  await store.transaction(tx=>tx.run("CREATE TRIGGER fail_completion BEFORE INSERT ON booking_history WHEN NEW.to_status='Completed' BEGIN SELECT RAISE(ABORT,'fixture'); END"))
  await expect(after.transition(ctx(),row.id,input)).rejects.toThrow()
  expect(await after.read(ctx(),row.id)).toMatchObject({status:'Scheduled',version:3,completedAt:null,completionNote:null})
})
