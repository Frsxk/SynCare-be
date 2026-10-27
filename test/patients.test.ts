import { expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { AuthService, hashPassword } from '../src/modules/auth/service.ts'
import { createPatientRoutes } from '../src/modules/patients/routes.ts'
import { PatientService } from '../src/modules/patients/service.ts'
import { CursorCodec } from '../src/modules/contracts/pagination.ts'
import type { RequestContext } from '../src/modules/contracts/errors.ts'
import { account, database, NOW } from './migrations/fixture.ts'

export async function patientFixture() {
  const { store, reopen } = await database()
  for (const id of ['nurse-a', 'nurse-b', 'operator']) await account(store, id, 'nurse')
  await account(store, 'patient-a')
  await account(store, 'patient-b')
  const password = randomBytes(18).toString('base64url')
  const verifier = await hashPassword(password)
  await store.transaction(tx => {
    tx.run('UPDATE accounts SET active=1,password_hash=?', [verifier])
    for (const id of ['nurse-a', 'nurse-b']) {
      for (const capability of ['patient.manage', 'patient.provision']) tx.run('INSERT INTO capability_grants VALUES (?,?,?,?,?,?,?)',
        [randomUUID(), id, capability, 'operator', NOW, null, null])
    }
    for (const capability of ['assignment.manage', 'account.provision', 'capability.manage']) {
      tx.run('INSERT INTO capability_grants VALUES (?,?,?,?,?,?,?)', [randomUUID(), 'operator', capability, 'operator', NOW, null, null])
    }
  })
  const ctx = (id = 'nurse-a'): RequestContext => ({
    principal: { id, role: id.startsWith('patient') ? 'patient' : 'nurse', capabilities: [] },
    requestId: randomUUID(), idempotencyKey: randomUUID(),
  })
  const codec = new CursorCodec('synthetic-patient-cursor-secret-at-least-32-bytes')
  const service = new PatientService(store, { codec, clock: () => new Date(NOW) })
  const first = (await service.create(ctx(), { profile: { displayName: 'Pasien uji A' }, initialCondition: 'Kondisi sintetis A' })).resource
  const second = (await service.create(ctx('nurse-b'), { profile: { displayName: 'Pasien uji B' }, initialCondition: null })).resource
  await store.transaction(tx => {
    for (const [patient, nurse, owner] of [[first.id, 'nurse-a', 'patient-a'], [second.id, 'nurse-b', 'patient-b']]) {
      tx.run('INSERT INTO patient_assignments VALUES (?,?,?,?,?,?,?)', [randomUUID(), patient!, nurse!, 'operator', NOW, null, null])
      tx.run('INSERT INTO patient_account_links VALUES (?,?,?,?)', [patient!, owner!, 'operator', NOW])
    }
  })
  return { store, reopen, ctx, service, codec, first, second, password, auth: new AuthService(store, { clock: () => new Date(NOW) }) }
}

test('patient_registry_roundtrip: profile IDs/versions/audit persist; duplicate key replays one create', async () => {
  const { service, ctx, store, reopen, codec, first } = await patientFixture()
  const intent = ctx()
  const input = { profile: { displayName: 'Pasien uji C' }, initialCondition: null }
  const saved = await service.create(intent, input)
  expect((await service.create(intent, input)).resource.id).toBe(saved.resource.id)
  expect((await service.create(intent, input)).replayed).toBe(true)
  expect(store.all('SELECT * FROM patients')).toHaveLength(3)
  const updated = await service.update(ctx(), first.id, { expectedVersion: 1, profile: { displayName: 'Pasien A revisi' }, recordedCondition: 'Input perawat' })
  expect(updated.resource.version).toBe(2)
  expect(updated.resource.recordedCondition).toBe('Input perawat')
  await expect(service.update(ctx(), first.id, { expectedVersion: 1, profile: { displayName: 'Usang' }, recordedCondition: null }))
    .rejects.toMatchObject({ code: 'version_conflict', status: 409 })
  store.close()
  const restored = new PatientService(reopen(), { codec })
  expect((await restored.read(ctx('patient-a'), first.id)).profile.displayName).toBe('Pasien A revisi')
})

test('registry enforces current assignment and patient link; client role/capability/patientId cannot grant access', async () => {
  const { service, ctx, store, first, second } = await patientFixture()
  expect((await service.list(ctx(), { limit: 20 })).items.map(item => item.id)).toEqual([first.id])
  expect((await service.list(ctx('nurse-b'), { limit: 20 })).items.map(item => item.id)).toEqual([second.id])
  expect((await service.list(ctx('patient-a'), { limit: 20 })).items.map(item => item.id)).toEqual([first.id])
  const forged = ctx('patient-a')
  forged.principal = { ...forged.principal, role: 'nurse', patientId: second.id, capabilities: ['patient.manage'] }
  await expect(service.read(forged, second.id)).rejects.toMatchObject({ status: 401 })
  await expect(service.read(ctx('patient-a'), second.id)).rejects.toMatchObject({ status: 404 })
  await expect(service.read(ctx(), second.id)).rejects.toMatchObject({ status: 404 })
  await expect(service.create(ctx('patient-a'), { profile: { displayName: 'Forbidden' }, initialCondition: null })).rejects.toMatchObject({ status: 403 })
  await store.transaction(tx => tx.run('UPDATE patient_assignments SET revoked_at=?,revoked_by=? WHERE patient_id=?', [NOW, 'operator', first.id]))
  expect((await service.list(ctx(), { limit: 20 })).items).toEqual([])
  await expect(service.read(ctx(), first.id)).rejects.toMatchObject({ status: 404 })
})

test('scoped cursor stays bounded, stable and rejects a different principal or invalid profile', async () => {
  const { service, ctx, first, store } = await patientFixture()
  const another = (await service.create(ctx(), { profile: { displayName: 'Pasien uji C' }, initialCondition: null })).resource
  await store.transaction(tx => tx.run('INSERT INTO patient_assignments VALUES (?,?,?,?,?,?,?)', [randomUUID(), another.id, 'nurse-a', 'operator', NOW, null, null]))
  const page = await service.list(ctx(), { limit: 1 })
  expect(page.items).toHaveLength(1)
  expect(page.nextCursor).toBeString()
  const next = await service.list(ctx(), { limit: 1, cursor: page.nextCursor! })
  expect(new Set([...page.items, ...next.items].map(row => row.id))).toEqual(new Set([first.id, another.id]))
  await expect(service.list(ctx('nurse-b'), { limit: 1, cursor: page.nextCursor! })).rejects.toMatchObject({ status: 422 })
  for (const profile of [{ displayName: '' }, { displayName: 'A', risk: 'HIGH' }, null]) {
    await expect(service.create(ctx(), { profile, initialCondition: null })).rejects.toMatchObject({ status: 422 })
  }
  await store.transaction(tx => tx.run('UPDATE patients SET profile_json=? WHERE id=?', [JSON.stringify({ displayName: 'Pasien uji A', internalNote: 'staff-only synthetic fixture' }), first.id]))
  const projection = await service.read(ctx('patient-a'), first.id)
  expect(Object.keys(projection).sort()).toEqual(['createdAt', 'id', 'profile', 'recordedCondition', 'source', 'updatedAt', 'version'])
  expect(JSON.stringify(projection)).not.toContain('password_hash')
  expect(JSON.stringify(projection)).not.toContain('staff-only synthetic fixture')
})

test('API-P1/P2 authenticate real sessions and reject forged fields, duplicate queries and cross-patient IDs', async () => {
  const { auth, password, service, first, second } = await patientFixture()
  const app = createPatientRoutes(auth, service)
  const grant = await auth.login('patient-a@synthetic.invalid', password)
  const request = (path: string, token = grant.sessionToken, method = 'GET', body?: unknown) => new Request(`http://localhost/api/v1/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  expect((await app.handle(request(`patients/${first.id}`))).status).toBe(200)
  expect((await app.handle(request(`patients/${second.id}`))).status).toBe(404)
  expect((await app.handle(request('patients', 'infrastructure-key'))).status).toBe(401)
  const list = await app.handle(request('patients'))
  expect(list.headers.get('cache-control')).toContain('no-store')
  expect((await list.json() as { data: { id: string }[] }).data.map(row => row.id)).toEqual([first.id])
  expect((await app.handle(request('patients?limit=1&limit=2'))).status).toBe(422)
  expect((await app.handle(request('patients', grant.sessionToken, 'POST', { profile: { displayName: 'Forbidden' }, initialCondition: null }))).status).toBe(403)
  const nurse = await auth.login('nurse-a@synthetic.invalid', password)
  const invalid = await app.handle(request('patients', nurse.sessionToken, 'POST', { profile: { displayName: 'A' }, initialCondition: null, actor: 'operator' }))
  expect(invalid.status).toBe(422)
  const created = await app.handle(request('patients', nurse.sessionToken, 'POST', { profile: { displayName: 'C' }, initialCondition: null }))
  expect(created.status).toBe(201)
  const updated = await app.handle(request(`patients/${first.id}`, nurse.sessionToken, 'PATCH', { expectedVersion: 1, profile: { displayName: 'Revisi A' }, recordedCondition: null }))
  expect(updated.status).toBe(200)
})
