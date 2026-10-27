import {readPrivateJson} from '../src/security/private-files.cjs'
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { loadConfig } from '../src/config.ts'
import { Store } from '../src/storage/database.ts'
import { AuthService } from '../src/modules/auth/service.ts'
import { ProvisionService } from '../src/modules/auth/provision.ts'
import { ConfirmationService } from '../src/modules/assessments/confirmation.ts'
import type { Assessment } from '../src/modules/assessments/service.ts'
import type { Discharge } from '../src/modules/patients/discharge.ts'

interface Account { identifier: string; password: string }
const accounts = readPrivateJson(new URL('../data/local-demo-accounts.json', import.meta.url)) as {
  operator: Account; nurses: Account[]; patients: Account[]
}
const manifest = readPrivateJson(new URL('../data/local-demo-manifest.json', import.meta.url)) as {
  nurses: { identifier: string; accountId: string }[]; patients: { identifier: string; patientId: string }[]
}
const config = loadConfig(), store = Store.open({ path: config.consoleStateDbPath, reviewPath: config.reviewDbPath })
await store.migrate()
const auth = new AuthService(store), provision = new ProvisionService(store), confirmations = new ConfirmationService(store)
const issued: string[] = []
let operatorToken: string | undefined, passed = 0
class CheckFailure extends Error {}
function check(condition: boolean, label: string) { if (!condition) throw new CheckFailure(label); passed++ }
const base = 'http://127.0.0.1:8080'
const request = (path: string, token: string, method='GET', body?: unknown, key=randomUUID()) => fetch(`${base}/api/v1${path}`, {
  method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'Idempotency-Key': key },
  ...(body===undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error',
})
async function data<T>(response: Response): Promise<T> {
  check(response.ok, `http_${response.status}`)
  return (await response.json() as { data: T }).data
}
async function login(account: Account) {
  const response = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: account.identifier, password: account.password }), redirect: 'error' })
  const grant = await data<{ sessionToken: string; principal: { id: string; role: 'patient' | 'nurse' } }>(response)
  issued.push(grant.sessionToken)
  return grant
}
const source = `DATA SINTETIS UNTUK DEMO SYNCARE, BUKAN PASIEN NYATA.
Diagnosis: congestive heart failure (CHF), NYHA III.
length_of_stay_days: 6. admission_type: emergency. comorbidity_count: 4. admissions_prior_12m: 3.
Obat: furosemide 40 mg sekali sehari.
Instruksi: pembatasan garam dan kontrol sesuai arahan dokter.
Kebutuhan tindak lanjut: pemantauan gejala dan kepatuhan obat.`

