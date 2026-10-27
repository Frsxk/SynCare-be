import { expect, test } from 'bun:test'
import { OverviewService } from '../src/modules/patients/overview.ts'
import { PatientService } from '../src/modules/patients/service.ts'
import { AssessmentService } from '../src/modules/assessments/service.ts'
import { ConfirmationService } from '../src/modules/assessments/confirmation.ts'
import { assessmentFixture, f1Output } from './assessment.test.ts'
import { CheckinService } from '../src/modules/checkins/service.ts'

test('patient_overview_scope_available_sources: self projection has no raw staff source or proposed category; missing domains are unavailable', async () => {
  const { store, first, second, ctx, codec, discharge, discharges } = await assessmentFixture()
  const overview = new OverviewService(store)
  const patients = new PatientService(store, { codec, overview: (context, profile) => overview.read(context, profile) })
  const assessments = new AssessmentService(store, { codec, runF1: async () => ({ raw: {}, outputText: JSON.stringify(f1Output), sessionId: null }) })
  const proposed = await assessments.run(ctx(), discharge.id)
  const self = await patients.overview(ctx('patient-a'), first.id)
  expect(self.confirmedRisk.status).toBe('unconfirmed')
  expect(self.latestAssessment).toBeNull()
  expect(self.currentDischarge?.sourceText).toBeNull()
  expect(self.activeBookingCounts).toEqual({ availability: 'unavailable', reason: 'domain_source_not_connected' })
  expect(self.latestAnalysis).toBeNull()
  expect(self.latestReport).toBeNull()
  await expect(patients.overview(ctx('patient-a'), second.id)).rejects.toMatchObject({ code: 'not_found' })
  expect((await patients.overview(ctx(), first.id)).currentDischarge?.sourceText).toBe(discharge.sourceText)
  expect((await patients.overview(ctx(), first.id)).latestAssessment?.id).toBe(proposed.id)
  await new ConfirmationService(store).confirm(ctx(), proposed.id, { expectedVersion: proposed.version, category: 'LOW' })
  expect((await patients.overview(ctx('patient-a'), first.id)).confirmedRisk.current?.category).toBe('LOW')
  const version = (await patients.read(ctx(), first.id)).version
  await discharges.addDischarge(ctx(), first.id, { sourceText: 'Source v2', expectedPatientVersion: version })
  const changed = await patients.overview(ctx('patient-a'), first.id)
  expect(changed.confirmedRisk.status).toBe('needs_reassessment')
  expect(changed.confirmedRisk.current).toBeNull()
  expect(changed.confirmedRisk.previous?.category).toBe('LOW')
  expect(changed.permissions.managePatient).toBe(false)
  const report=await new CheckinService(store,{codec}).submit(ctx('patient-a'),first.id,{message:'Synthetic pending report'})
  const withReport=await patients.overview(ctx('patient-a'),first.id)
  expect(withReport.latestReport?.id).toBe(report.resource.id)
  expect(withReport.latestReport?.processing.state).toBe('BLOCKED_BASELINE')
  expect(withReport.latestAnalysis).toBeNull()
  expect(withReport.confirmedRisk.status).toBe('needs_reassessment')
})
