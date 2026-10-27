import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { protectText, readPrivateJson, unprotectText } from '../src/security/private-files.cjs'

const MAX_INPUT_BYTES = 2 * 1024 * 1024
const MAX_INPUTS = 64
const SECRET_ENV_KEY = /(?:^|_)(?:PASSWORD|PASSWD|PASS|PWD|SECRET|TOKEN|KEY)$/i
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const DEMO_ROOT = /^syncare-demo-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export interface ProtectCliIo { stdout?: (line: string) => void; stderr?: (line: string) => void; environment?: Record<string, string | undefined> }
interface ProtectInput { protect: boolean; operatorAuthorized: boolean; envFiles: string[]; jsonFiles: string[] }
interface EnvPlan { file: string; updated: string; changed: boolean; protectedValues: number; sealedValues: number }
interface Marker { file: string; value: Record<string, unknown> }
interface JsonPlan { file: string; updated: string; changed: boolean; protectedFile: boolean; sealedFile: boolean; expected: unknown; marker: Marker | null }

function refuse(code: string): never { throw new Error(code) }
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const comparable = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
const sealedPrefix = (text: string) => text.startsWith('dpapi:') || text.startsWith('aesgcm:')

function ownedFile(input: string): string {
  if (typeof input !== 'string' || !input.trim() || !isAbsolute(input)) refuse('absolute_path_required')
  const file = resolve(input)
  let stat
  try { stat = lstatSync(file) } catch { return refuse('input_file_missing') }
  if (stat.isSymbolicLink()) refuse('symlink_input_rejected')
  if (!stat.isFile()) refuse('input_not_regular_file')
  if (stat.nlink !== 1) refuse('input_hardlink_rejected')
  if (stat.size > MAX_INPUT_BYTES) refuse('input_too_large')
  const parent = dirname(file)
  let parentStat
  try { parentStat = lstatSync(parent) } catch { return refuse('unsafe_input_parent') }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) refuse('unsafe_input_parent')
  let real: string
  try { real = realpathSync.native(file) } catch { return refuse('unsafe_input_path') }
  if (process.platform !== 'win32' && comparable(real) !== comparable(file)) refuse('symlink_path_rejected')
  if (process.platform !== 'win32') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
    const sharedSticky = (parentStat.mode & 0o1000) !== 0 && (parentStat.mode & 0o002) !== 0
    if (typeof uid === 'number' && (stat.uid !== uid || (!sharedSticky && parentStat.uid !== uid))) refuse('input_not_owned')
    if ((stat.mode & 0o002) !== 0) refuse('unsafe_input_permissions')
    if ((parentStat.mode & 0o002) !== 0 && !sharedSticky) refuse('unsafe_input_parent')
  }
  return file
}

function parseArguments(argv: string[]): ProtectInput {
  let protect = false, operatorAuthorized = false
  const envFiles: string[] = [], jsonFiles: string[] = [], seen = new Set<string>()
  const collect = (target: string[], value: string) => {
    if (!value || value.startsWith('--')) refuse('argument_value_required')
    const key = comparable(resolve(value))
    if (seen.has(key)) refuse('duplicate_input_argument')
    seen.add(key); target.push(value)
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!
    if (argument === '--protect') protect = true
    else if (argument === '--operator-authorized') operatorAuthorized = true
    else if (argument === '--env-file' || argument === '--json-file') {
      const value = argv[++index]
      if (value === undefined) refuse('argument_value_required')
      collect(argument === '--env-file' ? envFiles : jsonFiles, value)
    } else if (argument.startsWith('--env-file=')) collect(envFiles, argument.slice('--env-file='.length))
    else if (argument.startsWith('--json-file=')) collect(jsonFiles, argument.slice('--json-file='.length))
    else if (argument.startsWith('--')) refuse('unknown_argument')
    else refuse('unexpected_argument')
  }
  if (!protect) refuse('explicit_protect_required')
  if (envFiles.length + jsonFiles.length === 0) refuse('explicit_input_required')
  if (envFiles.length + jsonFiles.length > MAX_INPUTS) refuse('too_many_inputs')
  return { protect, operatorAuthorized, envFiles, jsonFiles }
}