try {
  const operator = await auth.login(accounts.operator.identifier, accounts.operator.password)
  operatorToken = operator.sessionToken
  for (const nurse of manifest.nurses) {
    if (store.get('SELECT id FROM capability_grants WHERE account_id=? AND capability=? AND revoked_at IS NULL', [nurse.accountId, 'risk.confirm'])) continue
    const version = store.get<{ version: number }>('SELECT version FROM accounts WHERE id=?', [nurse.accountId])!.version
    await provision.setCapability({ principal: operator.principal, requestId: randomUUID() }, {
      accountId: nurse.accountId, capability: 'risk.confirm', operation: 'grant', expectedVersion: version,
    })
  }
  const nurse = await login(accounts.nurses[0]!), other = await login(accounts.nurses[1]!), patient = await login(accounts.patients[0]!)
  const patientId = manifest.patients[0]!.patientId
  const version = (await data<{ version: number }>(await request(`/patients/${patientId}`, nurse.sessionToken))).version
  const first = (await data<{ resource: Discharge }>(await request(`/patients/${patientId}/discharges`, nurse.sessionToken, 'POST', { sourceText: source, expectedPatientVersion: version }))).resource
  check(first.sourceText===source, 'source_text_exact')
  check((await request(`/discharges/${first.id}/assessments`, other.sessionToken, 'POST', {})).status===404, 'other_nurse_denied')
  check((await request(`/discharges/${first.id}/assessments`, patient.sessionToken, 'POST', {})).status===403, 'patient_cannot_assess')
  console.log(JSON.stringify({ stage: 'actual_f1_v1_running', credentialsPrinted: false }))
  const intent = randomUUID()
  const assessment = await data<Assessment>(await request(`/discharges/${first.id}/assessments`, nurse.sessionToken, 'POST', {}, intent))
  check(assessment.state==='SUCCEEDED' && assessment.output!==null, 'actual_f1_valid_v1')
  check(assessment.dischargeId===first.id && assessment.sourceVersion===first.version, 'exact_f1_source_v1')
  const repeat = await data<Assessment>(await request(`/discharges/${first.id}/assessments`, nurse.sessionToken, 'POST', {}, intent))
  check(repeat.id===assessment.id, 'same_key_same_assessment')
  const wrongCategory = assessment.output!.tier==='LOW' ? 'HIGH' : 'LOW'
  check((await request(`/assessments/${assessment.id}/confirmations`, nurse.sessionToken, 'POST', { expectedVersion: assessment.version, category: wrongCategory })).status===422, 'manual_override_denied')
  check(confirmations.summary({ principal: { ...patient.principal, capabilities: [] }, requestId: randomUUID() }, patientId).current===null, 'proposal_not_confirmation')
  await data(await request(`/assessments/${assessment.id}/confirmations`, nurse.sessionToken, 'POST', { expectedVersion: assessment.version, category: assessment.output!.tier }))
  const ctx = { principal: { ...patient.principal, capabilities: [] }, requestId: randomUUID() }
  check(confirmations.summary(ctx, patientId).status==='confirmed', 'v1_confirmed')
  const nextVersion = (await data<{ version: number }>(await request(`/patients/${patientId}`, nurse.sessionToken))).version
  const second = (await data<{ resource: Discharge }>(await request(`/patients/${patientId}/discharges`, nurse.sessionToken, 'POST', {
    sourceText: `${source}\nVersi sumber diperbarui untuk uji konfirmasi ulang.`, expectedPatientVersion: nextVersion,
  }))).resource
  check(second.id!==first.id && second.version===first.version+1, 'new_immutable_source')
  check(confirmations.summary(ctx, patientId).status==='needs_reassessment', 'q03_requires_reassessment')
  console.log(JSON.stringify({ stage: 'actual_f1_v2_running', credentialsPrinted: false }))
  const reassessed = await data<Assessment>(await request(`/discharges/${second.id}/assessments`, nurse.sessionToken, 'POST', {}))
  check(reassessed.state==='SUCCEEDED' && reassessed.output!==null, 'actual_f1_valid_v2')
  check(confirmations.summary(ctx, patientId).status==='needs_reassessment', 'new_f1_does_not_autoconfirm')
  await data(await request(`/assessments/${reassessed.id}/confirmations`, nurse.sessionToken, 'POST', { expectedVersion: reassessed.version, category: reassessed.output!.tier }))
  check(confirmations.summary(ctx, patientId).current?.assessmentId===reassessed.id, 'v2_confirmation_active')
  check(store.get('SELECT id FROM risk_confirmations WHERE assessment_id=?', [assessment.id])!==null, 'old_confirmation_retained')
  const persisted = store.get<{ raw_json: string; output_json: string }>('SELECT raw_json,output_json FROM assessments WHERE id=?', [reassessed.id])!
  check(JSON.stringify(JSON.parse(JSON.parse(persisted.raw_json).outputText))===persisted.output_json, 'original_f1_json_retained')
  const evidence = { status: 'pass', verifiedAt: new Date().toISOString(), checksPassed: passed, mockedBackend: false, mockedLangflow: false,
    patientId, dischargeIds: [first.id, second.id], assessmentIds: [assessment.id, reassessed.id], tiers: [assessment.output!.tier, reassessed.output!.tier],
    sourceVersions: [first.version, second.version], credentialsPrinted: false }
  writeFileSync(new URL('../data/m03-live-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
} catch (error) {
  console.error(JSON.stringify({ status: 'fail', checksPassed: passed, check: error instanceof CheckFailure ? error.message : 'local_risk_verification_failed', credentialsPrinted: false }))
  process.exitCode = 1
} finally {
  for (const token of issued) await request('/auth/session', token, 'DELETE').catch(() => {})
  if (operatorToken) await auth.revoke((await auth.inspect(operatorToken)).sessionId).catch(() => {})
  store.close()
}
