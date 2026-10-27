import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { Database } from 'bun:sqlite'
import { inspectDemo, main, resetDemo, seedDemo, type DemoRoot, type DemoRunners } from '../scripts/demo-seed.ts'
import { main as protectMain } from '../scripts/protect-local-secrets.ts'
import { f1Output } from './assessment.test.ts'
import { readPrivateJson } from '../src/security/private-files.cjs'
import { routine } from './f2-context.test.ts'

const parents: string[] = []
const keys: { directory: string; file: string }[] = []
const comparable = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
function cleanupFixture(directory: string, prefix: string, code: string): void {
  const resolved = resolve(directory)
  if (!basename(resolved).startsWith(prefix)) throw Error(code)
  let real: string
  try { real = realpathSync.native(resolved) } catch { throw Error(code) }
  if (!lstatSync(resolved).isDirectory() || lstatSync(resolved).isSymbolicLink()) throw Error(code)
  if (comparable(dirname(real)) !== comparable(realpathSync.native(tmpdir())) || !basename(real).startsWith(prefix)) throw Error(code)
  rmSync(real, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
}
function options(): DemoRoot {
  const parent = mkdtempSync(join(tmpdir(), 'syncare-m11-'))
  parents.push(parent)
  return { parent, root: join(parent, `syncare-demo-${randomUUID()}`), mode: 'local-synthetic' }
}
function childEnvironment(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = { ...process.env, ...extra }
  if (process.platform !== 'win32') {
    const key = process.env.SYNCARE_PRIVATE_KEY_FILE
    if (!key) throw Error('linux_test_key_missing')
    environment.SYNCARE_PRIVATE_KEY_FILE = key
  }
  return environment
}
const runners: DemoRunners = {
  kind: 'injected_fixture',
  runF1: async (source, sessionId) => ({ raw: { synthetic: true }, sessionId, outputText: JSON.stringify({ ...f1Output, score: source.includes('M11 HIGH') ? 7 : 0, tier: source.includes('M11 HIGH') ? 'HIGH' : 'LOW' }) }),
  runF2: async context => ({ raw: { synthetic: true }, sessionId: context.sessionId, outputText: JSON.stringify(context.baselineScore === 0 ? { action: 'escalate_immediately', reason: 'Alasan akut sintetis khusus fixture M11.' } : { ...routine(context.patientId, context.baselineScore), score: 7, tier: 'HIGH', baseline_tier: 'HIGH' }) }),
}
beforeEach(() => {
  if (process.platform === 'win32') { delete process.env.SYNCARE_PRIVATE_KEY_FILE; return }
  const directory = mkdtempSync(join(tmpdir(), 'syncare-m11-key-')), file = join(directory, 'private.key')
  keys.push({ directory, file })
  writeFileSync(file, randomBytes(32), { mode: 0o600 })
  process.env.SYNCARE_PRIVATE_KEY_FILE = file
})
afterEach(() => {
  delete process.env.SYNCARE_PRIVATE_KEY_FILE
  for (const parent of parents.splice(0)) cleanupFixture(parent, 'syncare-m11-', 'unsafe_fixture_cleanup')
  for (const key of keys.splice(0)) cleanupFixture(key.directory, 'syncare-m11-key-', 'unsafe_key_cleanup')
})

test('demo_repeatability: cold seed/reopen/replay keep exact accounts, assessments, confirmed baselines and two F2 branches', async () => {
  const input = options(), first = await seedDemo(input, runners)
  expect(first.stage).toBe('READY'); expect(first.runnerKind).toBe('injected_fixture')
  expect(first.canonicalBinding).toBe('not_configured')
  expect(first.cases.map(value => [value.slot, value.baseline, value.outcome])).toEqual([['low', 0, 'escalate_immediately'], ['high', 7, 'continue_monitoring']])
  expect(inspectDemo(input)).toEqual(first)
  if (process.platform === 'win32') expect(process.env.SYNCARE_PRIVATE_KEY_FILE).toBeUndefined()
  else {
    const key = process.env.SYNCARE_PRIVATE_KEY_FILE!
    expect(resolve(key).startsWith(resolve(input.root) + sep)).toBe(false)
    expect(statSync(input.root).mode & 0o777).toBe(0o700)
    expect(readFileSync(join(input.root, 'credentials-private.json'), 'utf8').startsWith('aesgcm:v1:')).toBe(true)
  }
  let unexpected = 0
  expect(await seedDemo(input, { ...runners, runF1: async () => { unexpected++; throw Error('no_replay') } })).toEqual(first)
  expect(unexpected).toBe(0)
  const privateText = readFileSync(join(input.root, 'credentials-private.json'), 'utf8')
  const credentials = readPrivateJson(join(input.root, 'credentials-private.json'))
  const manifestText = readFileSync(join(input.root, 'manifest.json'), 'utf8')
  expect(privateText).not.toContain(credentials.operator.password)
  expect(manifestText).not.toContain(credentials.operator.password)
  const db = new Database(join(input.root, 'state.sqlite3'), { readonly: true })
  expect(JSON.stringify(db.query('SELECT * FROM accounts').all())).not.toContain(credentials.operator.password)
  expect(db.query<{ count: number }, []>('SELECT COUNT(*) count FROM alerts').get()!.count).toBe(1)
  db.close()
  const command = Bun.spawnSync([process.execPath, 'scripts/demo-seed.ts', 'inspect', '--local-synthetic', `--parent=${input.parent}`, `--root=${input.root}`], { cwd: import.meta.dir + '/..', env: childEnvironment() })
  expect(command.exitCode).toBe(0)
  expect(command.stdout.toString()).not.toContain(credentials.operator.password)
  expect(command.stderr.toString()).toBe('')
  const output: string[] = [], errors: string[] = []
  expect(await main(['inspect', '--local-synthetic', '--parent', input.parent, '--root', input.root], { stdout: line => output.push(line), stderr: line => errors.push(line) })).toBe(0)
  expect(errors).toEqual([])
  expect(output.join('\n')).not.toContain(credentials.operator.password)
  expect(JSON.parse(output[0]!)).toMatchObject({ status: 'ready', rootId: first.rootId, cases: 2, credentialsPrinted: false })
}, 30000)

test('demo_repeatability: reset requires exact marked test root and token; reinitialize produces a separate fresh identity set', async () => {
  const input = options(), first = await seedDemo(input, runners)
  expect(() => resetDemo(input, 'wrong')).toThrow('explicit_root_confirmation_required')
  expect(inspectDemo(input)).toEqual(first)
  resetDemo(input, first.rootId)
  expect(existsSync(input.root)).toBe(false)
  const second = await seedDemo(input, runners)
  expect(second.cases[0]!.patientId).not.toBe(first.cases[0]!.patientId)
  expect(second.cases[1]!.accountId).not.toBe(first.cases[1]!.accountId)
}, 30000)

test('sentinel_realdata_absent: unknown file, changed clinical record and altered private credential block reset without deleting anything', async () => {
  const input = options(), seeded = await seedDemo(input, runners)
  const sentinel = join(input.root, 'unowned-real-data-sentinel.txt')
  writeFileSync(sentinel, 'Synthetic sentinel representing unowned data')
  expect(() => resetDemo(input, seeded.rootId)).toThrow('unowned_demo_content')
  expect(readFileSync(sentinel, 'utf8')).toContain('unowned data')
  rmSync(sentinel)
  const privatePath = join(input.root, 'credentials-private.json'), original = readFileSync(privatePath, 'utf8')
  writeFileSync(privatePath, original + ' ')
  expect(() => resetDemo(input, seeded.rootId)).toThrow('demo_credentials_changed')
  writeFileSync(privatePath, original)
  const db = new Database(join(input.root, 'state.sqlite3'))
  db.run('UPDATE patients SET profile_json=? WHERE id=?', ['{"displayName":"Changed synthetic sentinel"}', seeded.cases[0]!.patientId]); db.close()
  expect(() => resetDemo(input, seeded.rootId)).toThrow('demo_records_changed')
  expect(existsSync(join(input.root, 'state.sqlite3'))).toBe(true)
}, 30000)

test('unsafe roots, aliases, hardlinks, missing marker and production mode fail closed', async () => {
  const input = options()
  for (const root of ['relative', input.parent, join(input.parent, 'current-data')]) await expect(seedDemo({ ...input, root }, runners)).rejects.toThrow()
  const liveParent = resolve(import.meta.dir, '../data')
  await expect(seedDemo({ ...input, parent: liveParent, root: join(liveParent, `syncare-demo-${randomUUID()}`) }, runners)).rejects.toThrow('unsafe_demo_root')
  expect(() => inspectDemo({ ...input, root: input.parent })).toThrow()
  const ready = await seedDemo(input, runners)
  const other = options(), link = join(other.parent, `syncare-demo-${randomUUID()}`)
  symlinkSync(input.root, link, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => resetDemo({ ...other, root: link }, ready.rootId)).toThrow('unsafe_demo_root')
  const hardlink = join(other.parent, 'credential-link.json')
  linkSync(join(input.root, 'credentials-private.json'), hardlink)
  expect(() => resetDemo(input, ready.rootId)).toThrow('unowned_demo_content')
  expect(existsSync(hardlink)).toBe(true)
  const command = Bun.spawnSync([process.execPath, 'scripts/demo-seed.ts', 'inspect', '--local-synthetic', `--parent=${input.parent}`, `--root=${input.root}`], { cwd: import.meta.dir + '/..', env: childEnvironment({ NODE_ENV: 'production' }) })
  expect(command.exitCode).not.toBe(0)
  expect(command.stderr.toString()).toContain('synthetic_mode_required')
}, 30000)

test('canonical parent aliases cannot bypass the live-root exclusion', async () => {
  const owned = options()
  const copyRoot = join(owned.parent, 'disposable-module')
  mkdirSync(join(copyRoot, 'scripts'), {recursive: true})
  const sourceUrl = new URL('../scripts/demo-seed.ts', import.meta.url)
  const source = readFileSync(sourceUrl, 'utf8').replace(/from '(\.\.\/[^']+)'/g,
    (_match, relativeImport: string) => `from '${new URL(relativeImport, sourceUrl).href}'`)
  const copied = join(copyRoot, 'scripts/demo-seed.ts')
  writeFileSync(copied, source)
  const physicalParent = join(copyRoot, 'data/inside')
  mkdirSync(physicalParent, {recursive: true})
  const alias = join(owned.parent, 'data-alias')
  symlinkSync(join(copyRoot, 'data'), alias, process.platform === 'win32' ? 'junction' : 'dir')
  const declaredParent = join(alias, 'inside')
  expect(lstatSync(declaredParent).isSymbolicLink()).toBe(false)
  const rootName = `syncare-demo-${randomUUID()}`
  const probe = await import(pathToFileURL(copied).href) as typeof import('../scripts/demo-seed.ts')
  await expect(probe.seedDemo({parent: declaredParent, root: join(declaredParent, rootName), mode: 'local-synthetic'}, runners)).rejects.toThrow('unsafe_demo_root')
  expect(existsSync(join(physicalParent, rootName))).toBe(false)
}, 30000)

