import { expect,test } from 'bun:test'
import { homecareFixture,bookingInput } from './homecare-fixture.ts'
import { seedDemoCatalog } from '../src/modules/homecare/catalog.ts'

test('catalog_inactive_rejected: bounded actual catalog, inactive cached ID rejected, empty has no fallback',async()=>{
  const {bookings,ctx,first,store}=await homecareFixture()
  const page=await bookings.catalog(ctx('patient-a'),{limit:1})
  expect(page.items).toHaveLength(1)
  expect(page.items[0]).toMatchObject({id:bookingInput().serviceId,synthetic:true,timezone:'Asia/Jakarta',coverageProvince:'DKI Jakarta'})
  expect(page.nextCursor).toBeNull()
  await store.transaction(tx=>tx.run('UPDATE homecare_services SET active=0,version=version+1'))
  await seedDemoCatalog(store)
  await expect(bookings.request(ctx('patient-a'),first.id,bookingInput())).rejects.toMatchObject({status:422})
  expect((await bookings.catalog(ctx(),{limit:20})).items).toEqual([])
  expect(store.all('SELECT * FROM bookings')).toHaveLength(0)
})
