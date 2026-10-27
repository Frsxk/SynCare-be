import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createApp } from '../src/app.ts'
import { assessmentFixture, f1Output } from './assessment.test.ts'

test('public M03 routes bind server source, reject injected F1 fields and never expose staff assessments to patient accounts', async () => {
  const setup = await assessmentFixture()
  let calls = 0
  const app = createApp({ store: setup.store, auth: setup.auth, cursorSecret: 'synthetic-clinical-routes-cursor-secret-32bytes',
    security: { backendOrigin: 'http://localhost', webOrigin: 'http://localhost:3000', allowLocalHttp: true },
    config: { langflowBaseUrl: 'http://127.0.0.1:59999', langflowApiKey: 'fixture-upstream', apiKey: 'fixture-master', reviewDbPath: import.meta.filename,
      consoleStateDbPath: setup.store.path, host: 'localhost', port: 8080, readOnly: false },
    flows: { f1_register_discharge_summary: '11111111-1111-4111-8111-111111111111' },
    runFlowImpl: async (_, text, options) => { calls++; expect(text).toBe(setup.discharge.sourceText); expect(options?.sessionId).toContain(setup.first.id);
      return { raw: {}, outputText: JSON.stringify(f1Output), sessionId: options?.sessionId ?? null } },
  })
  const nurse = await setup.auth.login('nurse-a@synthetic.invalid', setup.password)
  const other = await setup.auth.login('nurse-b@synthetic.invalid', setup.password)
  const patient = await setup.auth.login('patient-a@synthetic.invalid', setup.password)
  const request = (path: string, token: string, method='GET', body?: unknown) => app.handle(new Request(`http://localhost/api/v1${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    ...(body===undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const endpoint = `/discharges/${setup.discharge.id}/assessments`
  expect((await request(endpoint, 'fixture-master', 'POST', {})).status).toBe(401)
  expect((await request(endpoint, patient.sessionToken, 'POST', {})).status).toBe(403)
  expect((await request(endpoint, other.sessionToken, 'POST', {})).status).toBe(404)
  expect((await request(endpoint, nurse.sessionToken, 'POST', { score: 99, patientId: setup.second.id })).status).toBe(422)
  expect(calls).toBe(0)
  const response = await request(endpoint, nurse.sessionToken, 'POST', {})
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toContain('no-store')
  const assessment = (await response.json() as { data: { id: string; version: number } }).data
  expect((await request(`/patients/${setup.first.id}/assessments`, patient.sessionToken)).status).toBe(403)
  expect((await request(`/patients/${setup.second.id}/assessments`, nurse.sessionToken)).status).toBe(404)
  const list = await request(`/patients/${setup.first.id}/assessments`, nurse.sessionToken)
  expect(list.status).toBe(200)
  expect((await list.json() as { data: unknown[] }).data).toHaveLength(1)
  expect((await request(`/assessments/${assessment.id}/confirmations`, nurse.sessionToken, 'POST', { category: 'LOW', expectedVersion: assessment.version })).status).toBe(201)
  expect(calls).toBe(1)
  const currentVersion = setup.store.get<{ version: number }>('SELECT version FROM patients WHERE id=?', [setup.first.id])!.version
  expect((await request(`/patients/${setup.first.id}/discharges`, patient.sessionToken, 'POST', { sourceText: 'Source v2', expectedPatientVersion: currentVersion })).status).toBe(403)
  const next = await request(`/patients/${setup.first.id}/discharges`, nurse.sessionToken, 'POST', { sourceText: 'Source v2', expectedPatientVersion: currentVersion })
  expect(next.status).toBe(201)
  expect((await request(`/patients/${setup.first.id}/discharges`, nurse.sessionToken, 'POST', { sourceText: 'Source stale', expectedPatientVersion: currentVersion })).status).toBe(409)
  expect(setup.store.all('SELECT * FROM discharge_versions WHERE patient_id=?', [setup.first.id])).toHaveLength(2)
  const selfOverview = await request(`/patients/${setup.first.id}/overview`, patient.sessionToken)
  expect(selfOverview.status).toBe(200)
  const projection = (await selfOverview.json() as { data: { currentDischarge: { sourceText: string | null }; confirmedRisk: { status: string }; latestAssessment: unknown } }).data
  expect(projection.currentDischarge.sourceText).toBeNull()
  expect(projection.latestAssessment).toBeNull()
  expect(projection.confirmedRisk.status).toBe('needs_reassessment')
  expect((await request(`/patients/${setup.second.id}/overview`, nurse.sessionToken)).status).toBe(404)
  expect((await request(`/patients/${setup.first.id}/overview?patientId=${setup.second.id}`, patient.sessionToken)).status).toBe(422)
})