test.skipIf(process.platform === 'win32')('physical key aliases inside a demo root are rejected before reset inventory', () => {
  const input = options(), other = options()
  mkdirSync(input.root, {mode: 0o700})
  const key = join(input.root, 'private.key')
  writeFileSync(key, randomBytes(32), {mode: 0o600})
  const alias = join(other.parent, 'key-parent-alias')
  symlinkSync(input.parent, alias, 'dir')
  process.env.SYNCARE_PRIVATE_KEY_FILE = join(alias, basename(input.root), 'private.key')
  expect(() => inspectDemo(input)).toThrow('private_key_inside_demo_root')
  expect(statSync(key).size).toBe(32)
})

test.skipIf(process.platform === 'win32')('linux_private_key_contract: missing or short key fails closed and leaves no plaintext credential fallback', async () => {
  const input = options(), key = process.env.SYNCARE_PRIVATE_KEY_FILE!
  const saved = key
  process.env.SYNCARE_PRIVATE_KEY_FILE = join(input.root, 'private.key')
  await expect(seedDemo(input, runners)).rejects.toThrow('private_key_inside_demo_root')
  expect(existsSync(input.root)).toBe(false)
  process.env.SYNCARE_PRIVATE_KEY_FILE = saved
  delete process.env.SYNCARE_PRIVATE_KEY_FILE
  await expect(seedDemo(input, runners)).rejects.toThrow(/private_material_unavailable|private_key|key_file/)
  expect(existsSync(input.root)).toBe(true)
  const marker = JSON.parse(readFileSync(join(input.root, 'manifest.json'), 'utf8')) as { stage: string }
  expect(marker.stage).toBe('INITIALIZING')
  const failedCredentials = join(input.root, 'credentials-private.json')
  expect(existsSync(failedCredentials)).toBe(false)

  writeFileSync(key, randomBytes(31), { mode: 0o600 })
  process.env.SYNCARE_PRIVATE_KEY_FILE = saved
  const second = options()
  await expect(seedDemo(second, runners)).rejects.toThrow(/private_material_unavailable|private_key|key_file/)
  expect(existsSync(join(second.root, 'credentials-private.json'))).toBe(false)

  writeFileSync(key, randomBytes(32), { mode: 0o600 })
  const command = Bun.spawnSync([process.execPath, 'scripts/demo-seed.ts', 'inspect', '--local-synthetic', `--parent=${input.parent}`, `--root=${input.root}`], { cwd: import.meta.dir + '/..', env: { ...process.env, SYNCARE_PRIVATE_KEY_FILE: undefined } })
  expect(command.exitCode).not.toBe(0)
  expect(command.stderr.toString()).toContain('"credentialsPrinted":false')
  expect(command.stderr.toString()).not.toContain('password')
}, 30000)