function replaceEnvValue(text: string, key: string, sealed: string, expected: string): string {
  const lines = text.split(/(\r?\n)/)
  let replaced = 0
  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index]!
    const match = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*).*$/.exec(line)
    if (match?.[2] !== key) continue
    let single: Record<string, string | undefined>
    try { single = parseEnv(line) } catch { return refuse('env_value_spans_lines') }
    if (single[key] !== expected) refuse('env_value_spans_lines')
    lines[index] = `${match[1]}${key}${match[3]}${sealed}`
    replaced++
  }
  if (replaced === 0) refuse('env_replacement_failed')
  if (replaced > 1) refuse('duplicate_env_secret_key')
  return lines.join('')
}

function assertEnvShape(original: string, updated: string, sealed: Map<string, string>): void {
  const newlines = (text: string) => text.match(/\n/g)?.length ?? 0
  if (newlines(original) !== newlines(updated)) refuse('env_file_shape_changed')
  const before = parseEnv(original), after = parseEnv(updated)
  const beforeKeys = Object.keys(before), afterKeys = Object.keys(after)
  if (beforeKeys.length !== afterKeys.length || beforeKeys.some((key, index) => afterKeys[index] !== key)) refuse('env_file_shape_changed')
  for (const key of beforeKeys) {
    const token = sealed.get(key)
    if (token === undefined ? after[key] !== before[key] : after[key] !== token) refuse('env_file_shape_changed')
  }
}

function planEnv(file: string, environment: Record<string, string | undefined>): EnvPlan {
  const text = readFileSync(file, 'utf8')
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) refuse('input_too_large')
  let parsed: Record<string, string | undefined>
  try { parsed = parseEnv(text) } catch { return refuse('invalid_env_input') }
  let updated = text, protectedValues = 0, sealedValues = 0
  const sealed = new Map<string, string>()
  for (const [key, value] of Object.entries(parsed)) {
    if (!value) continue
    if (!secretField(key) && !SECRET_ENV_KEY.test(key)) continue
    if (!ENV_KEY.test(key)) {
      if (sealedPrefix(value)) { unprotectText(value, environment); sealedValues++; continue }
      refuse('unsupported_env_secret_name')
    }
    if (sealedPrefix(value)) {
      unprotectText(value, environment)
      sealedValues++
      continue
    }
    const token = protectText(value, environment)
    if (unprotectText(token, environment) !== value) refuse('private_roundtrip_failed')
    updated = replaceEnvValue(updated, key, token, value)
    const check = parseEnv(updated)[key]
    if (typeof check !== 'string' || unprotectText(check, environment) !== value) refuse('private_env_replacement_failed')
    sealed.set(key, token)
    protectedValues++
  }
  if (updated !== text) assertEnvShape(text, updated, sealed)
  return { file, updated, changed: updated !== text, protectedValues, sealedValues }
}

function secretField(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').split(/[^A-Za-z0-9]+/).map(word => word.toLowerCase())
  return ['password', 'passwd', 'pass', 'pwd', 'secret', 'token', 'key'].includes(words.at(-1) ?? '')
}

interface WalkBudget { nodes: number }

