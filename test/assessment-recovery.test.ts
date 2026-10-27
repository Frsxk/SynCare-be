import { expect, test } from 'bun:test'
import { AssessmentService, assessmentProjection, type AssessmentRow } from '../src/modules/assessments/service.ts'
import { AssessmentRecovery, RECOVERY_ACTOR, RECOVERY_REASON } from '../src/modules/assessments/recovery.ts'
import { ConfirmationService } from '../src/modules/assessments/confirmation.ts'
import { LangflowTimeoutError, type FlowRunResult } from '../src/plugins/langflow.ts'
import { runStartup } from '../src/index.ts'
import { assessmentFixture, f1Output } from './assessment.test.ts'
import { NOW } from './migrations/fixture.ts'

const RECOVERY_AT = '2026-10-24T00:10:00.000Z'
const flowResult = (text = JSON.stringify(f1Output)): FlowRunResult => ({ raw: { synthetic: true }, outputText: text, sessionId: null })

async function holdOrphan(f: Awaited<ReturnType<typeof assessmentFixture>>) {
  let calls = 0, started!: () => void, release!: (value: FlowRunResult) => void, fail!: (error: unknown) => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<FlowRunResult>((resolve, reject) => { release = resolve; fail = reject })
  const service = new AssessmentService(f.store, { codec: f.codec, clock: () => new Date(NOW), runF1: async () => {
    calls++; started(); return held
  } })
  const run = service.run(f.ctx(), f.discharge.id)
  await ready
  const row = f.store.get<AssessmentRow>("SELECT * FROM assessments WHERE state='RUNNING'")!
  return { ...f, service, run, row, calls: () => calls, release, fail }
}

const orphanFixture = async () => holdOrphan(await assessmentFixture())
const recoveryAudits = (f: { store: Awaited<ReturnType<typeof assessmentFixture>>['store'] }) =>
  f.store.all<{ actor_id: string; action: string; resource_type: string; resource_id: string; occurred_at: string; payload_json: string }>(
    'SELECT * FROM operational_audit WHERE actor_id=?', [RECOVERY_ACTOR])

test('startup_recovery_reopen: durable RUNNING orphan becomes UNKNOWN at the recovery instant without replaying F1', async () => {
  const f = await orphanFixture()
  expect(f.store.all<{ action: string }>("SELECT action FROM operational_audit WHERE action LIKE 'assessment.%'").map(row => row.action)).toEqual(['assessment.started'])
  f.store.close()
  const store = f.reopen()
  const recovery = new AssessmentRecovery(store, { clock: () => new Date(RECOVERY_AT) })
  expect(await recovery.recover()).toEqual({ recovered: 1 })
  const row = store.get<AssessmentRow>('SELECT * FROM assessments WHERE id=?', [f.row.id])!
  expect(row).toMatchObject({ state: 'UNKNOWN', version: 2, completed_at: RECOVERY_AT, failure_code: 'outcome_unknown',
    output_json: null, raw_json: null, requested_by: 'nurse-a', discharge_id: f.discharge.id, source_version: 1 })
  const audits = recoveryAudits({ store })
  expect(audits).toHaveLength(1)
  expect(audits[0]).toMatchObject({ actor_id: RECOVERY_ACTOR, action: 'assessment.recovered_unknown', resource_type: 'patient',
    resource_id: f.discharge.patientId, occurred_at: RECOVERY_AT })
  expect(JSON.parse(audits[0]!.payload_json)).toEqual({ assessmentId: f.row.id, dischargeId: f.discharge.id, sourceVersion: 1,
    requestedBy: 'nurse-a', previousState: 'RUNNING', previousVersion: 1, reason: RECOVERY_REASON })
  expect(await recovery.recover()).toEqual({ recovered: 0 })
  expect(recoveryAudits({ store })).toHaveLength(1)
  expect(f.calls()).toBe(1)
})

