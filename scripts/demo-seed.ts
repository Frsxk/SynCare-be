import { Database } from 'bun:sqlite'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/storage/database.ts'
import { AuthService } from '../src/modules/auth/service.ts'
import { bootstrapOperator, ProvisionService } from '../src/modules/auth/provision.ts'
import { PatientService } from '../src/modules/patients/service.ts'
import { AssignmentService } from '../src/modules/patients/assignments.ts'
import { DischargeService } from '../src/modules/patients/discharge.ts'
import { AssessmentService } from '../src/modules/assessments/service.ts'
import { ConfirmationService } from '../src/modules/assessments/confirmation.ts'
import { CheckinService } from '../src/modules/checkins/service.ts'
import { CheckinProcessor } from '../src/modules/checkins/processor.ts'
import { AlertProducer } from '../src/modules/alerts/producer.ts'
import { seedDemoCatalog } from '../src/modules/homecare/catalog.ts'
import { CursorCodec } from '../src/modules/contracts/pagination.ts'
import { runFlow, type FlowRunResult } from '../src/plugins/langflow.ts'
import { FlowGateway, type F2Binding, type F2Context } from '../src/modules/workflows/flow-gateway.ts'
import { loadConfig } from '../src/config.ts'
import { readPrivateJson, writePrivateJson } from '../src/security/private-files.cjs'

export interface DemoRoot { root: string; parent: string; mode: 'local-synthetic' }
export interface DemoRunners { kind: 'verified_langflow' | 'injected_fixture'; runF1: (source: string, sessionId: string) => Promise<FlowRunResult>; runF2: (context: F2Context) => Promise<FlowRunResult> }
interface DemoCase { slot: 'low' | 'high'; patientId: string; accountId: string; nurseId: string; dischargeId: string; assessmentId: string; confirmationId: string; reportId: string; baseline: number; outcome: string }
export interface DemoManifest {
  version: 1; rootId: string; parentHash: string; syntheticOnly: true; stage: 'INITIALIZING' | 'READY'; runnerKind: DemoRunners['kind']; canonicalBinding: 'not_configured'; createdAt: string;
  credentialHash?: string; contentHash?: string; accountIds: string[]; cases: DemoCase[];
}
const liveRoot = fileURLToPath(new URL('../data/', import.meta.url))
const inventory = new Set(['manifest.json', 'credentials-private.json', 'state.sqlite3', 'state.sqlite3-wal', 'state.sqlite3-shm', 'state.sqlite3-journal'])
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const comparable = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
const within = (base: string, child: string) => { const path = relative(comparable(base), comparable(child)); return path === '' || (!path.startsWith('..') && !isAbsolute(path)) }
function refuse(code: string): never { throw new Error(code) }

function clinicalContents(root: string) {
  const db = new Database(join(root, 'state.sqlite3'), { readonly: true, strict: true })
  try {
    const content = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('sessions','operational_audit') ORDER BY name").all().map(({ name }) => [name, db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort()])
    return hash(JSON.stringify(content))
  } finally { db.close() }
}

function guard(options: DemoRoot, existing: boolean) {
  if (options.mode !== 'local-synthetic' || process.env.NODE_ENV === 'production') refuse('synthetic_mode_required')
  if (!isAbsolute(options.root) || !isAbsolute(options.parent)) refuse('absolute_test_root_required')
  const declaredParent = resolve(options.parent), declaredRoot = resolve(options.root)
  if (within(resolve(liveRoot), declaredRoot) || !/^syncare-demo-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(basename(declaredRoot))) refuse('unsafe_demo_root')
  if (!existsSync(declaredParent) || !lstatSync(declaredParent).isDirectory() || lstatSync(declaredParent).isSymbolicLink()) refuse('invalid_test_parent')
  if (comparable(dirname(declaredRoot)) !== comparable(declaredParent)) refuse('test_parent_mismatch')
  const parent = realpathSync.native(declaredParent), root = join(parent, basename(declaredRoot))
  if (within(resolve(liveRoot), root)) refuse('unsafe_demo_root')
  const keyPath = process.env.SYNCARE_PRIVATE_KEY_FILE
  const physicalKeyPath = keyPath && isAbsolute(keyPath) && existsSync(keyPath) ? realpathSync.native(keyPath) : keyPath
  if (process.platform !== 'win32' && physicalKeyPath && isAbsolute(physicalKeyPath) && within(root, resolve(physicalKeyPath))) refuse('private_key_inside_demo_root')
  if (existing) {
    if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink() || comparable(realpathSync.native(root)) !== comparable(root)) refuse('unsafe_demo_root')
    if (process.platform !== 'win32' && (lstatSync(root).mode & 0o077) !== 0) refuse('unsafe_demo_root_permissions')
    for (const entry of readdirSync(root)) {
      const stat = lstatSync(join(root, entry))
      if (!inventory.has(entry) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) refuse('unowned_demo_content')
    }
  }
  return { root, parent, rootId: basename(root).slice('syncare-demo-'.length), parentHash: hash(comparable(parent)) }
}

