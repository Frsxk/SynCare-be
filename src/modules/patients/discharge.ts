import { randomUUID } from 'node:crypto'
import type { Store, Transaction } from '../../storage/database.ts'
import { DomainError, type RequestContext } from '../contracts/errors.ts'
import { withIdempotency } from '../contracts/idempotency.ts'
import { strictTextObject, textLimits } from '../contracts/validation.ts'
import { assertPatientScope, exactObject, requireCapability } from './service.ts'

export interface Discharge {
  id: string; patientId: string; episodeId: string; version: number; sourceText: string
  createdAt: string; actorId: string; patientVersion: number
}
export interface DischargeRow {
  id: string; patient_id: string; episode_id: string; version: number; source_text: string; created_by: string; created_at: string
}
export function dischargeProjection(row: DischargeRow, patientVersion: number): Discharge {
  return { id: row.id, patientId: row.patient_id, episodeId: row.episode_id, version: row.version, sourceText: row.source_text,
    createdAt: row.created_at, actorId: row.created_by, patientVersion }
}

export class DischargeService {
  constructor(private readonly store: Store, private readonly clock = () => new Date()) {}

  current(ctx: RequestContext, patientId: string): Discharge | null {
    requireCapability(this.store, ctx.principal, 'patient.manage')
    assertPatientScope(this.store, ctx.principal, patientId)
    const row = this.store.get<DischargeRow & { patient_version: number }>(`SELECT d.*,p.version patient_version FROM patient_episode_heads h
      JOIN discharge_versions d ON d.id=h.current_discharge_id JOIN patients p ON p.id=h.patient_id WHERE h.patient_id=?`, [patientId])
    return row ? dischargeProjection(row, row.patient_version) : null
  }

  async addDischarge(ctx: RequestContext, patientId: string, input: unknown): Promise<{ resource: Discharge; replayed: boolean }> {
    const body = exactObject(input, ['sourceText', 'expectedPatientVersion'])
    const { sourceText } = strictTextObject({ sourceText: body.sourceText }, { sourceText: textLimits.discharge })
    if (!Number.isSafeInteger(body.expectedPatientVersion) || (body.expectedPatientVersion as number)<1) throw new DomainError('validation_failed')
    const expectedPatientVersion = body.expectedPatientVersion as number
    const authorize = (reader: Store | Transaction) => {
      requireCapability(reader, ctx.principal, 'patient.manage')
      assertPatientScope(reader, ctx.principal, patientId)
    }
    authorize(this.store)
    const saved = await withIdempotency(this.store, {
      principalId: ctx.principal.id, method: 'POST', resourceKey: `/patients/${patientId}/discharges`, key: ctx.idempotencyKey ?? '',
      payload: { sourceText, expectedPatientVersion },
    }, tx => {
      authorize(tx)
      const patient = tx.get<{ version: number }>('SELECT version FROM patients WHERE id=?', [patientId])!
      if (patient.version !== expectedPatientVersion) throw new DomainError('version_conflict', { resourceId: patientId, currentVersion: patient.version })
      const head = tx.get<{ episode_id: string; current_version: number; version: number }>('SELECT * FROM patient_episode_heads WHERE patient_id=?', [patientId])
      const episodeId = head?.episode_id ?? randomUUID(), version = (head?.current_version ?? 0)+1
      const id = randomUUID(), now = this.clock().toISOString()
      tx.run('INSERT INTO discharge_versions VALUES (?,?,?,?,?,?,?)', [id, patientId, episodeId, version, sourceText, ctx.principal.id, now])
      if (head) {
        tx.run(`UPDATE patient_episode_heads SET current_discharge_id=?,current_version=?,updated_by=?,updated_at=?,version=version+1 WHERE patient_id=?`,
          [id, version, ctx.principal.id, now, patientId])
      } else tx.run('INSERT INTO patient_episode_heads VALUES (?,?,?,?,?,?,?)', [patientId, episodeId, id, version, ctx.principal.id, now, 1])
      tx.run('UPDATE patients SET version=version+1 WHERE id=? AND version=?', [patientId, expectedPatientVersion])
      tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)', [randomUUID(), ctx.principal.id, 'discharge.created', 'patient', patientId, now,
        JSON.stringify({ dischargeId: id, episodeId, sourceVersion: version, patientVersion: patient.version+1 })])
      return { resourceId: id, status: 201, data: dischargeProjection({ id, patient_id: patientId, episode_id: episodeId, version,
        source_text: sourceText, created_by: ctx.principal.id, created_at: now }, patient.version+1) }
    })
    return { resource: saved.data, replayed: saved.replayed }
  }
}