test('recovery_audit_atomic: the conditional UPDATE is visible inside the audit transaction and rolls back on audit failure', async () => {
  const f = await orphanFixture()
  await f.store.transaction(tx => tx.run(`CREATE TRIGGER synthetic_recovery_audit_fault BEFORE INSERT ON operational_audit
    WHEN NEW.action='assessment.recovered_unknown'
    BEGIN
      SELECT CASE WHEN (SELECT state FROM assessments WHERE id=json_extract(NEW.payload_json,'$.assessmentId'))!='UNKNOWN'
        THEN RAISE(ABORT,'prior_update_not_visible') END;
      SELECT RAISE(ABORT,'synthetic_audit_fault');
    END`))
  let failure: unknown
  try { await new AssessmentRecovery(f.store, { clock: () => new Date(RECOVERY_AT) }).recover() } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toContain('synthetic_audit_fault')
  const row = f.store.get<AssessmentRow>('SELECT * FROM assessments WHERE id=?', [f.row.id])!
  expect(row).toMatchObject({ state: 'RUNNING', version: 1, completed_at: null, output_json: null, raw_json: null, failure_code: null })
  expect(recoveryAudits(f)).toHaveLength(0)
  await f.store.transaction(tx => tx.run('DROP TRIGGER synthetic_recovery_audit_fault'))
  expect(await new AssessmentRecovery(f.store, { clock: () => new Date(RECOVERY_AT) }).recover()).toEqual({ recovered: 1 })
  expect(f.store.get<AssessmentRow>('SELECT * FROM assessments WHERE id=?', [f.row.id])!.state).toBe('UNKNOWN')
})

test('recovery_idempotent: terminal assessments, confirmations and source evidence stay byte-identical', async () => {
  const f = await assessmentFixture()
  let outcome: 'success' | 'invalid' | 'failed' | 'timeout' = 'success'
  const service = new AssessmentService(f.store, { codec: f.codec, clock: () => new Date(NOW), runF1: async () => {
    if (outcome === 'failed') throw new Error('synthetic upstream failure')
    if (outcome === 'timeout') throw new LangflowTimeoutError(1, 'synthetic://f1')
    return flowResult(outcome === 'invalid' ? '{}' : JSON.stringify(f1Output))
  } })
  const succeeded = await service.run(f.ctx(), f.discharge.id)
  outcome = 'invalid'; const invalid = await service.run(f.ctx(), f.discharge.id)
  outcome = 'failed'; const failed = await service.run(f.ctx(), f.discharge.id)
  outcome = 'timeout'; const unknown = await service.run(f.ctx(), f.discharge.id)
  await new ConfirmationService(f.store, () => new Date(NOW)).confirm(f.ctx(), succeeded.id, { category: 'LOW', expectedVersion: succeeded.version })
  const orphan = await holdOrphan(f)
  const ids = [succeeded.id, invalid.id, failed.id, unknown.id]
  const terminal = () => f.store.all<AssessmentRow>(`SELECT * FROM assessments WHERE id IN (?,?,?,?) ORDER BY id`, ids)
  const snapshot = {
    terminal: terminal(),
    confirmations: f.store.all('SELECT * FROM risk_confirmations ORDER BY id'),
    discharges: f.store.all('SELECT * FROM discharge_versions ORDER BY id'),
    heads: f.store.all('SELECT * FROM patient_episode_heads ORDER BY patient_id'),
    patients: f.store.all('SELECT * FROM patients ORDER BY id'),
    audit: f.store.all('SELECT * FROM operational_audit ORDER BY id'),
  }
  const recovery = new AssessmentRecovery(f.store, { clock: () => new Date(RECOVERY_AT) })
  expect(await recovery.recover()).toEqual({ recovered: 1 })
  expect(terminal()).toEqual(snapshot.terminal)
  expect(f.store.all('SELECT * FROM risk_confirmations ORDER BY id')).toEqual(snapshot.confirmations)
  expect(f.store.all('SELECT * FROM discharge_versions ORDER BY id')).toEqual(snapshot.discharges)
  expect(f.store.all('SELECT * FROM patient_episode_heads ORDER BY patient_id')).toEqual(snapshot.heads)
  expect(f.store.all('SELECT * FROM patients ORDER BY id')).toEqual(snapshot.patients)
  expect(await recovery.recover()).toEqual({ recovered: 0 })
  expect(terminal()).toEqual(snapshot.terminal)
  expect(recoveryAudits(f)).toHaveLength(1)
  expect(JSON.parse(recoveryAudits(f)[0]!.payload_json)).toMatchObject({ assessmentId: orphan.row.id })
  expect(f.store.all('SELECT * FROM operational_audit')).toHaveLength(snapshot.audit.length + 1)
})

