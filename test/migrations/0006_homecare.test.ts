import { expect,test } from 'bun:test'
import { homecareFixture,bookingInput } from '../homecare-fixture.ts'
import { database } from './fixture.ts'

test('0006_homecare_constraints: upgrade/repeat/reopen, foreign keys, immutable snapshots/history and atomic failure',async()=>{
  const upgrade=await database(5)
  expect(upgrade.store.get("SELECT name FROM sqlite_master WHERE name='bookings'")).toBeNull()
  await upgrade.store.migrate()
  expect(upgrade.store.get("SELECT name FROM sqlite_master WHERE name='bookings'")).not.toBeNull()
  const {bookings,ctx,first,store,reopen}=await homecareFixture()
  const row=(await bookings.request(ctx('patient-a'),first.id,bookingInput())).resource
  for(const sql of ["UPDATE bookings SET status='Unknown'", "UPDATE bookings SET status='Scheduled'",
    "UPDATE bookings SET assigned_staff_id='foreign'", "UPDATE bookings SET preferred_end_at='invalid'",
    "UPDATE bookings SET address_json='{}'", "DELETE FROM bookings", "DELETE FROM booking_history",
    "UPDATE booking_history SET internal_note='changed'", "INSERT INTO homecare_staff VALUES ('patient-a','Not nurse',1,1)"]){
    await expect(store.transaction(tx=>tx.run(sql))).rejects.toThrow()
  }
  await store.migrate();store.close()
  const restored=reopen();await restored.migrate()
  expect(restored.get<{id:string}>('SELECT id FROM bookings WHERE id=?',[row.id])?.id).toBe(row.id)
  expect(restored.all('SELECT * FROM booking_history')).toHaveLength(1)
})
