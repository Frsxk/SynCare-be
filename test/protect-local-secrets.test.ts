import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { main } from '../scripts/protect-local-secrets.ts'
import { protectText, readPrivateJson, unprotectText } from '../src/security/private-files.cjs'

const directories: string[] = []
let environment: Record<string, string | undefined> = {}
const envelope = process.platform === 'win32' ? 'dpapi:v1:' : 'aesgcm:v1:'
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'syncare-protect-'))
  directories.push(directory)
  return directory
}
function run(args: string[]): { code: number; out: string[]; err: string[]; printed: string } {
  const out: string[] = [], err: string[] = []
  const code = main(args, { stdout: line => out.push(line), stderr: line => err.push(line), environment })
  return { code, out, err, printed: [...out, ...err].join('\n') }
}
function failure(result: ReturnType<typeof run>): string {
  const line = result.err.at(-1) ?? result.out.at(-1) ?? '{}'
  return (JSON.parse(line) as { code?: string }).code ?? 'missing_code'
}
function rootId(root: string): string { return basename(root).slice('syncare-demo-'.length) }
function summary(result: ReturnType<typeof run>): Record<string, unknown> {
  return JSON.parse(result.out.at(-1) ?? '{}') as Record<string, unknown>
}
beforeEach(() => {
  if (process.platform === 'win32') { environment = {}; return }
  const directory = temporary(), key = join(directory, 'private.key')
  writeFileSync(key, randomBytes(32), { mode: 0o600 })
  environment = { SYNCARE_PRIVATE_KEY_FILE: key }
})
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

test('protection_cli_requires_explicit_absolute_owned_inputs: no implicit workspace scan or historical sibling defaults', () => {
  expect(failure(run(['--protect']))).toBe('explicit_input_required')
  const directory = temporary(), file = join(directory, '.env')
  writeFileSync(file, 'SYNCARE_API_KEY=synthetic-value\n', { mode: 0o600 })
  expect(failure(run(['--env-file', file]))).toBe('explicit_protect_required')
  expect(failure(run(['--protect', '--env-file', '.env']))).toBe('absolute_path_required')
  expect(failure(run(['--protect', '--env-file', join(directory, 'missing.env')]))).toBe('input_file_missing')
  expect(failure(run(['--protect', '--json-file', directory]))).toBe('input_not_regular_file')
  expect(failure(run(['--protect', '--env-file', file, '--unknown-flag']))).toBe('unknown_argument')

  const linked = join(directory, 'linked.env')
  if (process.platform !== 'win32') {
    symlinkSync(file, linked)
    expect(failure(run(['--protect', '--env-file', linked]))).toBe('symlink_input_rejected')

    const hardlink = join(directory, 'hardlink.env')
    linkSync(file, hardlink)
    expect(failure(run(['--protect', '--env-file', hardlink]))).toBe('input_hardlink_rejected')

    const open = temporary()
    chmodSync(open, 0o777)
    writeFileSync(join(open, '.env'), 'SYNCARE_API_KEY=synthetic-value\n', { mode: 0o600 })
    expect(failure(run(['--protect', '--env-file', join(open, '.env')]))).toBe('unsafe_input_parent')
    chmodSync(open, 0o700)

    const sticky = join(tmpdir(), `.syncare-protect-${randomUUID()}.env`)
    writeFileSync(sticky, 'SYNCARE_API_KEY=synthetic-sticky-value\n', { mode: 0o600 })
    try { expect(run(['--protect', '--env-file', sticky]).code).toBe(0) }
    finally { rmSync(sticky, { force: true }) }
  }
})

