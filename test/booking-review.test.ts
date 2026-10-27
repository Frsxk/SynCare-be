import { expect,test } from 'bun:test'
import { homecareFixture,bookingInput } from './homecare-fixture.ts'

test('booking_review_concurrent: one commit one409, no skipped transitions or partial unauthorized event',async()=>{
  const {bookings,ctx,first,store}=await homecareFixture()
  const saved=(await bookings.request(ctx('patient-a'),first.id,bookingInput())).resource
  const input={expectedVersion:1,toStatus:'Under Review'}
  const results=await Promise.allSettled([bookings.transition(ctx(),saved.id,input),bookings.transition(ctx(),saved.id,input)])
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
  expect(results.filter(r=>r.status==='rejected').map(r=>(r as PromiseRejectedResult).reason.code)).toEqual(['version_conflict'])
  expect(store.all("SELECT * FROM booking_history WHERE to_status='Under Review'")).toHaveLength(1)
  await expect(bookings.transition(ctx(),saved.id,{expectedVersion:2,toStatus:'Completed'})).rejects.toMatchObject({status:422})
  await expect(bookings.transition(ctx('nurse-b'),saved.id,{expectedVersion:2,toStatus:'Under Review'})).rejects.toMatchObject({status:404})
  await expect(bookings.transition(ctx('patient-a'),saved.id,input)).rejects.toMatchObject({status:403})
  expect((await bookings.read(ctx(),saved.id)).version).toBe(2)
  expect(store.all('SELECT * FROM booking_history')).toHaveLength(2)
  await store.transaction(tx=>tx.run("UPDATE capability_grants SET revoked_at=granted_at,revoked_by='operator' WHERE account_id='nurse-a' AND capability='booking.manage'"))
  await expect(bookings.read(ctx(),saved.id)).rejects.toMatchObject({status:403})
})
