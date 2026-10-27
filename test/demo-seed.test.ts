import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import { inspectDemo, resetDemo, seedDemo, type DemoRoot, type DemoRunners } from '../scripts/demo-seed.ts'
import { f1Output } from './assessment.test.ts'
import { readPrivateJson } from '../src/security/private-files.cjs'
import { routine } from './f2-context.test.ts'

const parents: string[] = []
function options(): DemoRoot {
  const parent = mkdtempSync(join(tmpdir(), 'syncare-m11-'))
  parents.push(parent)
  return { parent, root: join(parent, `syncare-demo-${randomUUID()}`), mode: 'local-synthetic' }
}
const runners: DemoRunners = {
  kind: 'injected_fixture',
  runF1: async (source, sessionId) => ({ raw: { synthetic: true }, sessionId, outputText: JSON.stringify({ ...f1Output, score: source.includes('M11 HIGH') ? 7 : 0, tier: source.includes('M11 HIGH') ? 'HIGH' : 'LOW' }) }),
  runF2: async context => ({ raw: { synthetic: true }, sessionId: context.sessionId, outputText: JSON.stringify(context.baselineScore === 0 ? { action: 'escalate_immediately', reason: 'Alasan akut sintetis khusus fixture M11.' } : { ...routine(context.patientId, context.baselineScore), score: 7, tier: 'HIGH', baseline_tier: 'HIGH' }) }),
}
afterEach(() => {
  for (const parent of parents.splice(0)) {
    const resolved = resolve(parent)
    if (dirname(resolved) !== resolve(realpathSync.native(tmpdir())) || !basename(resolved).startsWith('syncare-m11-') || realpathSync.native(resolved) !== resolved) throw Error('unsafe_fixture_cleanup')
    rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
  }
})

test('demo_repeatability: cold seed/reopen/replay keep exact accounts, assessments, confirmed baselines and two F2 branches', async () => {
  const input = options(), first = await seedDemo(input, runners)
  expect(first.stage).toBe('READY'); expect(first.runnerKind).toBe('injected_fixture')
  expect(first.canonicalBinding).toBe('not_configured')
  expect(first.cases.map(value => [value.slot, value.baseline, value.outcome])).toEqual([['low', 0, 'escalate_immediately'], ['high', 7, 'continue_monitoring']])
  expect(inspectDemo(input)).toEqual(first)
  let unexpected = 0
  expect(await seedDemo(input, { ...runners, runF1: async () => { unexpected++; throw Error('no_replay') } })).toEqual(first)
  expect(unexpected).toBe(0)
  const privateText = readFileSync(join(input.root, 'credentials-private.json'), 'utf8')
  const credentials = readPrivateJson(join(input.root, 'credentials-private.json'))
  const manifestText = readFileSync(join(input.root, 'manifest.json'), 'utf8')
  expect(manifestText).not.toContain(credentials.operator.password)
  const db = new Database(join(input.root, 'state.sqlite3'), { readonly: true })
  expect(JSON.stringify(db.query('SELECT * FROM accounts').all())).not.toContain(credentials.operator.password)
  expect(db.query<{ count: number }, []>('SELECT COUNT(*) count FROM alerts').get()!.count).toBe(1)
  db.close()
  const command = Bun.spawnSync([process.execPath, 'scripts/demo-seed.ts', 'inspect', '--local-synthetic', `--parent=${input.parent}`, `--root=${input.root}`], { cwd: import.meta.dir + '/..' })
  expect(command.exitCode).toBe(0)
  expect(command.stdout.toString()).not.toContain(credentials.operator.password)
  expect(command.stderr.toString()).toBe('')
})

test('demo_repeatability: reset requires exact marked test root and token; reinitialize produces a separate fresh identity set', async () => {
  const input = options(), first = await seedDemo(input, runners)
  expect(() => resetDemo(input, 'wrong')).toThrow('explicit_root_confirmation_required')
  expect(inspectDemo(input)).toEqual(first)
  resetDemo(input, first.rootId)
  expect(existsSync(input.root)).toBe(false)
  const second = await seedDemo(input, runners)
  expect(second.cases[0]!.patientId).not.toBe(first.cases[0]!.patientId)
  expect(second.cases[1]!.accountId).not.toBe(first.cases[1]!.accountId)
})

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
})

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
  const command = Bun.spawnSync([process.execPath, 'scripts/demo-seed.ts', 'inspect', '--local-synthetic', `--parent=${input.parent}`, `--root=${input.root}`], { cwd: import.meta.dir + '/..', env: { ...process.env, NODE_ENV: 'production' } })
  expect(command.exitCode).not.toBe(0)
  expect(command.stderr.toString()).toContain('synthetic_mode_required')
})
