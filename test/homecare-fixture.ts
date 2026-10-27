import { randomUUID } from 'node:crypto'
import { patientFixture } from './patients.test.ts'
import { BookingService } from '../src/modules/homecare/request.ts'
import { seedDemoCatalog } from '../src/modules/homecare/catalog.ts'
import { NOW } from './migrations/fixture.ts'

export const bookingInput = () => ({ serviceId: 'post-discharge-nurse-demo',
  address: { fullAddress: 'Alamat sintetis nomor 1', kelurahan: 'Kelurahan uji', kecamatan: 'Kecamatan uji', city: 'Jakarta Pusat' },
  preferredWindow: { startAt: '2030-01-02T01:00:00.000Z', endAt: '2030-01-02T02:00:00.000Z', timezone: 'Asia/Jakarta' }, visitNote: 'Catatan sintetis' })

export async function homecareFixture() {
  const fixture = await patientFixture()
  await seedDemoCatalog(fixture.store)
  await fixture.store.transaction(tx => {
    for (const id of ['nurse-a','nurse-b']) tx.run('INSERT INTO capability_grants VALUES (?,?,?,?,?,?,?)',
      [randomUUID(),id,'booking.manage','operator',NOW,null,null])
  })
  return { ...fixture, bookings: new BookingService(fixture.store,{codec:fixture.codec,clock:()=>new Date(NOW)}) }
}