test('recovery_read_only_and_clock_preconditions: no writes in read-only mode and no invented completion timestamp', async () => {
  const f = await orphanFixture()
  expect(await new AssessmentRecovery(f.store, { readOnly: true, clock: () => new Date(RECOVERY_AT) }).recover()).toEqual({ recovered: 0 })
  expect(f.store.get<AssessmentRow>('SELECT * FROM assessments WHERE id=?', [f.row.id])).toMatchObject({ state: 'RUNNING', version: 1, completed_at: null })
  expect(recoveryAudits(f)).toHaveLength(0)
  await expect(new AssessmentRecovery(f.store, { clock: () => new Date(Number.NaN) }).recover())
    .rejects.toMatchObject({ code: 'invalid_recovery_clock' })
  await expect(new AssessmentRecovery(f.store, { clock: () => new Date('2026-10-23T23:59:59.000Z') }).recover())
    .rejects.toMatchObject({ code: 'recovery_clock_before_assessment' })
  expect(f.store.get<AssessmentRow>('SELECT * FROM assessments WHERE id=?', [f.row.id])).toMatchObject({ state: 'RUNNING', version: 1, completed_at: null })
  expect(recoveryAudits(f)).toHaveLength(0)
  expect(await new AssessmentRecovery(f.store, { clock: () => new Date(RECOVERY_AT) }).recover()).toEqual({ recovered: 1 })
})

test('recovery_then_completion: a held F1 success or rejection cannot overwrite UNKNOWN or append a false audit', async () => {
  for (const settle of ['success', 'reject'] as const) {
    const f = await orphanFixture()
    await new AssessmentRecovery(f.store, { clock: () => new Date(RECOVERY_AT) }).recover()
    const audits = () => f.store.all<{ action: string }>('SELECT action FROM operational_audit WHERE actor_id!=? ORDER BY occurred_at,id', [RECOVERY_ACTOR])
    const before = audits()
    if (settle === 'success') f.release(flowResult())
    else f.fail(new Error('late synthetic upstream failure'))
    const settled = await f.run
    expect(settled).toMatchObject({ id: f.row.id, state: 'UNKNOWN', version: 2, completedAt: RECOVERY_AT, output: null, failureCode: 'outcome_unknown' })
    expect(audits()).toEqual(before)
    expect(f.store.get<AssessmentRow>('SELECT * FROM assessments WHERE id=?', [f.row.id])).toMatchObject({ state: 'UNKNOWN', version: 2,
      completed_at: RECOVERY_AT, output_json: null, raw_json: null, failure_code: 'outcome_unknown' })
    expect(f.calls()).toBe(1)
  }
})

test('service_completion: one success audit and the returned projection is the durable authoritative row', async () => {
  const f = await assessmentFixture()
  const service = new AssessmentService(f.store, { codec: f.codec, clock: () => new Date(RECOVERY_AT), runF1: async () => flowResult() })
  const completed = await service.run(f.ctx(), f.discharge.id)
  const row = f.store.get<AssessmentRow>('SELECT * FROM assessments WHERE id=?', [completed.id])!
  expect(completed).toEqual(assessmentProjection(row))
  expect(completed).toMatchObject({ state: 'SUCCEEDED', version: 2, completedAt: RECOVERY_AT })
  expect(f.store.all<{ action: string }>("SELECT action FROM operational_audit WHERE action LIKE 'assessment.%' ORDER BY occurred_at,action").map(audit => audit.action))
    .toEqual(['assessment.started', 'assessment.succeeded'])
})

test('startup_order: assessment recovery completes before workers and listener; a recovery failure is fail-closed', async () => {
  const order: string[] = []
  await runStartup({
    migrate: async () => { order.push('migrate') },
    recoverAssessments: async () => { order.push('recover-assessments') },
    recoverReviews: async () => { order.push('recover-reviews') },
    startWorkers: () => { order.push('workers') },
    listen: () => { order.push('listen') },
  })
  expect(order).toEqual(['migrate', 'recover-assessments', 'recover-reviews', 'workers', 'listen'])
  const failed: string[] = []
  await expect(runStartup({
    migrate: async () => { failed.push('migrate') },
    recoverAssessments: async () => { failed.push('recover-assessments'); throw new Error('recovery_failed') },
    recoverReviews: async () => { failed.push('recover-reviews') },
    startWorkers: () => { failed.push('workers') },
    listen: () => { failed.push('listen') },
  })).rejects.toThrow('recovery_failed')
  expect(failed).toEqual(['migrate', 'recover-assessments'])
})