function manifestAt(options: DemoRoot) {
  const guarded = guard(options, true)
  let manifest: DemoManifest
  try { manifest = JSON.parse(readFileSync(join(guarded.root, 'manifest.json'), 'utf8')) } catch { return refuse('invalid_demo_marker') }
  if (manifest.version !== 1 || manifest.syntheticOnly !== true || manifest.rootId !== guarded.rootId || manifest.parentHash !== guarded.parentHash || !Array.isArray(manifest.accountIds) || !Array.isArray(manifest.cases)) refuse('invalid_demo_marker')
  return { ...guarded, manifest }
}

export function inspectDemo(options: DemoRoot) {
  const { root, manifest } = manifestAt(options)
  if (manifest.stage !== 'READY') refuse('incomplete_demo_requires_manual_inspection')
  const credentialsPath = join(root, 'credentials-private.json')
  const credentialsText = readFileSync(credentialsPath, 'utf8')
  if (hash(credentialsText) !== manifest.credentialHash) refuse('demo_credentials_changed')
  const credentials = readPrivateJson(credentialsPath) as { operator?: { password?: unknown }; cursorSecret?: unknown }
  if (typeof credentials?.operator?.password !== 'string' || typeof credentials.cursorSecret !== 'string') refuse('invalid_demo_credentials')
  if (process.platform !== 'win32') {
    const stat = lstatSync(credentialsPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) refuse('unsafe_demo_credentials')
  }
  if (clinicalContents(root) !== manifest.contentHash) refuse('demo_records_changed')
  const db = new Database(join(root, 'state.sqlite3'), { readonly: true, strict: true })
  try {
    const accounts = db.query<{ id: string; identifier: string }, []>('SELECT id,identifier FROM accounts').all()
    if (accounts.length !== manifest.accountIds.length || accounts.some(row => !manifest.accountIds.includes(row.id) || !row.identifier.endsWith('@synthetic.invalid'))) refuse('foreign_account_in_demo')
    const patients = db.query<{ id: string }, []>('SELECT id FROM patients').all()
    if (patients.length !== manifest.cases.length || patients.some(row => !manifest.cases.some(value => value.patientId === row.id))) refuse('foreign_patient_in_demo')
    for (const value of manifest.cases) {
      const row = db.query<{ state: string; output_json: string }, [string]>('SELECT state,output_json FROM processing_attempts WHERE checkin_id=?').get(value.reportId)
      if (row?.state !== 'SUCCEEDED' || JSON.parse(row.output_json).action !== value.outcome) refuse('demo_evidence_changed')
    }
    return manifest
  } finally { db.close() }
}

