import { expect, test } from 'bun:test'
import { DischargeService } from '../src/modules/patients/discharge.ts'
import { patientFixture } from './patients.test.ts'
import { NOW } from './migrations/fixture.ts'

test('discharge_edit_creates_version: immutable original source and episode are retained with atomic patient/head versions', async () => {
  const { store, reopen, first, ctx } = await patientFixture()
  const service = new DischargeService(store, () => new Date(NOW))
  const source = '  Ringkasan pulang sintetis\n  tetap utuh.  '
  const intent = ctx()
  const v1 = await service.addDischarge(intent, first.id, { sourceText: source, expectedPatientVersion: 1 })
  const replay = await service.addDischarge(intent, first.id, { sourceText: source, expectedPatientVersion: 1 })
  expect(replay.resource).toEqual(v1.resource)
  expect(replay.replayed).toBe(true)
  const v2 = await service.addDischarge(ctx(), first.id, { sourceText: 'Sumber sintetis kedua', expectedPatientVersion: 2 })
  expect(v2.resource.id).not.toBe(v1.resource.id)
  expect(v2.resource.episodeId).toBe(v1.resource.episodeId)
  expect(v2.resource.version).toBe(2)
  expect(v2.resource.patientVersion).toBe(3)
  expect(store.get<{ source_text: string }>('SELECT source_text FROM discharge_versions WHERE id=?', [v1.resource.id])?.source_text).toBe(source)
  expect(store.get<{ current_discharge_id: string }>('SELECT current_discharge_id FROM patient_episode_heads WHERE patient_id=?', [first.id])?.current_discharge_id).toBe(v2.resource.id)
  expect(store.all("SELECT * FROM operational_audit WHERE action='discharge.created'")).toHaveLength(2)
  store.close()
  const restored = reopen()
  await restored.migrate()
  expect(new DischargeService(restored).current(ctx(), first.id)?.id).toBe(v2.resource.id)
  expect(restored.get('SELECT id FROM discharge_versions WHERE id=?', [v1.resource.id])).not.toBeNull()
})

test('invalid, stale and unassigned discharge writes leave no partial source, version or audit', async () => {
  const { store, first, second, ctx } = await patientFixture()
  const service = new DischargeService(store)
  for (const sourceText of ['', '  \n ', 'x'.repeat(64001)]) {
    await expect(service.addDischarge(ctx(), first.id, { sourceText, expectedPatientVersion: 1 })).rejects.toMatchObject({ code: 'validation_failed' })
  }
  await expect(service.addDischarge(ctx(), first.id, { sourceText: 'source', expectedPatientVersion: 0 })).rejects.toMatchObject({ code: 'validation_failed' })
  await expect(service.addDischarge(ctx(), first.id, { sourceText: 'source', expectedPatientVersion: 1, patientId: second.id })).rejects.toMatchObject({ code: 'validation_failed' })
  await expect(service.addDischarge(ctx(), second.id, { sourceText: 'source', expectedPatientVersion: 1 })).rejects.toMatchObject({ code: 'not_found' })
  await expect(service.addDischarge(ctx('patient-a'), first.id, { sourceText: 'source', expectedPatientVersion: 1 })).rejects.toMatchObject({ code: 'forbidden' })
  await expect(service.addDischarge(ctx(), first.id, { sourceText: 'source', expectedPatientVersion: 8 })).rejects.toMatchObject({ code: 'version_conflict', details: { currentVersion: 1 } })
  expect(store.all('SELECT * FROM discharge_versions')).toHaveLength(0)
  expect(store.all('SELECT * FROM patient_episode_heads')).toHaveLength(0)
  expect(store.get<{ version: number }>('SELECT version FROM patients WHERE id=?', [first.id])?.version).toBe(1)
})
