import { randomUUID } from 'node:crypto'
import { StorageError, type Store } from '../../storage/database.ts'

export const RECOVERY_ACTOR = 'system:assessment-recovery'
export const RECOVERY_REASON = 'startup_orphan_recovery'

interface RunningRow {
  id: string; patient_id: string; discharge_id: string; source_version: number; requested_by: string
}

/**
 * One-shot startup reconciliation for F1 assessments orphaned by a process crash.
 * It runs in the single-writer process before any listener or worker and never calls F1 again.
 */
export class AssessmentRecovery {
  private readonly clock: () => Date
  private readonly readOnly: boolean
  constructor(private readonly store: Store, options: { clock?: () => Date; readOnly?: boolean } = {}) {
    this.clock = options.clock ?? (() => new Date())
    this.readOnly = options.readOnly ?? false
  }

  async recover(): Promise<{ recovered: number }> {
    if (this.readOnly) return { recovered: 0 }
    const at = this.clock()
    if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new StorageError('invalid_recovery_clock')
    const completedAt = at.toISOString()
    return this.store.transaction(tx => {
      const future = tx.get<{ id: string }>(
        "SELECT id FROM assessments WHERE state='RUNNING' AND julianday(created_at)>julianday(?) LIMIT 1", [completedAt])
      if (future) throw new StorageError('recovery_clock_before_assessment')
      const rows = tx.all<RunningRow>(`SELECT id,patient_id,discharge_id,source_version,requested_by FROM assessments
        WHERE state='RUNNING' AND version=1 AND completed_at IS NULL ORDER BY created_at,id`)
      let recovered = 0
      for (const row of rows) {
        tx.run(`UPDATE assessments SET state='UNKNOWN',version=2,completed_at=?,output_json=NULL,raw_json=NULL,failure_code='outcome_unknown'
          WHERE id=? AND patient_id=? AND discharge_id=? AND source_version=? AND state='RUNNING' AND version=1 AND completed_at IS NULL`,
          [completedAt, row.id, row.patient_id, row.discharge_id, row.source_version])
        if (tx.get<{ changed: number }>('SELECT changes() AS changed')!.changed !== 1) continue
        tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)', [randomUUID(), RECOVERY_ACTOR, 'assessment.recovered_unknown', 'patient',
          row.patient_id, completedAt, JSON.stringify({ assessmentId: row.id, dischargeId: row.discharge_id, sourceVersion: row.source_version,
            requestedBy: row.requested_by, previousState: 'RUNNING', previousVersion: 1, reason: RECOVERY_REASON })])
        recovered++
      }
      return { recovered }
    })
  }
}