test('env_file_protection_seals_only_secret_values, preserves other configuration and never prints material', () => {
  const directory = temporary(), file = join(directory, '.env')
  const api = randomBytes(24).toString('base64url'), password = randomBytes(24).toString('base64url'), host = '127.0.0.1'
  writeFileSync(file, `# synthetic environment\nSYNCARE_HOST=${host}\nSYNCARE_API_KEY=${api}\nexport LANGFLOW_SUPERUSER_PASSWORD="${password}"\nLANGFLOW_SECRET_KEY=\nSYNCARE_CURSOR_SECRET=${randomBytes(24).toString('base64url')}\n`, { mode: 0o600 })

  const result = run(['--protect', '--env-file', file])
  expect(result.code).toBe(0)
  expect(summary(result)).toMatchObject({ result: 'PASS', envFiles: 1, envValuesProtected: 3, envValuesAlreadySealed: 0, operatorAuthorized: false, credentialsPrinted: false })
  expect(result.printed).not.toContain(api)
  expect(result.printed).not.toContain(password)
  const updated = readFileSync(file, 'utf8')
  expect(updated).not.toContain(api)
  expect(updated).not.toContain(password)
  const parsed = parseEnv(updated)
  expect(parsed.SYNCARE_HOST).toBe(host)
  expect(parsed.LANGFLOW_SECRET_KEY).toBe('')
  expect(parsed.SYNCARE_API_KEY!.startsWith(envelope)).toBe(true)
  expect(unprotectText(parsed.SYNCARE_API_KEY!, environment)).toBe(api)
  expect(unprotectText(parsed.LANGFLOW_SUPERUSER_PASSWORD!, environment)).toBe(password)
  if (process.platform !== 'win32') {
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
  }
  expect(readdirSync(directory).filter(name => name.includes('protected-tmp'))).toEqual([])

  const first = readFileSync(file, 'utf8')
  const replay = run(['--protect', '--operator-authorized', '--env-file', file])
  expect(replay.code).toBe(0)
  expect(summary(replay)).toMatchObject({ envValuesProtected: 0, envValuesAlreadySealed: 3, operatorAuthorized: true })
  expect(readFileSync(file, 'utf8')).toBe(first)
}, 30000)

test('multiline_quoted_env_secret_values_fail_closed_before_any_file_is_written', () => {
  const directory = temporary()
  const good = join(directory, 'good.env'), goodText = 'SYNCARE_API_KEY=synthetic-good\n'
  const cases = {
    'leaky.env': 'A_PASSWORD="line1\nLEAKED_TOKEN=plain-secret"\nB_HOST=h\n',
    'benign.env': 'A_PASSWORD="line1\nline2"\nB_HOST=h\n',
  }
  for (const [name, original] of Object.entries(cases)) {
    const file = join(directory, name)
    writeFileSync(good, goodText, { mode: 0o600 })
    writeFileSync(file, original, { mode: 0o600 })
    const result = run(['--protect', '--env-file', good, '--env-file', file])
    expect(result.code).toBe(1)
    expect(failure(result)).toBe('env_value_spans_lines')
    expect(summary(result).result).toBeUndefined()
    expect(result.printed).not.toContain('PASS')
    expect(result.printed).not.toContain('plain-secret')
    expect(result.printed).not.toContain('line2')
    expect(readFileSync(file, 'utf8')).toBe(original)
    expect(parseEnv(readFileSync(file, 'utf8')).LEAKED_TOKEN).toBeUndefined()
    expect(readFileSync(good, 'utf8')).toBe(goodText)
    expect(readdirSync(directory).filter(entry => entry.includes('protected-tmp'))).toEqual([])
  }
})

test('single_physical_line_values_containing_newline_escapes_still_seal_without_reinterpretation', () => {
  const directory = temporary(), file = join(directory, '.env')
  const original = 'A_PASSWORD="line1\\nLEAKED_TOKEN=plain-secret"\nB_HOST=h\n'
  writeFileSync(file, original, { mode: 0o600 })
  const expected = parseEnv(original).A_PASSWORD!
  expect(expected).toContain('LEAKED_TOKEN=plain-secret')
  const result = run(['--protect', '--env-file', file])
  expect(result.code).toBe(0)
  expect(summary(result)).toMatchObject({ result: 'PASS', envValuesProtected: 1 })
  expect(result.printed).not.toContain('plain-secret')
  const updated = parseEnv(readFileSync(file, 'utf8'))
  expect(Object.keys(updated)).toEqual(['A_PASSWORD', 'B_HOST'])
  expect(updated.B_HOST).toBe('h')
  expect(updated.A_PASSWORD!.startsWith(envelope)).toBe(true)
  expect(unprotectText(updated.A_PASSWORD!, environment)).toBe(expected)
})

