import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadConfig } from '../src/config.ts'
import { Store } from '../src/storage/database.ts'
import { AuthService } from '../src/modules/auth/service.ts'
import { bootstrapOperator, ProvisionService } from '../src/modules/auth/provision.ts'
import { PatientService, exactObject } from '../src/modules/patients/service.ts'
import { AssignmentService } from '../src/modules/patients/assignments.ts'
import { CursorCodec } from '../src/modules/contracts/pagination.ts'
import { DomainError } from '../src/modules/contracts/errors.ts'

let store: Store | undefined
try {
  if (Bun.argv[2] !== '--initialize') throw new DomainError('validation_failed')
  const text = await Bun.stdin.text()
  if (Buffer.byteLength(text) > 32768) throw new DomainError('validation_failed')
  const input = exactObject(JSON.parse(text), ['operator', 'nurses', 'patients'])
  const operator = exactObject(input.operator, ['identifier', 'password'])
  if (!Array.isArray(input.nurses) || input.nurses.length < 2 || input.nurses.length > 10 ||
      !Array.isArray(input.patients) || input.patients.length < 2 || input.patients.length > 10) throw new DomainError('validation_failed')
  const config = loadConfig()
  const cursorSecret = process.env.SYNCARE_CURSOR_SECRET ?? ''
  if (Buffer.byteLength(cursorSecret) < 32) throw new DomainError('validation_failed')
  store = Store.open({ path: config.consoleStateDbPath, create: true, reviewPath: config.reviewDbPath })
  await store.migrate()
  await bootstrapOperator(store, operator as { identifier: string; password: string })
  const auth = new AuthService(store)
  const provision = new ProvisionService(store)
  const patients = new PatientService(store, { codec: new CursorCodec(cursorSecret) })
  const assignments = new AssignmentService(store)
  const operatorSession = await auth.login(operator.identifier as string, operator.password as string)
  const context = (principal: typeof operatorSession.principal) => ({ principal, requestId: randomUUID(), idempotencyKey: randomUUID() })
  const nurses = new Map<string, { accountId: string; session: Awaited<ReturnType<AuthService['login']>> }>()
  const manifest: { nurses: { identifier: string; accountId: string }[]; patients: { identifier: string; accountId: string; patientId: string; nurseIdentifier: string }[] } = { nurses: [], patients: [] }
  for (const raw of input.nurses) {
    const nurse = exactObject(raw, ['identifier', 'password', 'capabilities']) as { identifier: string; password: string; capabilities: string[] }
    const saved = await provision.provisionNurse(context(operatorSession.principal), nurse)
    const session = await auth.login(nurse.identifier, nurse.password)
    nurses.set(nurse.identifier, { accountId: saved.accountId, session })
    manifest.nurses.push({ identifier: nurse.identifier, accountId: saved.accountId })
  }
  for (const raw of input.patients) {
    const patient = exactObject(raw, ['identifier', 'password', 'displayName', 'nurseIdentifier']) as Record<string, string>
    const nurse = nurses.get(patient.nurseIdentifier!)
    if (!nurse) throw new DomainError('validation_failed')
    const profile = (await patients.create(context(nurse.session.principal), { profile: { displayName: patient.displayName }, initialCondition: null })).resource
    await assignments.assign(context(operatorSession.principal), profile.id, { nurseAccountId: nurse.accountId, operation: 'grant', expectedVersion: profile.version })
    const account = await provision.provision(context(nurse.session.principal), { patientId: profile.id, identifier: patient.identifier, activationInput: { password: patient.password } })
    manifest.patients.push({ identifier: patient.identifier!, accountId: account.accountId, patientId: profile.id, nurseIdentifier: patient.nurseIdentifier! })
  }
  for (const session of [operatorSession, ...[...nurses.values()].map(nurse => nurse.session)]) await auth.revoke((await auth.inspect(session.sessionToken)).sessionId)
  const manifestPath = join(dirname(config.consoleStateDbPath), 'local-demo-manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' })
  console.log(JSON.stringify({ status: 'initialized', nurseCount: manifest.nurses.length, patientCount: manifest.patients.length, credentialsReturned: false }))
} catch (error) {
  console.error(JSON.stringify({ status: 'not_initialized', code: error instanceof DomainError ? error.code : 'initialization_failed', automaticReset: false }))
  process.exitCode = 1
} finally { store?.close() }