function walkSecretFields(value: unknown, depth: number, seen: Set<unknown>, budget: WalkBudget): boolean {
  if (depth > 32) refuse('input_too_deep')
  if (value === null || typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (++budget.nodes > 10000) refuse('input_too_complex')
  if (Array.isArray(value)) return value.some(item => walkSecretFields(item, depth + 1, seen, budget))
  return Object.entries(value as Record<string, unknown>).some(([key, child]) =>
    secretField(key) || walkSecretFields(child, depth + 1, seen, budget))
}

function demoMarker(file: string, original: string): Marker | null {
  if (basename(file) !== 'credentials-private.json') return null
  const directory = dirname(file), name = basename(directory), markerFile = join(directory, 'manifest.json')
  try { lstatSync(markerFile) } catch { return null }
  const markerPath = ownedFile(markerFile)
  let marker: Record<string, unknown>
  try { marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown> } catch { return refuse('invalid_demo_marker') }
  if (!DEMO_ROOT.test(name) || marker.version !== 1 || marker.syntheticOnly !== true || marker.rootId !== name.slice('syncare-demo-'.length) ||
      (marker.stage !== 'INITIALIZING' && marker.stage !== 'READY') || typeof marker.credentialHash !== 'string') refuse('invalid_demo_marker')
  if (process.platform !== 'win32' && (statSync(directory).mode & 0o077) !== 0) refuse('unsafe_demo_root_permissions')
  if (marker.credentialHash !== sha256(original)) refuse('manifest_credential_hash_mismatch')
  return { file: markerPath, value: marker }
}

function planJson(file: string, environment: Record<string, string | undefined>): JsonPlan {
  const text = readFileSync(file, 'utf8')
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) refuse('input_too_large')
  const trimmed = text.trimStart()
  if (sealedPrefix(trimmed)) {
    let value: unknown
    try { value = readPrivateJson(file, environment) } catch (error) { if (error instanceof Error) throw error; return refuse('invalid_private_json') }
    return { file, updated: text, changed: false, protectedFile: false, sealedFile: true, expected: value, marker: demoMarker(file, text) }
  }
  let value: unknown
  try { value = JSON.parse(text) as unknown } catch { return refuse('invalid_json_input') }
  const marker = demoMarker(file, text)
  if (!walkSecretFields(value, 0, new Set(), { nodes: 0 })) return { file, updated: text, changed: false, protectedFile: false, sealedFile: false, expected: value, marker: null }
  const plaintext = JSON.stringify(value, null, 2), sealed = protectText(plaintext, environment)
  if (unprotectText(sealed, environment) !== plaintext) refuse('private_roundtrip_failed')
  return { file, updated: sealed, changed: true, protectedFile: true, sealedFile: false, expected: value, marker }
}

function writeAtomic(file: string, text: string): void {
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.protected-tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, text, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor); descriptor = undefined
    if (process.platform !== 'win32') chmodSync(temporary, 0o600)
    renameSync(temporary, file)
    if (process.platform !== 'win32') chmodSync(file, 0o600)
  } catch (error) {
    if (descriptor !== undefined) { try { closeSync(descriptor) } catch {} }
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}

export function main(argv: string[], io: ProtectCliIo = {}): number {
  const stdout = io.stdout ?? ((line: string) => console.log(line)), stderr = io.stderr ?? ((line: string) => console.error(line))
  try {
    const input = parseArguments(argv)
    const environment = io.environment ?? process.env
    const envPlans = input.envFiles.map(file => planEnv(ownedFile(file), environment))
    const jsonPlans = input.jsonFiles.map(file => planJson(ownedFile(file), environment))
    let envValuesProtected = 0, envValuesAlreadySealed = 0, credentialFilesProtected = 0, credentialFilesAlreadySealed = 0
    for (const plan of envPlans) {
      if (plan.changed) writeAtomic(plan.file, plan.updated)
      envValuesProtected += plan.protectedValues
      envValuesAlreadySealed += plan.sealedValues
    }
    for (const plan of jsonPlans) {
      if (plan.changed) {
        writeAtomic(plan.file, plan.updated)
        const restored = readPrivateJson(plan.file, environment)
        if (JSON.stringify(restored) !== JSON.stringify(plan.expected)) refuse('private_roundtrip_failed')
        const sealedText = readFileSync(plan.file, 'utf8')
        if (plan.marker) {
          const marker = { ...plan.marker.value, credentialHash: sha256(sealedText) }
          writeAtomic(plan.marker.file, JSON.stringify(marker, null, 2))
        }
      }
      if (plan.protectedFile) credentialFilesProtected++
      if (plan.sealedFile) credentialFilesAlreadySealed++
    }
    stdout(JSON.stringify({ result: 'PASS', envFiles: envPlans.length, jsonFiles: jsonPlans.length, envValuesProtected,
      envValuesAlreadySealed, credentialFilesProtected, credentialFilesAlreadySealed, operatorAuthorized: input.operatorAuthorized,
      credentialValuesChanged: false, credentialsPrinted: false }))
    return 0
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'private_protection_failed'
    stderr(JSON.stringify({ result: 'FAIL', code, credentialsPrinted: false }))
    return 1
  }
}

if (import.meta.main) process.exitCode = main(Bun.argv.slice(2))
