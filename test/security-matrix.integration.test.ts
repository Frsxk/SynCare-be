import { expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { createApp } from '../src/app.ts'
import type { Store } from '../src/storage/database.ts'
import { BookingService } from '../src/modules/homecare/request.ts'
import { seedDemoCatalog } from '../src/modules/homecare/catalog.ts'
import { PlanService } from '../src/modules/plans/service.ts'
import { startReview } from '../src/modules/reviews/start.ts'
import { alertFixture } from './alert-fixture.ts'
import { bookingInput } from './homecare-fixture.ts'
import { makeDraft } from './review-fixture.ts'
import { NOW } from './migrations/fixture.ts'

function contents(store: Store) {
  const result: Record<string, string> = {}
  for (const { name } of store.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
    const rows = store.all(`SELECT * FROM "${name}"`).map(row => JSON.stringify(row)).sort()
    result[name] = createHash('sha256').update(JSON.stringify(rows)).digest('hex')
  }
  return result
}

async function fixture() {
  const f = await alertFixture()
  await f.store.transaction(tx => {
    for (const accountId of ['nurse-a', 'nurse-b']) for (const capability of ['review.decide', 'booking.manage']) {
      tx.run('INSERT INTO capability_grants VALUES (?,?,?,?,?,?,?)', [randomUUID(), accountId, capability, 'operator', NOW, null, null])
    }
  })
  const { report, alert } = await f.create()
  await seedDemoCatalog(f.store)
  const bookings = new BookingService(f.store, { codec: f.codec, clock: () => new Date(NOW) })
  const booking = (await bookings.request(f.ctx('patient-a'), f.first.id, bookingInput())).resource
  const plans = new PlanService(f.store, async input => ({ raw: {}, outputText: JSON.stringify(makeDraft(JSON.parse(input))), sessionId: null }))
  const draft = (await plans.draft(f.ctx(), f.first.id, { assessmentId: f.assessment.id, followupDate: '2026-11-02', hotline: 'M11 synthetic contact' })).resource
  const review = (await startReview(f.store, plans, { start: async () => ({ jobId: randomUUID(), status: 'queued' }), snapshot: async () => ({ status: 'queued' }), resume: async () => {} }, f.ctx(), draft.id, {})).resource
  return { ...f, report, alert, booking, plans, draft, review }
}

async function application() {
  const f = await fixture()
  let calls = 0
  const config = {
    langflowBaseUrl: 'http://127.0.0.1:59999', langflowApiKey: 'M11_PRIVATE_UPSTREAM_SENTINEL',
    apiKey: 'M11_PRIVATE_INFRA_SENTINEL', reviewDbPath: import.meta.filename,
    consoleStateDbPath: f.store.path, host: 'localhost', port: 8080, readOnly: false,
  }
  const deps = {
    store: f.store, auth: f.auth, cursorSecret: 'M11-test-only-cursor-key-longer-than-32', config,
    security: { backendOrigin: 'http://localhost', webOrigin: 'http://localhost:3000', allowLocalHttp: true },
    flows: { f1_register_discharge_summary: '11111111-1111-4111-8111-111111111111', f3_draft_followup_plan: '33333333-3333-4333-8333-333333333333', f4_review_care_plan: '44444444-4444-4444-8444-444444444444', f5_answer_care_questions: '55555555-5555-4555-8555-555555555555' },
    runFlowImpl: async () => { calls++; throw Error('M11_PRIVATE_DEPENDENCY_SENTINEL') },
  }
  const app = createApp(deps)
  const nurse = await f.auth.login('nurse-a@synthetic.invalid', f.password)
  const foreignNurse = await f.auth.login('nurse-b@synthetic.invalid', f.password)
  const patient = await f.auth.login('patient-a@synthetic.invalid', f.password)
  const foreignPatient = await f.auth.login('patient-b@synthetic.invalid', f.password)
  const request = (path: string, token: string | null, method = 'GET', body?: unknown) => new Request(`http://localhost/api/v1/${path}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { ...f, app, deps, config, nurse, foreignNurse, patient, foreignPatient, request, calls: () => calls }
}

test('security_matrix_zero_leak: real mounted domain reads/writes reject foreign nurse/patient without record or upstream effects', async () => {
  const f = await application()
  const before = contents(f.store)
  const paths: [string, string, unknown?][] = [
    [`patients/${f.first.id}`, 'GET'], [`patients/${f.first.id}/overview`, 'GET'],
    [`patients/${f.first.id}/checkins`, 'GET'], [`checkins/${f.report.id}`, 'GET'],
    [`patients/${f.first.id}/checkins`, 'POST', { message: 'M11 forbidden synthetic report' }],
    [`patients/${f.first.id}/bookings`, 'GET'], [`bookings/${f.booking.id}`, 'GET'],
    [`patients/${f.first.id}/bookings`, 'POST', bookingInput()],
    [`bookings/${f.booking.id}/transitions`, 'POST', { expectedVersion: 1, toStatus: 'Under Review' }],
    [`patients/${f.first.id}/alerts`, 'GET'], [`alerts/${f.alert.id}`, 'GET'],
    [`alerts/${f.alert.id}/actions`, 'POST', { expectedVersion: 1, action: 'acknowledge', note: 'M11 forbidden' }],
    [`patients/${f.first.id}/assessments`, 'GET'], [`discharges/${f.discharge.id}/assessments`, 'POST', {}],
    [`assessments/${f.assessment.id}/confirmations`, 'POST', { expectedVersion: 1, category: 'HIGH' }],
    [`patients/${f.first.id}/care-plans`, 'GET'],
    [`care-plan-drafts/${f.draft.id}`, 'GET'], [`reviews/${f.review.id}`, 'GET'],
    [`reviews/${f.review.id}/stream`, 'GET'],
    [`reviews/${f.review.id}/decisions`, 'POST', { expectedVersion: 1, requestId: randomUUID(), actionId: 'approve' }],
    [`patients/${f.first.id}/care-plan-drafts`, 'POST', { assessmentId: f.assessment.id, followupDate: '2026-11-02', hotline: 'M11 synthetic contact' }],
    [`patients/${f.first.id}/questions`, 'POST', { query: 'M11 forbidden question' }],
    ['answers', 'POST', { patient_id: f.first.id, query: 'M11 forbidden legacy question' }],
    [`plans/${f.first.id}`, 'GET'],
    [`patients/${f.first.id}`, 'PATCH', { expectedVersion: 1, profile: { displayName: 'M11 forbidden' }, recordedCondition: null }],
    [`patients/${f.first.id}/discharges`, 'POST', { expectedPatientVersion: 1, sourceText: 'M11 forbidden source' }],
  ]
  for (const token of [f.foreignNurse.sessionToken, f.foreignPatient.sessionToken]) for (const [path, method, body] of paths) {
    const response = await f.app.handle(f.request(path, token, method, body))
    if (![403, 404].includes(response.status)) throw Error(`unexpected_security_status:${method}:${path}:${response.status}`)
    expect([403, 404]).toContain(response.status)
    const text = await response.text()
    expect(text).not.toContain(f.first.profile.displayName)
    expect(text).not.toContain(f.report.message)
    expect(text).not.toContain('M11_PRIVATE_')
  }
  expect(contents(f.store)).toEqual(before)
  expect(f.calls()).toBe(0)
})

test('security_matrix_zero_leak: every public legacy/resource/stream surface rejects absent and infrastructure authority', async () => {
  const f = await application(), before = contents(f.store)
  for (const [path, method, body] of [
    ['patients', 'GET'], ['monitoring', 'GET'], ['bookings', 'GET'], ['alerts', 'GET'], ['reviews', 'GET'],
    ['plans', 'GET'], ['reviews/foreign/stream', 'GET'], ['reviews/foreign/events', 'GET'],
    ['discharge', 'POST', { input_value: 'M11 denied' }], ['checkins', 'POST', { input_value: '{}' }],
    ['plans/draft', 'POST', {}], ['reviews', 'POST', {}], ['reviews/foreign/resume', 'POST', {}],
    ['reviews/foreign/decisions', 'POST', {}], ['care-plan-drafts/foreign/reviews', 'POST', {}],
    ['answers', 'POST', { patient_id: f.first.id, query: 'M11 denied' }],
  ] as [string, string, unknown?][]) for (const token of [null, f.config.apiKey]) {
    expect((await f.app.handle(f.request(path, token, method, body))).status).toBe(401)
  }
  expect(contents(f.store)).toEqual(before)
  expect(f.calls()).toBe(0)
})

test('security_matrix_zero_leak: live assignment revocation and domain read-only mode reject writes before effects', async () => {
  const f = await application()
  expect((await f.app.handle(f.request(`patients/${f.first.id}/overview`, f.nurse.sessionToken))).status).toBe(200)
  await f.store.transaction(tx => tx.run('UPDATE patient_assignments SET revoked_at=?,revoked_by=? WHERE patient_id=?', [NOW, 'operator', f.first.id]))
  const before = contents(f.store)
  for (const path of [`patients/${f.first.id}/overview`, `checkins/${f.report.id}`, `bookings/${f.booking.id}`, `alerts/${f.alert.id}`]) {
    expect((await f.app.handle(f.request(path, f.nurse.sessionToken))).status).toBe(404)
  }
  const app = createApp({ ...f.deps, config: { ...f.config, readOnly: true } })
  for (const [path, body] of [
    [`patients/${f.first.id}/checkins`, { message: 'M11 read-only forbidden' }],
    [`patients/${f.first.id}/bookings`, bookingInput()],
    [`patients/${f.first.id}/questions`, { query: 'M11 read-only question' }],
  ] as [string, unknown][]) expect((await app.handle(f.request(path, f.patient.sessionToken, 'POST', body))).status).toBe(403)
  expect(contents(f.store)).toEqual(before)
  expect(f.calls()).toBe(0)
})

test('security_matrix_zero_leak: storage failure is sanitized and cannot commit a partial report/outbox receipt', async () => {
  const f = await application()
  await f.store.transaction(tx => tx.run("CREATE TRIGGER m11_failure BEFORE INSERT ON processing_attempts BEGIN SELECT RAISE(ABORT,'M11_PRIVATE_STORAGE_SENTINEL'); END"))
  const before = contents(f.store)
  const response = await f.app.handle(f.request(`patients/${f.first.id}/checkins`, f.patient.sessionToken, 'POST', { message: 'M11 failed synthetic report' }))
  expect(response.status).toBeGreaterThanOrEqual(500)
  const text = await response.text()
  expect(text).not.toContain('M11_PRIVATE_')
  expect(text).not.toContain('sessionToken')
  expect(contents(f.store)).toEqual(before)
  expect(f.calls()).toBe(0)
})
