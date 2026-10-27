import { expect, test } from 'bun:test'
import { AssignmentService } from '../src/modules/patients/assignments.ts'
import { patientFixture } from './patients.test.ts'
import { NOW } from './migrations/fixture.ts'

test('assignment_revoke_invalidates_scope: operator changes scope atomically and stale versions cannot overwrite it', async () => {
  const { store, service, ctx, first } = await patientFixture()
  const assignments = new AssignmentService(store, () => new Date(NOW))
  const revoke = { nurseAccountId: 'nurse-a', operation: 'revoke', expectedVersion: 1 }
  await expect(assignments.assign(ctx(), first.id, revoke)).rejects.toMatchObject({ status: 403 })
  await expect(assignments.assign(ctx('patient-a'), first.id, revoke)).rejects.toMatchObject({ status: 403 })
  const operator = ctx('operator')
  const result = await assignments.assign(operator, first.id, revoke)
  expect(result.resource.active).toBe(false)
  expect(result.resource.version).toBe(2)
  expect((await assignments.assign(operator, first.id, revoke)).replayed).toBe(true)
  await expect(service.read(ctx(), first.id)).rejects.toMatchObject({ status: 404 })
  await expect(assignments.assign(ctx('operator'), first.id, { ...revoke, operation: 'grant' })).rejects.toMatchObject({ status: 409 })
  const granted = await assignments.assign(ctx('operator'), first.id, { nurseAccountId: 'nurse-b', operation: 'grant', expectedVersion: 2 })
  expect(granted.resource.version).toBe(3)
  expect((await service.read(ctx('nurse-b'), first.id)).id).toBe(first.id)
  expect(store.all("SELECT * FROM patient_assignments WHERE patient_id=?", [first.id])).toHaveLength(2)
  expect(store.all("SELECT * FROM operational_audit WHERE action LIKE 'assignment.%'")).toHaveLength(2)
})

test('unknown or inactive nurse cannot receive scope, and failed mutation leaves no audit/version change', async () => {
  const { store, ctx, first } = await patientFixture()
  const assignments = new AssignmentService(store, () => new Date(NOW))
  for (const nurseAccountId of ['missing', 'patient-a']) {
    await expect(assignments.assign(ctx('operator'), first.id, { nurseAccountId, operation: 'grant', expectedVersion: 1 })).rejects.toMatchObject({ status: 404 })
  }
  await store.transaction(tx => tx.run("UPDATE accounts SET active=0 WHERE id='nurse-b'"))
  await expect(assignments.assign(ctx('operator'), first.id, { nurseAccountId: 'nurse-b', operation: 'grant', expectedVersion: 1 })).rejects.toMatchObject({ status: 404 })
  expect(store.get<{ version: number }>('SELECT version FROM patients WHERE id=?', [first.id])?.version).toBe(1)
  expect(store.all("SELECT * FROM operational_audit WHERE action LIKE 'assignment.%'")).toHaveLength(0)
})
