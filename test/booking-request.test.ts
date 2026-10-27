import { expect,test } from 'bun:test'
import { homecareFixture,bookingInput } from './homecare-fixture.ts'
import { BookingService } from '../src/modules/homecare/request.ts'

test('booking_lost_response_replayed_once: own scope, commit receipt and same key survive lost response',async()=>{
  const {bookings,ctx,first,second,store,reopen,codec}=await homecareFixture()
  const intent=ctx('patient-a'),input=bookingInput()
  const saved=await bookings.request(intent,first.id,input)
  expect(saved.resource).toMatchObject({status:'Requested',version:1,patientId:first.id,confirmedSlot:null,assignedStaff:null})
  expect((await bookings.request(intent,first.id,input))).toMatchObject({resource:{id:saved.resource.id},replayed:true})
  expect(store.all('SELECT * FROM bookings')).toHaveLength(1)
  expect(store.all('SELECT * FROM booking_history')).toHaveLength(1)
  await expect(bookings.request(intent,first.id,{...input,visitNote:'different'})).rejects.toMatchObject({code:'idempotency_conflict'})
  await expect(bookings.request(ctx('patient-a'),second.id,input)).rejects.toMatchObject({status:404})
  await expect(bookings.request(ctx(),first.id,input)).rejects.toMatchObject({status:403})
  await bookings.transition(ctx(),saved.resource.id,{expectedVersion:1,toStatus:'Under Review'})
  await store.transaction(tx=>tx.run('UPDATE homecare_services SET active=0'))
  store.close()
  const restoredStore=reopen(),restored=new BookingService(restoredStore,{codec,clock:()=>new Date('2031-01-01T00:00:00.000Z')})
  const reconciled=await restored.request(intent,first.id,input)
  expect(reconciled).toMatchObject({replayed:true,resource:{id:saved.resource.id,status:'Under Review',version:2}})
  expect(restoredStore.all('SELECT * FROM bookings')).toHaveLength(1)
  expect(restoredStore.all('SELECT * FROM booking_history')).toHaveLength(2)
})

test('invalid booking fields or failed history commit never leave partial booking or receipt',async()=>{
  const {bookings,ctx,first,store}=await homecareFixture()
  for(const input of [ {...bookingInput(),patientId:first.id}, {...bookingInput(),serviceId:'unknown'}, {...bookingInput(),visitNote:null},
    {...bookingInput(),address:{...bookingInput().address,city:'Bandung'}},
    {...bookingInput(),address:{...bookingInput().address,kelurahan:''}},
    {...bookingInput(),preferredWindow:{...bookingInput().preferredWindow,timezone:'UTC'}},
    {...bookingInput(),preferredWindow:{...bookingInput().preferredWindow,endAt:'2030-01-02T00:00:00.000Z'}} ]){
    await expect(bookings.request(ctx('patient-a'),first.id,input)).rejects.toMatchObject({status:422})
  }
  await store.transaction(tx=>tx.run("CREATE TRIGGER fail_booking_history BEFORE INSERT ON booking_history BEGIN SELECT RAISE(ABORT,'fixture'); END"))
  await expect(bookings.request(ctx('patient-a'),first.id,bookingInput())).rejects.toThrow()
  expect(store.all('SELECT * FROM bookings')).toHaveLength(0)
  expect(store.all("SELECT * FROM idempotency_receipts WHERE resource_key LIKE '%bookings%' ")).toHaveLength(0)
})
