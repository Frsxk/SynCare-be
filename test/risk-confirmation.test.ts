import { expect, test } from 'bun:test'
import { AssessmentService } from '../src/modules/assessments/service.ts'
import { ConfirmationService } from '../src/modules/assessments/confirmation.ts'
import { assessmentFixture, f1Output } from './assessment.test.ts'
import { NOW } from './migrations/fixture.ts'

test('risk_confirmation_source_change: same-category confirmation is explicit and a new source makes it historical without altering it', async () => {
  const { store, discharge, first, ctx, codec, discharges } = await assessmentFixture()
  const assessments = new AssessmentService(store, { codec, clock: () => new Date(NOW), runF1: async () => ({ raw: {}, outputText: JSON.stringify(f1Output), sessionId: null }) })
  const service = new ConfirmationService(store, () => new Date(NOW))
  const assessment = await assessments.run(ctx(), discharge.id)
  expect(service.summary(ctx('patient-a'), first.id).status).toBe('unconfirmed')
  await expect(service.confirm(ctx(), assessment.id, { category: 'HIGH', expectedVersion: assessment.version })).rejects.toMatchObject({ code: 'validation_failed' })
  await expect(service.confirm(ctx(), assessment.id, { category: 'LOW', expectedVersion: 1 })).rejects.toMatchObject({ code: 'version_conflict' })
  const intent = ctx(), input = { category: 'LOW', expectedVersion: assessment.version }
  const confirmed = await service.confirm(intent, assessment.id, input)
  expect((await service.confirm(intent, assessment.id, input)).resource.id).toBe(confirmed.resource.id)
  expect(service.summary(ctx('patient-a'), first.id)).toMatchObject({ status: 'confirmed', current: { category: 'LOW', assessmentId: assessment.id, sourceVersion: 1, applicable: true } })
  await expect(service.confirm(ctx(), assessment.id, input)).rejects.toMatchObject({ code: 'version_conflict' })
  const patientVersion = store.get<{ version: number }>('SELECT version FROM patients WHERE id=?', [first.id])!.version
  const second = await discharges.addDischarge(ctx(), first.id, { sourceText: 'Source v2 requires new review', expectedPatientVersion: patientVersion })
  expect(service.summary(ctx('patient-a'), first.id)).toMatchObject({ status: 'needs_reassessment', current: null,
    previous: { category: 'LOW', assessmentId: assessment.id, applicable: false } })
  expect(store.all('SELECT * FROM risk_confirmations')).toHaveLength(1)
  const old = store.get<{ category: string; confirmed_at: string }>('SELECT * FROM risk_confirmations WHERE id=?', [confirmed.resource.id])!
  expect(old.category).toBe('LOW')
  expect(old.confirmed_at).toBe(NOW)
  const reassessed = await assessments.run(ctx(), second.resource.id)
  expect(service.summary(ctx('patient-a'), first.id).status).toBe('needs_reassessment')
  await service.confirm(ctx(), reassessed.id, { category: 'LOW', expectedVersion: reassessed.version })
  expect(service.summary(ctx('patient-a'), first.id).status).toBe('confirmed')
  expect(service.history(ctx(), first.id)).toHaveLength(2)
})

test('confirmation denies missing capability, unassigned IDs, invalid output and old assessments; no clinical override', async () => {
  const { store, discharge, first, ctx, codec } = await assessmentFixture()
  const assessments = new AssessmentService(store, { codec, clock: () => new Date(NOW), runF1: async () => ({ raw: {}, outputText: '{}', sessionId: null }) })
  const invalid = await assessments.run(ctx(), discharge.id)
  const confirmations = new ConfirmationService(store)
  const input = { category: 'LOW', expectedVersion: invalid.version }
  await expect(confirmations.confirm(ctx(), invalid.id, input)).rejects.toMatchObject({ code: 'validation_failed' })
  await expect(confirmations.confirm(ctx('nurse-b'), invalid.id, input)).rejects.toMatchObject({ code: 'not_found' })
  await expect(confirmations.confirm(ctx('patient-a'), invalid.id, input)).rejects.toMatchObject({ code: 'forbidden' })
  await store.transaction(tx => tx.run("UPDATE capability_grants SET revoked_at=?,revoked_by='operator' WHERE account_id='nurse-a' AND capability='risk.confirm'", [NOW]))
  await expect(confirmations.confirm(ctx(), invalid.id, input)).rejects.toMatchObject({ code: 'forbidden' })
  expect(store.all('SELECT * FROM risk_confirmations')).toHaveLength(0)
  expect(confirmations.summary(ctx('patient-a'), first.id).current).toBeNull()
  await expect(Promise.resolve().then(() => confirmations.summary(ctx('patient-b'), first.id))).rejects.toMatchObject({ code: 'not_found' })
})
