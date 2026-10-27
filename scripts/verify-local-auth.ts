import {unprotectEnvironment} from '../src/security/private-files.cjs'
unprotectEnvironment()
import {readPrivateJson} from '../src/security/private-files.cjs'
import { randomUUID } from 'node:crypto'

const base = 'http://127.0.0.1:8080'
const input = readPrivateJson(new URL('../data/local-demo-accounts.json', import.meta.url)) as {
  operator: { identifier: string; password: string }; nurses: { identifier: string; password: string }[]; patients: { identifier: string; password: string }[]
}
const manifest = readPrivateJson(new URL('../data/local-demo-manifest.json', import.meta.url)) as {
  patients: { identifier: string; patientId: string; nurseIdentifier: string }[]
}
const issued: string[] = []
let passed = 0
class CheckFailure extends Error {}
const check = (condition: boolean, label: string) => { if (!condition) throw new CheckFailure(label); passed++ }
const data = async <T>(response: Response): Promise<T> => (await response.json() as { data: T }).data
const request = (path: string, token?: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => fetch(`${base}${path}`, {
  method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...extra },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error',
})
const login = async (account: { identifier: string; password: string }) => {
  const response = await request('/api/v1/auth/login', undefined, 'POST', { identifier: account.identifier, password: account.password })
  check(response.status === 200, 'login_http')
  const grant = await data<{ sessionToken: string; principal: { id: string; role: string; patientId?: string } }>(response)
  issued.push(grant.sessionToken)
  return grant
}

try {
  const patientA = await login(input.patients[0]!), patientB = await login(input.patients[1]!)
  const first = manifest.patients[0]!, second = manifest.patients[1]!
  check(patientA.principal.patientId === first.patientId && patientB.principal.patientId === second.patientId, 'patient_mapping')
  check((await request(`/api/v1/patients/${first.patientId}`, patientA.sessionToken)).status === 200, 'own_profile')
  check((await request(`/api/v1/patients/${second.patientId}`, patientA.sessionToken)).status === 404, 'cross_patient_denied')
  check((await request('/api/v1/patients', process.env.SYNCARE_API_KEY)).status === 401, 'master_not_user')
  check((await request('/api/v1/reviews/foreign/events', patientA.sessionToken)).status === 403, 'foreign_stream_denied')
  const nurseA = await login(input.nurses[0]!), nurseB = await login(input.nurses[1]!)
  const listA = await data<{ id: string }[]>(await request('/api/v1/patients', nurseA.sessionToken))
  const listB = await data<{ id: string }[]>(await request('/api/v1/patients', nurseB.sessionToken))
  check(listA.length === 2 && listB.length === 1 && listA.every(row => !listB.some(other => other.id === row.id)), 'nurse_list_isolation')
  const operator = await login(input.operator)
  const target = manifest.patients[2]!
  const profile = await data<{ version: number }>(await request(`/api/v1/patients/${target.patientId}`, nurseA.sessionToken))
  const revoke = await request(`/api/v1/patients/${target.patientId}/assignments`, operator.sessionToken, 'POST',
    { nurseAccountId: nurseA.principal.id, operation: 'revoke', expectedVersion: profile.version }, { 'Idempotency-Key': randomUUID() })
  check(revoke.status === 200, 'operator_revoke')
  const revoked = (await data<{ resource: { version: number } }>(revoke)).resource
  check((await request(`/api/v1/patients/${target.patientId}`, nurseA.sessionToken)).status === 404, 'revoke_effective')
  const grant = await request(`/api/v1/patients/${target.patientId}/assignments`, operator.sessionToken, 'POST',
    { nurseAccountId: nurseA.principal.id, operation: 'grant', expectedVersion: revoked.version }, { 'Idempotency-Key': randomUUID() })
  check(grant.status === 200, 'operator_regrant')
  check((await request(`/api/v1/patients/${target.patientId}`, nurseA.sessionToken)).status === 200, 'restored_assignment')
  check((await request('/api/v1/auth/session', patientA.sessionToken, 'DELETE')).status === 204, 'logout_revoke')
  check((await request('/api/v1/auth/session', patientA.sessionToken)).status === 401, 'revoked_restore_denied')
  console.log(JSON.stringify({ status: 'pass', checksPassed: passed, mockedBackend: false, credentialsPrinted: false, assignmentRestored: true }))
} catch (error) {
  console.error(JSON.stringify({ status: 'fail', checksPassed: passed, check: error instanceof CheckFailure ? error.message : 'local_verification_failed', credentialsPrinted: false }))
  process.exitCode = 1
} finally {
  for (const token of issued) await request('/api/v1/auth/session', token, 'DELETE').catch(() => {})
}
