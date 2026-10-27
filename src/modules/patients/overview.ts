import type { Store } from '../../storage/database.ts'
import type { RequestContext } from '../contracts/errors.ts'
import { ConfirmationService, type RiskSummary } from '../assessments/confirmation.ts'
import { assessmentProjection, type Assessment, type AssessmentRow } from '../assessments/service.ts'
import { dischargeProjection, type Discharge, type DischargeRow } from './discharge.ts'
import { assertPatientScope, type Patient } from './service.ts'
import { latestCheckin } from '../checkins/queries.ts'
import type { CheckinRecord } from '../checkins/contracts.ts'

export interface UnavailableSource { availability: 'unavailable'; reason: 'domain_source_not_connected' }
export interface PatientOverview {
  profile: Patient; currentDischarge: (Omit<Discharge, 'sourceText'> & { sourceText: string | null }) | null
  confirmedRisk: RiskSummary; latestAssessment: Assessment | null
  permissions: { managePatient: boolean; reviewRisk: boolean; provisionPatient: boolean; manageAssignments: boolean }
  currentPlan: UnavailableSource; latestReport: CheckinRecord|null; latestAnalysis: CheckinRecord['outcome']
  activeBookingCounts: UnavailableSource; openAlertCounts: UnavailableSource
}
export class OverviewService {
  constructor(private readonly store: Store) {}
  read(ctx: RequestContext, profile: Patient): PatientOverview {
    assertPatientScope(this.store, ctx.principal, profile.id)
    const grants = new Set(this.store.all<{ capability: string }>('SELECT capability FROM capability_grants WHERE account_id=? AND revoked_at IS NULL', [ctx.principal.id]).map(row => row.capability))
    const nurse = ctx.principal.role==='nurse'
    const permissions = { managePatient: nurse && grants.has('patient.manage'), reviewRisk: nurse && grants.has('risk.confirm'),
      provisionPatient: nurse && grants.has('patient.provision'), manageAssignments: nurse && grants.has('assignment.manage') }
    const source = this.store.get<DischargeRow>(`SELECT d.* FROM patient_episode_heads h JOIN discharge_versions d ON d.id=h.current_discharge_id WHERE h.patient_id=?`, [profile.id])
    const assessment = permissions.reviewRisk && source ? this.store.get<AssessmentRow>(`SELECT * FROM assessments WHERE discharge_id=?
      ORDER BY julianday(created_at) DESC,id DESC LIMIT 1`, [source.id]) : null
    const unavailable: UnavailableSource = { availability: 'unavailable', reason: 'domain_source_not_connected' }
    const report=latestCheckin(this.store,ctx,profile.id)
    return { profile, currentDischarge: source ? { ...dischargeProjection(source, profile.version),
      sourceText: permissions.managePatient || permissions.reviewRisk ? source.source_text : null } : null,
      confirmedRisk: new ConfirmationService(this.store).summary(ctx, profile.id), latestAssessment: assessment ? assessmentProjection(assessment) : null,
      permissions, currentPlan: unavailable, latestReport: report, latestAnalysis: report?.outcome??null, activeBookingCounts: unavailable, openAlertCounts: unavailable }
  }
}
