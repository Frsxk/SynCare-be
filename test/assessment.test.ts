import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { DischargeService } from '../src/modules/patients/discharge.ts'
import { AssessmentService, type F1Output } from '../src/modules/assessments/service.ts'
import { patientFixture } from './patients.test.ts'
import { NOW } from './migrations/fixture.ts'

export const f1Output: F1Output = { episode: { diagnosis: 'CHF sintetis', medications: [], instructions: [], followup_needs: [], length_of_stay_days: 1,
  admission_type: 'elective', comorbidity_count: 1, admissions_prior_12m: 0 }, score: 1, tier: 'LOW', risk_factors: {
    length_of_stay_days: { value: 1, threshold: 5, points: 0, met: false } }, rationale: 'Hasil F1 sintetis khusus unit test',
  label: 'demo-heuristic-v1', missing_fields: [], not_clinically_validated: true, synthetic_demo_only: true, disclaimer: 'Data sintetis. Bukan keputusan klinis.' }

export async function assessmentFixture() {
  const fixture = await patientFixture()
  await fixture.store.transaction(tx => {
    for (const nurse of ['nurse-a', 'nurse-b']) tx.run('INSERT INTO capability_grants VALUES (?,?,?,?,?,?,?)',
      [randomUUID(), nurse, 'risk.confirm', 'operator', NOW, null, null])
  })
  const discharges = new DischargeService(fixture.store, () => new Date(NOW))
  const discharge = (await discharges.addDischarge(fixture.ctx(), fixture.first.id,
    { sourceText: '  Exact synthetic F1 source\nkept verbatim  ', expectedPatientVersion: 1 })).resource
  return { ...fixture, discharges, discharge }
}

test('f1_source_version_preserved: exact source/output persisted and same request reuses a durable assessment without another upstream call', async () => {
  const { store, discharge, ctx, codec } = await assessmentFixture()
  const calls: { text: string; sessionId: string }[] = []
  const raw = { outputs: [{ synthetic: 'original envelope' }] }
  const service = new AssessmentService(store, { codec, clock: () => new Date(NOW), runF1: async (text, sessionId) => {
    calls.push({ text, sessionId }); return { raw, outputText: JSON.stringify(f1Output), sessionId }
  } })
  const intent = ctx()
  const first = await service.run(intent, discharge.id)
  expect(first.output).toEqual(f1Output)
  expect(first.dischargeId).toBe(discharge.id)
  expect(first.sourceVersion).toBe(1)
  expect(first.state).toBe('SUCCEEDED')
  expect((await service.run(intent, discharge.id)).id).toBe(first.id)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.text).toBe(discharge.sourceText)
  expect(calls[0]?.sessionId).toContain(discharge.patientId)
  expect(JSON.parse(store.get<{ raw_json: string }>('SELECT raw_json FROM assessments WHERE id=?', [first.id])!.raw_json).raw).toEqual(raw)
})

test('invalid/missing F1 stays unconfirmable and failure retains an earlier valid assessment without inventing a score', async () => {
  const { store, discharge, ctx, codec } = await assessmentFixture()
  let outcome = 'valid'
  const service = new AssessmentService(store, { codec, runF1: async () => {
    if (outcome === 'failed') throw new Error('private-upstream-error-not-for-clients')
    return { raw: { synthetic: true }, outputText: JSON.stringify(outcome === 'valid' ? f1Output : { ...f1Output, score: null }), sessionId: null }
  } })
  const valid = await service.run(ctx(), discharge.id)
  outcome = 'invalid'
  const invalid = await service.run(ctx(), discharge.id)
  expect(invalid.state).toBe('INVALID')
  expect(invalid.output).toBeNull()
  outcome = 'failed'
  const failed = await service.run(ctx(), discharge.id)
  expect(failed.state).toBe('FAILED')
  expect(JSON.stringify(failed)).not.toContain('private-upstream')
  expect(store.get<{ output_json: string }>('SELECT output_json FROM assessments WHERE id=?', [valid.id])?.output_json).toBe(JSON.stringify(f1Output))
  expect((await service.list(ctx(), discharge.patientId, { limit: 20 })).items).toHaveLength(3)
})

test('assessment scope, capability and current source are checked before F1; revocation while pending denies the response', async () => {
  const { store, discharge, ctx, codec, discharges } = await assessmentFixture()
  let calls = 0
  const service = new AssessmentService(store, { codec, runF1: async () => {
    calls++
    await store.transaction(tx => tx.run('UPDATE patient_assignments SET revoked_at=?,revoked_by=? WHERE patient_id=? AND nurse_account_id=? AND revoked_at IS NULL',
      [new Date().toISOString(), 'operator', discharge.patientId, 'nurse-a']))
    return { raw: {}, outputText: JSON.stringify(f1Output), sessionId: null }
  } })
  await expect(service.run(ctx('patient-a'), discharge.id)).rejects.toMatchObject({ code: 'forbidden' })
  await expect(service.run(ctx('nurse-b'), discharge.id)).rejects.toMatchObject({ code: 'not_found' })
  expect(calls).toBe(0)
  const newSource = await discharges.addDischarge(ctx(), discharge.patientId, { sourceText: 'Source v2', expectedPatientVersion: 2 })
  await expect(service.run(ctx(), discharge.id)).rejects.toMatchObject({ code: 'version_conflict' })
  expect(calls).toBe(0)
  await expect(service.run(ctx(), newSource.resource.id)).rejects.toMatchObject({ code: 'not_found' })
  expect(calls).toBe(1)
})

test('concurrent replay does not rerun F1 and a source changed during processing leaves the old result historical', async () => {
  const { store, discharge, ctx, codec, discharges } = await assessmentFixture()
  let release!: () => void, started!: () => void, calls = 0
  const pending = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { started = resolve })
  const service = new AssessmentService(store, { codec, runF1: async () => {
    calls++; started(); await pending
    return { raw: {}, outputText: JSON.stringify(f1Output), sessionId: null }
  } })
  const intent = ctx(), first = service.run(intent, discharge.id)
  await ready
  expect((await service.run(intent, discharge.id)).state).toBe('RUNNING')
  await discharges.addDischarge(ctx(), discharge.patientId, { sourceText: 'Changed while F1 is pending', expectedPatientVersion: 2 })
  release()
  const completed = await first
  expect(completed.dischargeId).toBe(discharge.id)
  expect(completed.sourceVersion).toBe(1)
  expect(completed.state).toBe('SUCCEEDED')
  expect(calls).toBe(1)
  expect(store.all('SELECT * FROM risk_confirmations')).toHaveLength(0)
})