test('secret_names_outside_the_env_line_grammar_fail_closed_without_partial_writes', () => {
  const directory = temporary()
  for (const [name, line, value] of [['dotted.env', 'A.PASSWORD=dotval', 'dotval'], ['hyphen.env', 'A-TOKEN=hyphenval', 'hyphenval']] as const) {
    const file = join(directory, name), original = `${line}\nSYNCARE_HOST=h\n`
    writeFileSync(file, original, { mode: 0o600 })
    const result = run(['--protect', '--env-file', file])
    expect(result.code).toBe(1)
    expect(failure(result)).toBe('unsupported_env_secret_name')
    expect(result.printed).not.toContain('PASS')
    expect(result.printed).not.toContain(value)
    expect(readFileSync(file, 'utf8')).toBe(original)
    expect(readdirSync(directory).filter(entry => entry.includes('protected-tmp'))).toEqual([])
  }
})

test('camel_case_secret_env_names_are_sealed_instead_of_silently_passed', () => {
  const directory = temporary(), file = join(directory, '.env')
  writeFileSync(file, 'myKey=camel-secret\nSYNCARE_HOST=h\n', { mode: 0o600 })
  const result = run(['--protect', '--env-file', file])
  expect(result.code).toBe(0)
  expect(summary(result)).toMatchObject({ result: 'PASS', envValuesProtected: 1 })
  const parsed = parseEnv(readFileSync(file, 'utf8'))
  expect(parsed.myKey!.startsWith(envelope)).toBe(true)
  expect(unprotectText(parsed.myKey!, environment)).toBe('camel-secret')
  expect(parsed.SYNCARE_HOST).toBe('h')
})

test('json_credentials_are_sealed_without_changing_values_or_unrelated_clinical_files', () => {
  const parent = temporary(), root = join(parent, `syncare-demo-${randomUUID()}`), markerRootId = rootId(root)
  mkdirSync(root, { mode: 0o700 })
  const credentials = {
    operator: { identifier: `operator-${randomUUID()}@synthetic.invalid`, password: randomBytes(32).toString('base64url') },
    nurses: [{ slot: 'low', password: randomBytes(32).toString('base64url') }],
    cursorSecret: randomBytes(48).toString('base64url'),
  }
  const plaintext = JSON.stringify(credentials, null, 2)
  const file = join(root, 'credentials-private.json')
  writeFileSync(file, plaintext, { mode: 0o600 })
  const marker = { version: 1, rootId: markerRootId, syntheticOnly: true, stage: 'READY', createdAt: new Date().toISOString(), accountIds: [], cases: [], credentialHash: sha256(plaintext) }
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(marker, null, 2), { mode: 0o600 })
  const clinical = join(root, 'clinical-history.json'), clinicalText = JSON.stringify({ note: 'Synthetic clinical history, not a credential file.' })
  writeFileSync(clinical, clinicalText, { mode: 0o600 })

  const result = run(['--protect', '--json-file', file])
  expect(result.code).toBe(0)
  expect(summary(result)).toMatchObject({ result: 'PASS', jsonFiles: 1, credentialFilesProtected: 1, operatorAuthorized: false, credentialValuesChanged: false, credentialsPrinted: false })
  expect(result.printed).not.toContain(credentials.operator.password)
  expect(result.printed).not.toContain(credentials.cursorSecret)
  const sealed = readFileSync(file, 'utf8')
  expect(sealed.startsWith(envelope)).toBe(true)
  expect(sealed).not.toContain(credentials.operator.password)
  expect(readPrivateJson(file, environment)).toEqual(credentials)
  const updatedMarker = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as Record<string, unknown>
  expect(updatedMarker).toEqual({ ...marker, credentialHash: sha256(sealed) })
  expect(readFileSync(clinical, 'utf8')).toBe(clinicalText)
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(readdirSync(root).filter(name => name.includes('protected-tmp'))).toEqual([])

  const replay = run(['--protect', '--json-file', file])
  expect(replay.code).toBe(0)
  expect(summary(replay)).toMatchObject({ credentialFilesProtected: 0, credentialFilesAlreadySealed: 1 })
  expect(readFileSync(file, 'utf8')).toBe(sealed)
}, 30000)

