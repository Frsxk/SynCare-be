import { expect,test } from 'bun:test'
import { scheduleFixture } from './booking-schedule.test.ts'

test('cancel_schedule_race: either actor can win once, stale loser409, current Scheduled patient cancel403',async()=>{
  const {bookings,ctx,request,scheduleInput,store}=await scheduleFixture()
  for(const patientFirst of [false,true]){
    const row=await request(),slot=patientFirst?{...scheduleInput(),confirmedSlot:{...scheduleInput().confirmedSlot,startAt:'2030-01-01T19:00:00.000Z',endAt:'2030-01-01T20:00:00.000Z'}}:scheduleInput()
    const schedule=()=>bookings.transition(ctx(),row.id,slot),cancel=()=>bookings.transition(ctx('patient-a'),row.id,{expectedVersion:2,toStatus:'Cancelled',reason:'Pembatalan sintetis oleh pasien.'})
    const results=await Promise.allSettled(patientFirst?[cancel(),schedule()]:[schedule(),cancel()])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect(results.filter(r=>r.status==='rejected').map(r=>(r as PromiseRejectedResult).reason.code)).toEqual(['version_conflict'])
    const current=await bookings.read(ctx('patient-a'),row.id)
    expect(current.version).toBe(3);expect(current.timeline).toHaveLength(3)
    if(current.status==='Scheduled')await expect(bookings.transition(ctx('patient-a'),row.id,{expectedVersion:3,toStatus:'Cancelled',reason:'Tidak diizinkan.'})).rejects.toMatchObject({status:403})
  }
  expect(store.all("SELECT * FROM booking_history WHERE to_status IN ('Scheduled','Cancelled')")).toHaveLength(2)
})
test('terminal exact roles/reason, same-key replay and terminal lock preserve patient-safe history',async()=>{
  const {bookings,ctx,request,scheduleInput,store}=await scheduleFixture()
  const row=await request()
  await expect(bookings.transition(ctx(),row.id,{expectedVersion:2,toStatus:'Rejected',reason:''})).rejects.toMatchObject({status:422})
  await expect(bookings.transition(ctx('patient-a'),row.id,{expectedVersion:2,toStatus:'Rejected',reason:'Not allowed'})).rejects.toMatchObject({status:403})
  const intent=ctx(),input={expectedVersion:2,toStatus:'Rejected',reason:'Permintaan simulasi tidak dapat dipenuhi.'}
  const saved=await bookings.transition(intent,row.id,input)
  expect(saved.resource.status).toBe('Rejected')
  expect((await bookings.transition(intent,row.id,input)).replayed).toBe(true)
  expect((await bookings.read(ctx('patient-a'),row.id)).timeline.at(-1)?.reason).toBe(input.reason)
  expect(JSON.stringify(await bookings.read(ctx('patient-a'),row.id))).not.toContain('internalNote')
  await expect(bookings.transition(ctx(),row.id,{expectedVersion:3,toStatus:'Cancelled',reason:'Reopen'})).rejects.toMatchObject({status:409})
  const scheduled=await request();await bookings.transition(ctx(),scheduled.id,scheduleInput())
  expect((await bookings.transition(ctx(),scheduled.id,{expectedVersion:3,toStatus:'Cancelled',reason:'Perawat membatalkan simulasi.'})).resource).toMatchObject({status:'Cancelled',assignedStaff:{id:'nurse-a'},confirmedSlot:scheduleInput().confirmedSlot})
  expect(store.all("SELECT * FROM booking_history WHERE to_status='Rejected'")).toHaveLength(1)
})
