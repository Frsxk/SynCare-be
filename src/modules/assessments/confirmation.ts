import { randomUUID } from 'node:crypto'
import type { Store } from '../../storage/database.ts'
import { DomainError, type RequestContext } from '../contracts/errors.ts'
import { withIdempotency } from '../contracts/idempotency.ts'
import { assertPatientScope, exactObject, requireCapability } from '../patients/service.ts'
import { authorizeAssessment, validF1, type AssessmentRow, type RiskTier } from './service.ts'

export interface RiskEvidence {
  id: string; assessmentId: string; dischargeId: string; sourceVersion: number; category: RiskTier; score: number
  confirmedBy: string; confirmedAt: string; applicable: boolean; disclaimer: string; label: string; version: number
}
export interface RiskSummary {
  status: 'confirmed' | 'unconfirmed' | 'needs_reassessment'; current: RiskEvidence | null; previous: RiskEvidence | null
}
interface ConfirmationRow {
  id: string; assessment_id: string; patient_id: string; category: RiskTier; confirmed_by: string; confirmed_at: string; version: number
  discharge_id: string; source_version: number; output_json: string; applicable: number
}
const joined = `SELECT c.*,a.discharge_id,a.source_version,a.output_json,
  CASE WHEN a.discharge_id=h.current_discharge_id THEN 1 ELSE 0 END applicable
  FROM risk_confirmations c JOIN assessments a ON a.id=c.assessment_id
  LEFT JOIN patient_episode_heads h ON h.patient_id=c.patient_id`
function project(row: ConfirmationRow): RiskEvidence {
  const output = validF1(row.output_json)
  if (!output || output.tier!==row.category) throw new DomainError('invalid_flow_output')
  return { id: row.id, assessmentId: row.assessment_id, dischargeId: row.discharge_id, sourceVersion: row.source_version,
    category: row.category, score: output.score, confirmedBy: row.confirmed_by, confirmedAt: row.confirmed_at,
    applicable: row.applicable===1, disclaimer: output.disclaimer, label: output.label, version: row.version }
}

export class ConfirmationService {
  constructor(private readonly store: Store, private readonly clock = () => new Date()) {}

  summary(ctx: RequestContext, patientId: string): RiskSummary {
    assertPatientScope(this.store, ctx.principal, patientId)
    const current = this.store.get<ConfirmationRow>(`${joined} WHERE c.patient_id=? AND a.discharge_id=h.current_discharge_id
      ORDER BY julianday(c.confirmed_at) DESC,c.id DESC LIMIT 1`, [patientId])
    const previous = this.store.get<ConfirmationRow>(`${joined} WHERE c.patient_id=? AND a.discharge_id!=h.current_discharge_id
      ORDER BY a.source_version DESC,julianday(c.confirmed_at) DESC,c.id DESC LIMIT 1`, [patientId])
    return { status: current ? 'confirmed' : previous ? 'needs_reassessment' : 'unconfirmed',
      current: current ? project(current) : null, previous: previous ? project(previous) : null }
  }

  history(ctx: RequestContext, patientId: string): RiskEvidence[] {
    authorizeAssessment(this.store, ctx, patientId)
    return this.store.all<ConfirmationRow>(`${joined} WHERE c.patient_id=?
      ORDER BY a.source_version DESC,julianday(c.confirmed_at) DESC,c.id DESC LIMIT 100`, [patientId]).map(project)
  }

  async confirm(ctx: RequestContext, assessmentId: string, input: unknown): Promise<{ resource: RiskEvidence; replayed: boolean }> {
    const body = exactObject(input, ['category', 'expectedVersion'])
    if (!['LOW', 'MEDIUM', 'HIGH'].includes(body.category as string) || !Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number)<1) {
      throw new DomainError('validation_failed')
    }
    requireCapability(this.store, ctx.principal, 'risk.confirm')
    const assessment = this.store.get<AssessmentRow>('SELECT * FROM assessments WHERE id=?', [assessmentId])
    if (!assessment) throw new DomainError('not_found')
    authorizeAssessment(this.store, ctx, assessment.patient_id)
    const result = await withIdempotency(this.store, { principalId: ctx.principal.id, method: 'POST', resourceKey: `/assessments/${assessmentId}/confirmations`,
      key: ctx.idempotencyKey ?? '', payload: body }, tx => {
      authorizeAssessment(tx, ctx, assessment.patient_id)
      const current = tx.get<AssessmentRow>('SELECT * FROM assessments WHERE id=?', [assessmentId])!
      if (current.version!==body.expectedVersion) throw new DomainError('version_conflict', { resourceId: assessmentId, currentVersion: current.version })
      const output = validF1(current.output_json)
      if (current.state!=='SUCCEEDED' || !output || body.category!==output.tier) throw new DomainError('validation_failed')
      if (!tx.get('SELECT patient_id FROM patient_episode_heads WHERE patient_id=? AND current_discharge_id=?', [assessment.patient_id, assessment.discharge_id]) ||
          tx.get('SELECT id FROM risk_confirmations WHERE assessment_id=?', [assessmentId])) {
        throw new DomainError('version_conflict', { resourceId: assessmentId, currentVersion: current.version })
      }
      const id = randomUUID(), now = this.clock().toISOString()
      tx.run('INSERT INTO risk_confirmations VALUES (?,?,?,?,?,?,?)', [id, assessmentId, assessment.patient_id, output.tier, ctx.principal.id, now, 1])
      tx.run('UPDATE patients SET version=version+1 WHERE id=?', [assessment.patient_id])
      tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)', [randomUUID(), ctx.principal.id, 'risk.confirmed', 'patient', assessment.patient_id, now,
        JSON.stringify({ confirmationId: id, assessmentId, dischargeId: assessment.discharge_id, sourceVersion: assessment.source_version, category: output.tier })])
      return { resourceId: id, status: 201, data: project(tx.get<ConfirmationRow>(`${joined} WHERE c.id=?`, [id])!) }
    })
    return { resource: result.data, replayed: result.replayed }
  }
}
