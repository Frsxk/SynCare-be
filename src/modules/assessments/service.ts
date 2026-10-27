import { randomUUID } from 'node:crypto'
import type { Store, Transaction } from '../../storage/database.ts'
import { LangflowTimeoutError, type FlowRunResult } from '../../plugins/langflow.ts'
import { DomainError, type RequestContext } from '../contracts/errors.ts'
import { CursorCodec, seekBoundary, type Page, type PageInput } from '../contracts/pagination.ts'
import { assertPatientScope, requireCapability } from '../patients/service.ts'
import type { DischargeRow } from '../patients/discharge.ts'

export type RiskTier = 'LOW' | 'MEDIUM' | 'HIGH'
export interface F1Output extends Record<string, unknown> {
  score: number; tier: RiskTier; episode: Record<string, unknown>; risk_factors: Record<string, unknown>
  rationale: string; label: string; missing_fields: string[]; disclaimer: string
  not_clinically_validated: true; synthetic_demo_only: true
}
export interface Assessment {
  id: string; patientId: string; dischargeId: string; sourceVersion: number; actorId: string; version: number
  state: 'RUNNING' | 'SUCCEEDED' | 'INVALID' | 'FAILED' | 'UNKNOWN'; createdAt: string; completedAt: string | null
  output: F1Output | null; failureCode: string | null
}
export interface AssessmentRow {
  id: string; patient_id: string; discharge_id: string; source_version: number; requested_by: string; idempotency_key: string
  session_id: string; state: Assessment['state']; version: number; created_at: string; completed_at: string | null
  output_json: string | null; raw_json: string | null; failure_code: string | null
}
type Reader = Store | Transaction
export const uuidKey = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function authorizeAssessment(reader: Reader, ctx: RequestContext, patientId: string) {
  requireCapability(reader, ctx.principal, 'risk.confirm')
  assertPatientScope(reader, ctx.principal, patientId)
}
export function assessmentProjection(row: AssessmentRow): Assessment {
  return { id: row.id, patientId: row.patient_id, dischargeId: row.discharge_id, sourceVersion: row.source_version, actorId: row.requested_by,
    version: row.version, state: row.state, createdAt: row.created_at, completedAt: row.completed_at,
    output: row.output_json ? JSON.parse(row.output_json) as F1Output : null, failureCode: row.failure_code }
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
export function validF1(text: string | null): F1Output | null {
  try {
    const value: unknown = text === null ? null : JSON.parse(text)
    if (!object(value) || typeof value.score !== 'number' || !Number.isFinite(value.score) || !['LOW', 'MEDIUM', 'HIGH'].includes(value.tier as string) ||
      !object(value.episode) || !object(value.risk_factors) || typeof value.rationale !== 'string' || !value.rationale.trim() ||
      typeof value.label !== 'string' || !value.label.trim() || typeof value.disclaimer !== 'string' || !value.disclaimer.trim() ||
      value.not_clinically_validated !== true || value.synthetic_demo_only !== true || !Array.isArray(value.missing_fields) || value.missing_fields.length) return null
    for (const factor of Object.values(value.risk_factors)) {
      if (!object(factor) || typeof factor.points !== 'number' || !Number.isFinite(factor.points) || typeof factor.met !== 'boolean' ||
        !Object.hasOwn(factor, 'value') || !Object.hasOwn(factor, 'threshold')) return null
    }
    return value as F1Output
  } catch { return null }
}

export class AssessmentService {
  private readonly clock: () => Date
  constructor(private readonly store: Store, private readonly options: {
    codec: CursorCodec; runF1: (sourceText: string, sessionId: string) => Promise<FlowRunResult>; clock?: () => Date
  }) { this.clock = options.clock ?? (() => new Date()) }

  async run(ctx: RequestContext, dischargeId: string): Promise<Assessment> {
    requireCapability(this.store, ctx.principal, 'risk.confirm')
    const source = this.store.get<DischargeRow>('SELECT * FROM discharge_versions WHERE id=?', [dischargeId])
    if (!source) throw new DomainError('not_found')
    authorizeAssessment(this.store, ctx, source.patient_id)
    if (!uuidKey.test(ctx.idempotencyKey ?? '')) throw new DomainError('validation_failed')
    const prepared = await this.store.transaction(tx => {
      authorizeAssessment(tx, ctx, source.patient_id)
      const previous = tx.get<AssessmentRow>('SELECT * FROM assessments WHERE requested_by=? AND discharge_id=? AND idempotency_key=?',
        [ctx.principal.id, dischargeId, ctx.idempotencyKey!])
      if (previous) return { row: previous, fresh: false }
      if (!tx.get('SELECT patient_id FROM patient_episode_heads WHERE patient_id=? AND current_discharge_id=?', [source.patient_id, dischargeId])) {
        throw new DomainError('version_conflict', { resourceId: dischargeId, currentVersion: source.version })
      }
      const id = randomUUID(), sessionId = `syncare-f1-${source.patient_id}-${source.id}-${randomUUID()}`, now = this.clock().toISOString()
      tx.run(`INSERT INTO assessments(id,patient_id,discharge_id,source_version,requested_by,idempotency_key,session_id,state,version,created_at)
        VALUES (?,?,?,?,?,?,?,'RUNNING',1,?)`, [id, source.patient_id, dischargeId, source.version, ctx.principal.id, ctx.idempotencyKey!, sessionId, now])
      tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)', [randomUUID(), ctx.principal.id, 'assessment.started', 'patient', source.patient_id, now,
        JSON.stringify({ assessmentId: id, dischargeId, sourceVersion: source.version })])
      return { row: tx.get<AssessmentRow>('SELECT * FROM assessments WHERE id=?', [id])!, fresh: true }
    })
    if (!prepared.fresh) return assessmentProjection(prepared.row)
    let state: Assessment['state'], output: F1Output | null = null, raw: string | null = null, failure: string | null = null
    try {
      const result = await this.options.runF1(source.source_text, prepared.row.session_id)
      const serialized = JSON.stringify(result)
      if (Buffer.byteLength(serialized) <= 4*1024*1024) {
        raw = serialized
        output = validF1(result.outputText)
      }
      state = output ? 'SUCCEEDED' : 'INVALID'
      failure = output ? null : 'invalid_flow_output'
    } catch (error) {
      state = error instanceof LangflowTimeoutError ? 'UNKNOWN' : 'FAILED'
      failure = state === 'UNKNOWN' ? 'outcome_unknown' : 'dependency_unavailable'
    }
    await this.store.transaction(tx => {
      const now = this.clock().toISOString()
      tx.run(`UPDATE assessments SET state=?,version=2,completed_at=?,output_json=?,raw_json=?,failure_code=?
        WHERE id=? AND state='RUNNING' AND version=1 AND completed_at IS NULL`,
        [state, now, output ? JSON.stringify(output) : null, raw, failure, prepared.row.id])
      if (tx.get<{ changed: number }>('SELECT changes() AS changed')!.changed === 1) {
        tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)', [randomUUID(), ctx.principal.id, `assessment.${state.toLowerCase()}`, 'patient', source.patient_id, now,
          JSON.stringify({ assessmentId: prepared.row.id, dischargeId, sourceVersion: source.version })])
      }
    })
    authorizeAssessment(this.store, ctx, source.patient_id)
    return assessmentProjection(this.store.get<AssessmentRow>('SELECT * FROM assessments WHERE id=?', [prepared.row.id])!)
  }

  async list(ctx: RequestContext, patientId: string, input: PageInput): Promise<Page<Assessment>> {
    authorizeAssessment(this.store, ctx, patientId)
    if (!Number.isInteger(input.limit) || input.limit<1 || input.limit>100) throw new DomainError('validation_failed')
    const namespace = `${ctx.principal.id}:assessments:${patientId}`
    const boundary = input.cursor ? seekBoundary(this.options.codec.decode(namespace, input.cursor)) : null
    const rows = this.store.all<AssessmentRow>(`SELECT * FROM assessments WHERE patient_id=?${boundary ? ` AND ${boundary.sql}` : ''}
      ORDER BY julianday(created_at) DESC,id DESC LIMIT ?`, [patientId, ...(boundary?.bindings ?? []), input.limit+1])
    const items = rows.slice(0, input.limit).map(assessmentProjection), last = items.at(-1)
    return { items, nextCursor: rows.length>input.limit && last ? this.options.codec.encode(namespace, last) : null }
  }
}
