import { expect, test } from 'bun:test'
import { createApp } from '../src/app.ts'
import { Policy } from '../src/modules/auth/policy.ts'
import type { ReviewDbReader } from '../src/plugins/review-db.ts'
import { patientFixture } from './patients.test.ts'
import { NOW } from './migrations/fixture.ts'

async function applicationFixture() {
  const setup = await patientFixture()
  let upstreamCalls = 0
  const app = createApp({
    store: setup.store, auth: setup.auth,
    cursorSecret: 'synthetic-resource-test-cursor-secret-32bytes',
    security: { backendOrigin: 'http://localhost', webOrigin: 'http://localhost:3000', allowLocalHttp: true },
    config: { langflowBaseUrl: 'http://127.0.0.1:59999', langflowApiKey: 'fixture-upstream-key',
      apiKey: 'fixture-infrastructure-key', reviewDbPath: import.meta.filename, consoleStateDbPath: setup.store.path,
      host: 'localhost', port: 8080, readOnly: false },
    flows: { f5_answer_care_questions: '11111111-1111-1111-1111-111111111111' },
    runFlowImpl: async () => { upstreamCalls++; return { raw: {}, outputText: 'Synthetic answer fixture', sessionId: null } },
    openDb: () => ({
      approvedPlans: () => [setup.first.id, setup.second.id].map(patientId => ({ patientId, plan_json: JSON.stringify({ patient_id: patientId }), reviewer_note: 'Internal fixture note', approved_at: NOW })),
      auditLog: () => [setup.first.id, setup.second.id, null].map(patientId => ({ patientId, action: 'Approve', actor: 'fixture-nurse', timestamp: NOW })),
      close: () => {},
    } as unknown as ReviewDbReader),
  })
  const patient = await setup.auth.login('patient-a@synthetic.invalid', setup.password)
  const nurse = await setup.auth.login('nurse-a@synthetic.invalid', setup.password)
  const request = (path: string, token: string | null = patient.sessionToken, method = 'GET', body?: unknown, origin?: string) => new Request(`http://localhost${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { ...setup, app, patient, nurse, request, calls: () => upstreamCalls }
}

test('policy_blocks_cross_patient: every public legacy entry rejects master authority and unowned IDs/jobs', async () => {
  const { app, request, patient, second, calls } = await applicationFixture()
  for (const [path, method, body] of [
    ['/api/v1/patients', 'GET', undefined], ['/api/v1/plans', 'GET', undefined],
    [`/api/v1/plans/${second.id}`, 'GET', undefined], ['/api/v1/discharge', 'POST', { input_value: 'fixture' }],
    ['/api/v1/checkins', 'POST', { input_value: '{}' }], ['/api/v1/plans/draft', 'POST', {}],
    ['/api/v1/reviews', 'POST', { draft: '{}' }], ['/api/v1/reviews/foreign/resume', 'POST', {}],
    ['/api/v1/reviews/foreign/events', 'GET', undefined], ['/api/v1/answers', 'POST', { patient_id: second.id, query: 'fixture' }],
    ['/api/v1/missing', 'GET', undefined],
  ] as const) {
    expect((await app.handle(request(path, 'fixture-infrastructure-key', method, body))).status).toBe(401)
    expect((await app.handle(request(path, null, method, body))).status).toBe(401)
  }
  expect((await app.handle(request(`/api/v1/plans/${second.id}`))).status).toBe(404)
  expect((await app.handle(request('/api/v1/answers', patient.sessionToken, 'POST', { patient_id: second.id, query: 'fixture' }))).status).toBe(404)
  for (const [path, method] of [['/api/v1/reviews/foreign/events', 'GET'], ['/api/v1/reviews/foreign/resume', 'POST'], ['/api/v1/checkins', 'POST']]) {
    expect((await app.handle(request(path!, patient.sessionToken, method!))).status).toBe(403)
  }
  expect(calls()).toBe(0)
})

test('scoped plan/list projections exclude other patients and private reviewer notes; revoke takes effect immediately', async () => {
  const { app, request, first, second, nurse, store } = await applicationFixture()
  const patientList = await app.handle(request('/api/v1/plans'))
  expect(patientList.status).toBe(200)
  expect(patientList.headers.get('cache-control')).toContain('no-store')
  const body = await patientList.json() as { plans: { patientId: string; reviewer_note: string }[]; audit: unknown[] }
  expect(body.plans).toEqual([])
  expect(body.audit).toEqual([])
  const staffList = await app.handle(request('/api/v1/plans', nurse.sessionToken))
  expect(await staffList.text()).not.toContain(second.id)
  await store.transaction(tx => tx.run('UPDATE patient_assignments SET revoked_at=?,revoked_by=? WHERE patient_id=?', [NOW, 'operator', first.id]))
  expect((await app.handle(request(`/api/v1/plans/${first.id}`, nurse.sessionToken))).status).toBe(404)
  const after = await app.handle(request('/api/v1/plans', nurse.sessionToken))
  expect((await after.json() as { plans: unknown[] }).plans).toEqual([])
})

test('public application mounts real login, rejects forged Origin/Host and keeps unknown API routes authenticated', async () => {
  const { app, request, password } = await applicationFixture()
  const input = { identifier: 'patient-a@synthetic.invalid', password }
  expect((await app.handle(request('/api/v1/auth/login', null, 'POST', input, 'https://attacker.invalid'))).status).toBe(403)
  expect((await app.handle(new Request('http://evil.invalid/api/v1/auth/login', { method: 'POST' }))).status).toBe(403)
  expect((await app.handle(request('/api/v1/auth/login', null, 'POST', input))).status).toBe(200)
  expect((await app.handle(request('/api/v1/auth/session'))).status).toBe(200)
  expect((await app.handle(request('/api/v1/not-existing'))).status).toBe(404)
  expect((await app.handle(request('/api/v1/not-existing', null))).status).toBe(401)
  expect((await app.handle(request('/api/v1/patients/encoded%2fother'))).status).toBe(422)
})

test('clinical capability and assignment are both required; cached capability arrays cannot retain a revoked grant', async () => {
  const { store, ctx, first } = await patientFixture()
  const policy = new Policy(store)
  await expect(policy.authorize(ctx().principal, 'risk.confirm', { patientId: first.id })).rejects.toMatchObject({ status: 403 })
  const forged = { ...ctx().principal, capabilities: ['risk.confirm'] }
  await expect(policy.authorize(forged, 'risk.confirm', { patientId: first.id })).rejects.toMatchObject({ status: 403 })
  await store.transaction(tx => tx.run('INSERT INTO capability_grants VALUES (?,?,?,?,?,?,?)', ['clinical-grant', 'nurse-b', 'risk.confirm', 'operator', NOW, null, null]))
  await expect(policy.authorize(ctx('nurse-b').principal, 'risk.confirm', { patientId: first.id })).rejects.toMatchObject({ status: 404 })
  await store.transaction(tx => tx.run('INSERT INTO capability_grants VALUES (?,?,?,?,?,?,?)', ['clinical-grant-a', 'nurse-a', 'risk.confirm', 'operator', NOW, null, null]))
  await policy.authorize(ctx().principal, 'risk.confirm', { patientId: first.id })
  await store.transaction(tx => tx.run('UPDATE capability_grants SET revoked_at=?,revoked_by=? WHERE id=?', [NOW, 'operator', 'clinical-grant-a']))
  await expect(policy.authorize(ctx().principal, 'risk.confirm', { patientId: first.id })).rejects.toMatchObject({ status: 403 })
})