test('protect_cli_converts_legacy_plaintext_demo_credentials_and_inspect_still_accepts_the_marker', async () => {
  const input = options(), seeded = await seedDemo(input, runners)
  const credentialsPath = join(input.root, 'credentials-private.json'), markerPath = join(input.root, 'manifest.json')
  const value = readPrivateJson(credentialsPath), plaintext = JSON.stringify(value, null, 2)
  writeFileSync(credentialsPath, plaintext, { mode: 0o600 })
  const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>
  marker.credentialHash = createHash('sha256').update(plaintext).digest('hex')
  writeFileSync(markerPath, JSON.stringify(marker, null, 2), { mode: 0o600 })

  const output: string[] = [], errors: string[] = []
  expect(protectMain(['--protect', '--json-file', credentialsPath], { stdout: line => output.push(line), stderr: line => errors.push(line) })).toBe(0)
  expect(errors).toEqual([])
  expect(output.join('\n')).not.toContain(value.operator.password)
  expect(readPrivateJson(credentialsPath)).toEqual(value)
  const inspected = inspectDemo(input)
  expect(inspected.rootId).toBe(seeded.rootId)
  expect(inspected.credentialHash).toBe(createHash('sha256').update(readFileSync(credentialsPath, 'utf8')).digest('hex'))
}, 30000)
