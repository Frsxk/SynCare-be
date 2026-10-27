import { randomUUID } from 'node:crypto'
import type { Store } from '../../storage/database.ts'
import { DomainError, type RequestContext } from '../contracts/errors.ts'
import { withIdempotency } from '../contracts/idempotency.ts'
import { exactObject, requireCapability } from './service.ts'

export interface Assignment { id: string; patientId: string; nurseAccountId: string; active: boolean; version: number; changedAt: string }

export class AssignmentService {
  constructor(private readonly store: Store, private readonly clock = () => new Date()) {}

  async assign(ctx: RequestContext, patientId: string, input: unknown): Promise<{ resource: Assignment; replayed: boolean }> {
    const body = exactObject(input, ['nurseAccountId', 'operation', 'expectedVersion'])
    if (typeof body.nurseAccountId !== 'string' || !body.nurseAccountId || body.nurseAccountId.length > 128 ||
        !['grant', 'revoke'].includes(body.operation as string) || !Number.isSafeInteger(body.expectedVersion) ||
        (body.expectedVersion as number) < 1) throw new DomainError('validation_failed')
    requireCapability(this.store, ctx.principal, 'assignment.manage')
    const saved = await withIdempotency(this.store, {
      principalId: ctx.principal.id, method: 'POST', resourceKey: `/patients/${patientId}/assignments`, key: ctx.idempotencyKey ?? '', payload: body,
    }, tx => {
      requireCapability(tx, ctx.principal, 'assignment.manage')
      const patient = tx.get<{ version: number }>('SELECT version FROM patients WHERE id=?', [patientId])
      const nurse = tx.get('SELECT id FROM accounts WHERE id=? AND role=? AND active=1', [body.nurseAccountId as string, 'nurse'])
      if (!patient || !nurse) throw new DomainError('not_found')
      if (patient.version !== body.expectedVersion) throw new DomainError('version_conflict', { resourceId: patientId, currentVersion: patient.version })
      const previous = tx.get<{ id: string }>('SELECT id FROM patient_assignments WHERE patient_id=? AND nurse_account_id=? AND revoked_at IS NULL',
        [patientId, body.nurseAccountId as string])
      if ((body.operation === 'grant') === Boolean(previous)) throw new DomainError('version_conflict', { resourceId: patientId, currentVersion: patient.version })
      const now = this.clock().toISOString(), id = previous?.id ?? randomUUID()
      if (body.operation === 'grant') {
        tx.run('INSERT INTO patient_assignments VALUES (?,?,?,?,?,?,?)', [id, patientId, body.nurseAccountId as string, ctx.principal.id, now, null, null])
      } else {
        tx.run('UPDATE patient_assignments SET revoked_at=?,revoked_by=? WHERE id=?', [now, ctx.principal.id, id])
      }
      tx.run('UPDATE patients SET version=version+1 WHERE id=? AND version=?', [patientId, patient.version])
      const resource: Assignment = { id, patientId, nurseAccountId: body.nurseAccountId as string, active: body.operation === 'grant', version: patient.version + 1, changedAt: now }
      tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)', [randomUUID(), ctx.principal.id, `assignment.${body.operation}`, 'patient', patientId, now,
        JSON.stringify({ assignmentId: id, nurseAccountId: body.nurseAccountId, version: resource.version })])
      return { resourceId: id, status: 200, data: resource }
    })
    return { resource: saved.data, replayed: saved.replayed }
  }
}