export async function seedDemo(options: DemoRoot, runners: DemoRunners) {
  if (existsSync(options.root)) return inspectDemo(options)
  const { root, rootId, parentHash } = guard(options, false)
  mkdirSync(root, { mode: 0o700 })
  const manifest: DemoManifest = { version: 1, rootId, parentHash, syntheticOnly: true, stage: 'INITIALIZING', runnerKind: runners.kind, canonicalBinding: 'not_configured', createdAt: new Date().toISOString(), accountIds: [], cases: [] }
  const save = () => writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
  save()
  const credentials = { operator: { identifier: `operator-${rootId}@synthetic.invalid`, password: randomBytes(32).toString('base64url') },
    nurses: ['low', 'high'].map(slot => ({ slot, identifier: `nurse-${slot}-${rootId}@synthetic.invalid`, password: randomBytes(32).toString('base64url') })),
    patients: ['low', 'high'].map(slot => ({ slot, identifier: `patient-${slot}-${rootId}@synthetic.invalid`, password: randomBytes(32).toString('base64url') })), cursorSecret: randomBytes(48).toString('base64url') }
  const credentialsPath = join(root, 'credentials-private.json')
  writePrivateJson(credentialsPath, credentials)
  if ((readPrivateJson(credentialsPath) as typeof credentials).operator.password !== credentials.operator.password) refuse('private_roundtrip_failed')
  manifest.credentialHash = hash(readFileSync(credentialsPath, 'utf8')); save()
  const store = Store.open({ path: join(root, 'state.sqlite3'), create: true, reviewPath: join(root, 'review-not-bound.sqlite3') })
  const sessions: string[] = []
  let auth: AuthService | undefined
  try {
    await store.migrate()
    await bootstrapOperator(store, credentials.operator)
    auth = new AuthService(store)
    const login = async (account: { identifier: string; password: string }) => { const grant = await auth!.login(account.identifier, account.password); sessions.push((await auth!.inspect(grant.sessionToken)).sessionId); return grant.principal }
    const operator = await login(credentials.operator)
    manifest.accountIds.push(operator.id); save()
    const context = (principal: Awaited<ReturnType<typeof login>>) => ({ principal, requestId: randomUUID(), idempotencyKey: randomUUID() })
    const provision = new ProvisionService(store), assignments = new AssignmentService(store)
    const patients = new PatientService(store, { codec: new CursorCodec(credentials.cursorSecret) })
    const discharges = new DischargeService(store)
    const assessments = new AssessmentService(store, { codec: new CursorCodec(credentials.cursorSecret), runF1: runners.runF1 })
    const checkins = new CheckinService(store, { codec: new CursorCodec(credentials.cursorSecret) })
    const processor = new CheckinProcessor(store, { runF2: runners.runF2 })
    await seedDemoCatalog(store)
    for (const slot of ['low', 'high'] as const) {
      const nurseInput = credentials.nurses.find(value => value.slot === slot)!
      const nurse = await provision.provisionNurse(context(operator), { ...nurseInput, capabilities: ['patient.manage', 'patient.provision', 'risk.confirm', 'booking.manage', 'alert.manage', 'review.decide'] })
      manifest.accountIds.push(nurse.accountId); save()
      const staff = await login(nurseInput)
      const patient = (await patients.create(context(staff), { profile: { displayName: `Pasien sintetis M11 ${slot}` }, initialCondition: 'DATA DEMO SINTETIS, bukan pasien nyata.' })).resource
      await assignments.assign(context(operator), patient.id, { nurseAccountId: staff.id, operation: 'grant', expectedVersion: patient.version })
      const patientInput = credentials.patients.find(value => value.slot === slot)!
      const account = await provision.provision(context(staff), { patientId: patient.id, identifier: patientInput.identifier, activationInput: { password: patientInput.password } })
      manifest.accountIds.push(account.accountId); save()
      const owner = await login(patientInput)
      const episode = slot === 'low'
        ? 'DATA DEMO SINTETIS M11 LOW. Diagnosis: congestive heart failure (CHF), stabil. length_of_stay_days: 1. admission_type: elective. comorbidity_count: 0. admissions_prior_12m: 0.'
        : 'DATA DEMO SINTETIS M11 HIGH. Diagnosis: congestive heart failure (CHF), NYHA III. length_of_stay_days: 6. admission_type: emergency. comorbidity_count: 4. admissions_prior_12m: 3.'
      const source = `${episode}\nBukan pasien nyata.\nObat: furosemide 40 mg sekali sehari.\nInstruksi: pembatasan garam dan kontrol sesuai arahan dokter.\nKebutuhan tindak lanjut: pemantauan gejala dan kepatuhan obat.`
      const discharge = (await discharges.addDischarge(context(staff), patient.id, { expectedPatientVersion: patient.version + 1, sourceText: source })).resource
      const assessment = await assessments.run(context(staff), discharge.id)
      if (assessment.state !== 'SUCCEEDED' || !assessment.output || assessment.output.tier !== slot.toUpperCase()) refuse('demo_assessment_not_expected')
      const confirmation = (await new ConfirmationService(store).confirm(context(staff), assessment.id, { expectedVersion: assessment.version, category: assessment.output.tier })).resource
      const report = (await checkins.submit(context(owner), patient.id, { message: slot === 'low' ? 'DATA DEMO SINTETIS M11. Sesak napas berat saat istirahat dan nyeri dada hebat sekarang.' : 'DATA DEMO SINTETIS M11. Hari ini baik, tidak ada keluhan. Obat diminum teratur.' })).resource
      const processed = await processor.process(report.id, report.processing.id)
      const expected = slot === 'low' ? 'escalate_immediately' : 'continue_monitoring'
      if (processed.processing.state !== 'SUCCEEDED' || processed.outcome?.action !== expected) refuse('demo_report_not_expected')
      manifest.cases.push({ slot, patientId: patient.id, accountId: account.accountId, nurseId: staff.id, dischargeId: discharge.id, assessmentId: assessment.id, confirmationId: confirmation.id, reportId: report.id, baseline: assessment.output.score, outcome: expected }); save()
    }
    const producer = new AlertProducer(store)
    await producer.reconcile(); await producer.processNext()
  } finally {
    for (const session of sessions) await auth?.revoke(session)
    store.close()
  }
  manifest.contentHash = clinicalContents(root); manifest.stage = 'READY'; save()
  return inspectDemo(options)
}

