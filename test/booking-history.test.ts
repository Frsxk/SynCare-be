import { expect,test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { homecareFixture,bookingInput } from './homecare-fixture.ts'
import { BookingService } from '../src/modules/homecare/request.ts'
import { BOOKING_STATUSES } from '../src/modules/homecare/contracts.ts'
import type { BookingRow } from '../src/modules/homecare/contracts.ts'

test('booking_history_projection: all six stored states/restart, private note redaction and deterministic scoped cursor',async()=>{
  const {bookings,ctx,first,store,reopen,codec}=await homecareFixture()
  const ids:string[]=[]
  for(const state of BOOKING_STATUSES){
    const row=(await bookings.request(ctx('patient-a'),first.id,bookingInput())).resource
    ids.push(row.id)
    await store.transaction(tx=>{
      if(['Scheduled','Completed'].includes(state)){
        tx.run("INSERT INTO homecare_staff VALUES ('nurse-a','Perawat sintetis A',1,1) ON CONFLICT DO NOTHING")
        tx.run(`UPDATE bookings SET status=?,assigned_staff_id='nurse-a',confirmed_start_at=?,confirmed_end_at=?,confirmed_timezone='Asia/Jakarta',
          completed_at=?,completion_note=? WHERE id=?`,[state,bookingInput().preferredWindow.startAt,bookingInput().preferredWindow.endAt,
          state==='Completed'?'2030-01-02T02:05:00.000Z':null,state==='Completed'?'Catatan selesai sintetis':null,row.id])
      }else tx.run('UPDATE bookings SET status=? WHERE id=?',[state,row.id])
      tx.run('INSERT INTO booking_history VALUES (?,?,?,?,?,?,?,?,?)',[randomUUID(),row.id,2,'Requested',state,'nurse-a',row.createdAt,'Alasan aman','internal-only-fixture'])
    })
  }
  const page=await bookings.list(ctx('patient-a'),first.id,{limit:2})
  expect(page.items.map(r=>r.id)).toEqual([...ids].sort().reverse().slice(0,2))
  expect(JSON.stringify(page)).not.toContain('internal-only-fixture')
  expect((await bookings.read(ctx(),ids[0]!)).timeline[1]?.internalNote).toBe('internal-only-fixture')
  const next=await bookings.list(ctx('patient-a'),first.id,{limit:2,cursor:page.nextCursor!})
  expect(new Set([...page.items,...next.items].map(r=>r.id)).size).toBe(4)
  await expect(bookings.list(ctx(),first.id,{limit:2,cursor:page.nextCursor!})).rejects.toMatchObject({status:422})
  await expect(bookings.read(ctx('patient-b'),ids[0]!)).rejects.toMatchObject({status:404})
  store.close()
  const restored=new BookingService(reopen(),{codec})
  expect((await Promise.all(ids.map(id=>restored.read(ctx('patient-a'),id)))).map(r=>r.status)).toEqual([...BOOKING_STATUSES])
})

test('malformed stored snapshot is a typed failure rather than a plausible booking projection',async()=>{
  const {bookings,ctx,first,store}=await homecareFixture()
  const saved=(await bookings.request(ctx('patient-a'),first.id,bookingInput())).resource
  const row=store.get<BookingRow>('SELECT * FROM bookings WHERE id=?',[saved.id])!
  const malformed={...row,id:'malformed-snapshot',service_snapshot_json:JSON.stringify({...JSON.parse(row.service_snapshot_json),version:0})}
  const keys=Object.keys(malformed) as (keyof BookingRow)[]
  await store.transaction(tx=>tx.run(`INSERT INTO bookings(${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`,keys.map(key=>malformed[key])))
  await expect(bookings.read(ctx('patient-a'),malformed.id)).rejects.toMatchObject({code:'processing_failed'})
})

test('queue status filter applies before scoped pagination and cursor cannot cross filters',async()=>{
  const {bookings,ctx,first}=await homecareFixture()
  const a=(await bookings.request(ctx('patient-a'),first.id,bookingInput())).resource
  const b=(await bookings.request(ctx('patient-a'),first.id,bookingInput())).resource
  await bookings.transition(ctx('patient-a'),a.id,{expectedVersion:1,toStatus:'Cancelled',reason:'Skenario tertutup.'})
  expect((await bookings.list(ctx(),undefined,{limit:1},'active')).items.map(r=>r.id)).toEqual([b.id])
  expect((await bookings.list(ctx(),undefined,{limit:20},'Cancelled')).items.map(r=>r.id)).toEqual([a.id])
  const all=await bookings.list(ctx(),undefined,{limit:1})
  await expect(bookings.list(ctx(),undefined,{limit:1,cursor:all.nextCursor!},'active')).rejects.toMatchObject({status:422})
})
