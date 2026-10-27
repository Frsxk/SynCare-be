import { expect,test } from 'bun:test'
import { homecareFixture,bookingInput } from './homecare-fixture.ts'
import { NOW } from './migrations/fixture.ts'
import { createHomecareRoutes } from '../src/modules/homecare/routes.ts'

export async function scheduleFixture(){
  const f=await homecareFixture()
  await f.store.transaction(tx=>{for(const id of ['nurse-a','nurse-b'])tx.run('INSERT INTO homecare_staff VALUES (?,?,1,1)',[id,`Perawat sintetis ${id}`])})
  const request=async()=>{const row=(await f.bookings.request(f.ctx('patient-a'),f.first.id,bookingInput())).resource;return (await f.bookings.transition(f.ctx(),row.id,{expectedVersion:1,toStatus:'Under Review'})).resource}
  const scheduleInput=(version=2)=>({expectedVersion:version,toStatus:'Scheduled',assignedStaffId:'nurse-a',confirmedSlot:{startAt:'2030-01-01T17:00:00.000Z',endAt:'2030-01-01T18:00:00.000Z',timezone:'Asia/Jakarta'}})
  return {...f,request,scheduleInput}
}
test('schedule_atomic_overlap: separate rows race one winner; own staff list, midnight WIB and replay preserve exact slot',async()=>{
  const {bookings,ctx,first,second,request,scheduleInput,store}=await scheduleFixture()
  const staff=await bookings.staff(ctx(),first.id,{limit:20})
  expect(staff.items.map(s=>s.id)).toEqual(['nurse-a'])
  await expect(bookings.staff(ctx(),second.id,{limit:20})).rejects.toMatchObject({status:404})
  await expect(bookings.staff(ctx('patient-a'),first.id,{limit:20})).rejects.toMatchObject({status:403})
  const [a,b]=await Promise.all([request(),request()]),intent=ctx()
  const results=await Promise.allSettled([bookings.transition(intent,a.id,scheduleInput()),bookings.transition(ctx(),b.id,scheduleInput())])
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
  expect(results.filter(r=>r.status==='rejected').map(r=>(r as PromiseRejectedResult).reason.code)).toEqual(['booking_schedule_conflict'])
  const saved=await bookings.read(ctx('patient-a'),a.id)
  expect(saved).toMatchObject({status:'Scheduled',confirmedSlot:scheduleInput().confirmedSlot,assignedStaff:{id:'nurse-a'}})
  expect((await bookings.transition(intent,a.id,scheduleInput())).replayed).toBe(true)
  expect(store.all("SELECT * FROM booking_history WHERE to_status='Scheduled'")).toHaveLength(1)
  const adjacent={...scheduleInput(),confirmedSlot:{...scheduleInput().confirmedSlot,startAt:'2030-01-01T18:00:00.000Z',endAt:'2030-01-01T19:00:00.000Z'}}
  expect((await bookings.transition(ctx(),b.id,adjacent)).resource.status).toBe('Scheduled')
})

test('H5 actual scoped staff query validates duplicate/foreign/missing fields without exposing account secrets',async()=>{
  const {bookings,auth,password,first,second}=await scheduleFixture()
  const app=createHomecareRoutes(auth,bookings),token=(await auth.login('nurse-a@synthetic.invalid',password)).sessionToken
  const get=(query:string)=>app.handle(new Request(`http://localhost/api/v1/homecare/staff${query}`,{headers:{authorization:`Bearer ${token}`}}))
  const response=await get(`?patientId=${first.id}&limit=1`)
  expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('no-store')
  const body=await response.text();expect(body).toContain('Perawat sintetis nurse-a');expect(body).not.toContain('password');expect(body).not.toContain('identifier')
  expect((await get(`?patientId=${second.id}`)).status).toBe(404)
  for(const query of ['',`?patientId=${first.id}&patientId=${first.id}`,`?patientId=${first.id}&status=active`,`?patientId=${first.id}&limit=101`])expect((await get(query)).status).toBe(422)
})
test('schedule rejects cached revoked/unassigned staff and invalid interval; rollback leaves Under Review',async()=>{
  const {bookings,ctx,first,request,scheduleInput,store}=await scheduleFixture()
  const row=await request()
  for(const input of [{...scheduleInput(),assignedStaffId:'nurse-b'}, {...scheduleInput(),confirmedSlot:{...scheduleInput().confirmedSlot,endAt:scheduleInput().confirmedSlot.startAt}},
    {...scheduleInput(),confirmedSlot:{...scheduleInput().confirmedSlot,timezone:'UTC'}}]){
    await expect(bookings.transition(ctx(),row.id,input)).rejects.toMatchObject({status:422})
  }
  await store.transaction(tx=>tx.run("UPDATE homecare_staff SET active=0 WHERE account_id='nurse-a'"))
  expect((await bookings.staff(ctx(),first.id,{limit:20})).items).toEqual([])
  await expect(bookings.transition(ctx(),row.id,scheduleInput())).rejects.toMatchObject({status:422})
  await store.transaction(tx=>{
    tx.run("UPDATE homecare_staff SET active=1 WHERE account_id='nurse-a'")
    tx.run("CREATE TRIGGER fail_schedule BEFORE INSERT ON booking_history WHEN NEW.to_status='Scheduled' BEGIN SELECT RAISE(ABORT,'fixture'); END")
  })
  await expect(bookings.transition(ctx(),row.id,scheduleInput())).rejects.toThrow()
  expect(await bookings.read(ctx(),row.id)).toMatchObject({status:'Under Review',version:2,assignedStaff:null,confirmedSlot:null})
  expect(store.all("SELECT * FROM booking_history WHERE to_status='Scheduled'")).toHaveLength(0)
  await store.transaction(tx=>tx.run("UPDATE capability_grants SET revoked_at=?,revoked_by='operator' WHERE account_id='nurse-a' AND capability='booking.manage'",[NOW]))
  await expect(bookings.staff(ctx(),first.id,{limit:20})).rejects.toMatchObject({status:403})
})