test('marked_synthetic_credentials_refuse_stale_marker_hash_or_marker_drift_without_writing', () => {
  const parent = temporary(), root = join(parent, `syncare-demo-${randomUUID()}`), markerRootId = rootId(root)
  mkdirSync(root, { mode: 0o700 })
  const file = join(root, 'credentials-private.json'), plaintext = JSON.stringify({ operator: { password: 'synthetic-secret' } }, null, 2)
  writeFileSync(file, plaintext, { mode: 0o600 })
  const marker = { version: 1, rootId: markerRootId, syntheticOnly: true, stage: 'READY', createdAt: new Date().toISOString(), accountIds: [], cases: [], credentialHash: sha256('different historical content') }
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(marker, null, 2), { mode: 0o600 })
  expect(failure(run(['--protect', '--operator-authorized', '--json-file', file]))).toBe('manifest_credential_hash_mismatch')
  expect(readFileSync(file, 'utf8')).toBe(plaintext)

  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ ...marker, syntheticOnly: false, credentialHash: sha256(plaintext) }, null, 2), { mode: 0o600 })
  expect(failure(run(['--protect', '--operator-authorized', '--json-file', file]))).toBe('invalid_demo_marker')
  expect(readFileSync(file, 'utf8')).toBe(plaintext)

  const orphan = join(temporary(), 'credentials-private.json')
  writeFileSync(orphan, plaintext, { mode: 0o600 })
  expect(run(['--protect', '--json-file', orphan]).code).toBe(0)
  expect(readFileSync(orphan, 'utf8')).not.toContain('synthetic-secret')
  expect(readPrivateJson(orphan, environment)).toEqual({ operator: { password: 'synthetic-secret' } })
  expect(existsSync(join(dirname(orphan), 'manifest.json'))).toBe(false)
}, 30000)

test('already_sealed_dpapi_or_aesgcm_values_are_validated_not_double_encrypted', () => {
  const directory = temporary()
  const cases = process.platform === 'win32'
    ? [{ name: 'dpapi.env' as const, text: `SYNCARE_API_KEY=${protectText('synthetic sealed placeholder')}\n` }]
    : [
        { name: 'dpapi.env' as const, text: `SYNCARE_API_KEY=dpapi:v1:${Buffer.from('synthetic dpapi placeholder').toString('base64')}\n` },
        { name: 'aesgcm.env' as const, text: `SYNCARE_API_KEY=aesgcm:v1:${Buffer.from('synthetic aesgcm placeholder').toString('base64')}\n` },
      ]
  for (const item of cases) {
    const file = join(directory, item.name)
    writeFileSync(file, item.text, { mode: 0o600 })
    const result = run(['--protect', '--env-file', file])
    if (process.platform === 'win32') {
      expect(result.code).toBe(0)
      expect(readFileSync(file, 'utf8')).toBe(item.text)
      continue
    }
    expect(result.code).toBe(1)
    expect(['private_material_unavailable', 'invalid_private_envelope', 'windows_protection_required', 'private_key_unavailable']).toContain(failure(result))
    expect(readFileSync(file, 'utf8')).toBe(item.text)
    expect(readFileSync(file, 'utf8')).not.toContain('aesgcm:v1:aesgcm:v1:')
    expect(readFileSync(file, 'utf8')).not.toContain('dpapi:v1:dpapi:v1:')
  }
}, 30000)