export function resetDemo(options: DemoRoot, confirmation: string) {
  const { root, manifest } = manifestAt(options)
  if (confirmation !== manifest.rootId) refuse('explicit_root_confirmation_required')
  if (manifest.stage !== 'READY') refuse('incomplete_demo_requires_manual_inspection')
  inspectDemo(options)
  guard(options, true)
  for (const name of readdirSync(root)) {
    const target = join(root, name)
    if (dirname(target) !== root || !inventory.has(name) || lstatSync(target).isSymbolicLink() || lstatSync(target).nlink !== 1) refuse('unsafe_reset_target')
    unlinkSync(target)
  }
  rmdirSync(root)
}

export interface DemoCliIo { stdout?: (line: string) => void; stderr?: (line: string) => void }

export async function main(args: string[], io: DemoCliIo = {}): Promise<number> {
  const stdout = io.stdout ?? ((line: string) => console.log(line)), stderr = io.stderr ?? ((line: string) => console.error(line))
  try {
    const command = args[0]
    const flag = (name: string) => {
      const prefix = `--${name}=`, inline = args.find(value => value.startsWith(prefix))
      if (inline) return inline.slice(prefix.length)
      const index = args.indexOf(`--${name}`), value = index >= 0 ? args[index + 1] : undefined
      return value && !value.startsWith('--') ? value : ''
    }
    if (!args.includes('--local-synthetic')) refuse('synthetic_mode_required')
    const options: DemoRoot = { root: flag('root'), parent: flag('parent'), mode: 'local-synthetic' }
    if (command === 'inspect') { const manifest = inspectDemo(options); stdout(JSON.stringify({ status: 'ready', rootId: manifest.rootId, cases: manifest.cases.length, runnerKind: manifest.runnerKind, credentialsPrinted: false, canonicalBinding: manifest.canonicalBinding })) }
    else if (command === 'reset') { resetDemo(options, flag('confirm')); stdout(JSON.stringify({ status: 'isolated_root_reset', credentialsPrinted: false })) }
    else if (command === 'init') {
      const config = loadConfig(), flows = JSON.parse(readFileSync(new URL('../flows.json', import.meta.url), 'utf8'))
      const bindingPath = process.env.SYNCARE_F2_CONTEXT_CONFIG
      const binding = bindingPath ? JSON.parse(readFileSync(bindingPath, 'utf8')) as F2Binding : null
      const gateway = new FlowGateway({ binding, baseUrl: config.langflowBaseUrl, apiKey: config.langflowApiKey })
      const manifest = await seedDemo(options, { kind: 'verified_langflow', runF1: (source, sessionId) => runFlow(flows.f1_register_discharge_summary, source, { sessionId }), runF2: context => gateway.runF2(context) })
      stdout(JSON.stringify({ status: 'ready', rootId: manifest.rootId, cases: manifest.cases.length, credentialsPrinted: false, canonicalBinding: manifest.canonicalBinding }))
    } else refuse('explicit_command_required')
    return 0
  } catch (error) {
    const code = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'demo_operation_failed'
    stderr(JSON.stringify({ status: 'not_ready', code, automaticReset: false, credentialsPrinted: false })); return 1
  }
}

if (import.meta.main) { const exitCode = await main(Bun.argv.slice(2)); if (exitCode !== 0) process.exitCode = exitCode }
