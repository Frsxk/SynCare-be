import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { AssessmentService, type AssessmentRow } from '../src/modules/assessments/service.ts'
import { AssessmentRecovery, RECOVERY_ACTOR } from '../src/modules/assessments/recovery.ts'
import { ConfirmationService } from '../src/modules/assessments/confirmation.ts'
import { assessmentFixture, f1Output } from './assessment.test.ts'
import { NOW } from './migrations/fixture.ts'

const RECOVERY_AT = '2026-10-24T00:20:00.000Z'

test('assessment_crash_report: a killed child leaves durable RUNNING; restart recovery and a fresh request stay distinct', async () => {
  const f = await assessmentFixture()
  const statePath = f.store.path, signalPath = `${statePath}.running-signal.json`
  const request = { statePath, signalPath, patientId: f.first.id, dischargeId: f.discharge.id, actorId: 'nurse-a',
    requestId: randomUUID(), idempotencyKey: randomUUID(), now: NOW }
  f.store.close()
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./fixtures/assessment-crash-worker.ts', import.meta.url))],
    { stdin: new Blob([JSON.stringify(request)]), stdout: 'pipe', stderr: 'pipe' })
  let signal: { assessmentId: string; sessionId: string } | undefined
  for (let attempt = 0; attempt < 500; attempt++) {
    if (existsSync(signalPath)) {
      signal = JSON.parse(readFileSync(signalPath, 'utf8')) as { assessmentId: string; sessionId: string }
      break
    }
    if (child.exitCode !== null) break
    await Bun.sleep(10)
  }
  if (!signal) {
    child.kill('SIGKILL')
    throw new Error(`child did not persist a RUNNING signal: ${await new Response(child.stderr).text()}`)
  }
  child.kill('SIGKILL')
  expect(await child.exited).not.toBe(0)
  const store = f.reopen()
  expect(store.get<AssessmentRow>('SELECT * FROM assessments WHERE id=?', [signal.assessmentId])).toMatchObject({
    state: 'RUNNING', version: 1, completed_at: null, session_id: signal.sessionId })
  expect(await new AssessmentRecovery(store, { clock: () => new Date(RECOVERY_AT) }).recover()).toEqual({ recovered: 1 })
  const recovered = store.get<AssessmentRow>('SELECT * FROM assessments WHERE id=?', [signal.assessmentId])!
  expect(recovered).toMatchObject({ state: 'UNKNOWN', version: 2, completed_at: RECOVERY_AT, failure_code: 'outcome_unknown',
    output_json: null, raw_json: null })
  const confirmations = new ConfirmationService(store, () => new Date(RECOVERY_AT))
  await expect(confirmations.confirm(f.ctx(), recovered.id, { category: 'LOW', expectedVersion: recovered.version }))
    .rejects.toMatchObject({ code: 'validation_failed' })
  expect(store.all('SELECT * FROM risk_confirmations')).toHaveLength(0)
  let freshCalls = 0
  const fresh = new AssessmentService(store, { codec: f.codec, clock: () => new Date(RECOVERY_AT),
    runF1: async () => { freshCalls++; return { raw: { synthetic: true }, outputText: JSON.stringify(f1Output), sessionId: null } } })
  let replayCalls = 0
  const replay = await new AssessmentService(store, { codec: f.codec, clock: () => new Date(RECOVERY_AT),
    runF1: async () => { replayCalls++; return { raw: {}, outputText: JSON.stringify(f1Output), sessionId: null } } })
    .run({ ...f.ctx(), idempotencyKey: request.idempotencyKey }, f.discharge.id)
  expect(replay).toMatchObject({ id: recovered.id, state: 'UNKNOWN', output: null })
  expect(replayCalls).toBe(0)
  const next = await fresh.run(f.ctx(), f.discharge.id)
  expect(next.id).not.toBe(recovered.id)
  expect(next).toMatchObject({ state: 'SUCCEEDED', version: 2, sourceVersion: 1 })
  expect(next.output).toEqual(f1Output)
  expect(store.all('SELECT * FROM assessments')).toHaveLength(2)
  expect(confirmations.summary(f.ctx('patient-a'), f.first.id)).toMatchObject({ status: 'unconfirmed', current: null })
  expect(store.all('SELECT * FROM risk_confirmations')).toHaveLength(0)
  const confirmed = await confirmations.confirm(f.ctx(), next.id, { category: 'LOW', expectedVersion: next.version })
  expect(confirmed.resource).toMatchObject({ assessmentId: next.id, dischargeId: f.discharge.id, category: 'LOW',
    confirmedBy: 'nurse-a', applicable: true })
  expect(confirmations.summary(f.ctx('patient-a'), f.first.id)).toMatchObject({ status: 'confirmed',
    current: { assessmentId: next.id, confirmedBy: 'nurse-a', category: 'LOW', applicable: true } })
  expect(store.get<{ actor_id: string }>("SELECT actor_id FROM operational_audit WHERE action='risk.confirmed'")).toEqual({ actor_id: 'nurse-a' })
  expect(store.get<AssessmentRow>('SELECT * FROM assessments WHERE id=?', [recovered.id])).toMatchObject({ state: 'UNKNOWN', version: 2,
    completed_at: RECOVERY_AT, failure_code: 'outcome_unknown', output_json: null, raw_json: null, requested_by: 'nurse-a' })
  expect(store.all(`SELECT * FROM operational_audit WHERE actor_id='${RECOVERY_ACTOR}'`)).toHaveLength(1)
  expect(freshCalls).toBe(1)
  expect(replayCalls).toBe(0)
})