test('explicit_non_credential_json_and_unlisted_siblings_are_left_untouched', () => {
  const directory = temporary(), clinical = join(directory, 'clinical.json'), sibling = join(directory, 'unlisted.env')
  const clinicalText = JSON.stringify({ patient: { note: 'Synthetic clinical note only.' } }, null, 2)
  writeFileSync(clinical, clinicalText, { mode: 0o600 })
  writeFileSync(sibling, 'SYNCARE_API_KEY=synthetic-unlisted-value\n', { mode: 0o600 })
  const result = run(['--protect', '--operator-authorized', '--json-file', clinical])
  expect(result.code).toBe(0)
  expect(summary(result)).toMatchObject({ jsonFiles: 1, credentialFilesProtected: 0, credentialFilesAlreadySealed: 0 })
  expect(readFileSync(clinical, 'utf8')).toBe(clinicalText)
  expect(readFileSync(sibling, 'utf8')).toContain('synthetic-unlisted-value')
})

test('repeatable_env_and_json_flags_process_every_explicit_input_in_one_pass', () => {
  const directory = temporary()
  const first = join(directory, 'first.env'), second = join(directory, 'second.env')
  const firstJson = join(directory, 'first.json'), secondJson = join(directory, 'second.json')
  writeFileSync(first, 'SYNCARE_API_KEY=synthetic-first\n', { mode: 0o600 })
  writeFileSync(second, 'SYNCARE_CURSOR_SECRET=synthetic-second\n', { mode: 0o600 })
  writeFileSync(firstJson, JSON.stringify({ token: 'synthetic-first-json' }), { mode: 0o600 })
  writeFileSync(secondJson, JSON.stringify({ secret: 'synthetic-second-json' }), { mode: 0o600 })
  const result = run(['--protect', '--env-file', first, '--env-file', second, '--json-file', firstJson, '--json-file', secondJson])
  expect(result.code).toBe(0)
  expect(summary(result)).toMatchObject({ envFiles: 2, jsonFiles: 2, envValuesProtected: 2, credentialFilesProtected: 2 })
  expect(readFileSync(first, 'utf8')).not.toContain('synthetic-first')
  expect(readFileSync(second, 'utf8')).not.toContain('synthetic-second')
  expect(unprotectText(parseEnv(readFileSync(first, 'utf8')).SYNCARE_API_KEY!, environment)).toBe('synthetic-first')
  expect(unprotectText(parseEnv(readFileSync(second, 'utf8')).SYNCARE_CURSOR_SECRET!, environment)).toBe('synthetic-second')
  expect(readPrivateJson(firstJson, environment)).toEqual({ token: 'synthetic-first-json' })
  expect(readPrivateJson(secondJson, environment)).toEqual({ secret: 'synthetic-second-json' })
}, 30000)

test('bounded_inputs_and_explicit_duplicate_flags_fail_closed', () => {
  const directory = temporary(), file = join(directory, '.env')
  writeFileSync(file, 'SYNCARE_API_KEY=synthetic-value\n', { mode: 0o600 })
  const oversized = join(directory, 'oversized.env')
  writeFileSync(oversized, `SYNCARE_API_KEY=${'a'.repeat(2 * 1024 * 1024 + 1)}`, { mode: 0o600 })
  expect(failure(run(['--protect', '--env-file', oversized]))).toBe('input_too_large')
  expect(failure(run(['--protect', '--env-file', file, '--env-file', file]))).toBe('duplicate_input_argument')
  expect(existsSync(file)).toBe(true)
  expect(dirname(resolve(file))).toBe(directory)
  expect(lstatSync(file).isFile()).toBe(true)
})
