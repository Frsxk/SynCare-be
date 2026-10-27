import {afterEach, expect, test} from 'bun:test'
import {chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'
import {createDecipheriv, randomBytes} from 'node:crypto'
import {protectText, unprotectText, readPrivateJson, writePrivateJson, unprotectEnvironment} from '../src/security/private-files.cjs'

const WINDOWS = process.platform === 'win32'
const DPAPI = 'dpapi:v1:'
const AESGCM = 'aesgcm:v1:'
const AAD = 'SynCare.local.private.v1:aesgcm:v1'
const windowsTest = WINDOWS ? test : test.skip
const linuxTest = WINDOWS ? test.skip : test
const parents: string[] = []

afterEach(() => {
  for (const parent of parents.splice(0)) rmSync(parent, {recursive: true, force: true, maxRetries: 5, retryDelay: 20})
})

function fixtureDirectory(): string {
  const parent = mkdtempSync(join(tmpdir(), 'syncare-private-'))
  parents.push(parent)
  return parent
}

function keyFixture(parent: string, bytes: Buffer = randomBytes(32)): {environment: Record<string, string | undefined>; keyFile: string} {
  if (WINDOWS) return {environment: {}, keyFile: ''}
  const directory = join(parent, 'keyring')
  mkdirSync(directory, {mode: 0o700})
  chmodSync(directory, 0o700)
  const keyFile = join(directory, 'private.key')
  writeFileSync(keyFile, bytes, {mode: 0o600})
  chmodSync(keyFile, 0o600)
  return {environment: {SYNCARE_PRIVATE_KEY_FILE: keyFile}, keyFile}
}

function payloadOf(sealed: string, prefix: string): Buffer {
  return Buffer.from(sealed.slice(prefix.length), 'base64')
}

function aesSeal(bytes: Buffer): string {
  return AESGCM + bytes.toString('base64')
}

test('protected text and JSON round-trip without plaintext on disk or in the environment', () => {
  const parent = fixtureDirectory()
  const {environment} = keyFixture(parent)
  const secret = randomBytes(32).toString('base64url')
  const sealed = protectText(secret, environment)
  expect(sealed.startsWith(WINDOWS ? DPAPI : AESGCM)).toBe(true)
  expect(sealed).not.toContain(secret)
  expect(unprotectText(sealed, environment)).toBe(secret)

  const file = join(parent, 'credentials.json')
  const value = {password: secret, identifier: 'synthetic@synthetic.invalid'}
  writePrivateJson(file, value, environment)
  const stored = readFileSync(file, 'utf8')
  expect(stored.startsWith(WINDOWS ? DPAPI : AESGCM)).toBe(true)
  expect(stored).not.toContain(secret)
  expect(readPrivateJson(file, environment)).toEqual(value)
  expect(readPrivateJson(pathToFileURL(file), environment)).toEqual(value)

  const environmentValues = {...environment, SYNCARE_API_KEY: sealed, SYNCARE_HOST: '127.0.0.1'}
  expect(unprotectEnvironment(environmentValues)).toEqual({...environment, SYNCARE_API_KEY: secret, SYNCARE_HOST: '127.0.0.1'})
  expect(readdirSync(parent).some(name => name.includes('protected-tmp'))).toBe(false)
  if (!WINDOWS) expect(statSync(file).mode & 0o777).toBe(0o600)
}, 30000)

test('legacy plaintext JSON reads remain explicit compatibility without ever being written', () => {
  const parent = fixtureDirectory()
  const file = join(parent, 'legacy.json')
  writeFileSync(file, JSON.stringify({legacy: 'synthetic', nested: {value: 1}}))
  expect(readPrivateJson(file)).toEqual({legacy: 'synthetic', nested: {value: 1}})
})

test('invalid, unknown-version and malformed envelopes fail closed before filesystem access', () => {
  expect(() => unprotectText('not-an-envelope')).toThrow('invalid_private_envelope')
  expect(() => unprotectText('')).toThrow('invalid_private_envelope')
  expect(() => unprotectText(DPAPI + '!invalid!')).toThrow('invalid_private_envelope')
  expect(() => unprotectText(AESGCM + '!invalid!')).toThrow('invalid_private_envelope')
  expect(() => unprotectText('dpapi:v2:' + Buffer.from('unsupported').toString('base64'))).toThrow('invalid_private_envelope')
  expect(() => unprotectText('aesgcm:v2:' + Buffer.from('unsupported').toString('base64'))).toThrow('invalid_private_envelope')
  expect(() => unprotectEnvironment({SYNCARE_SESSION_SECRET: 'dpapi:v2:' + Buffer.from('unsupported').toString('base64')})).toThrow('invalid_private_envelope')
  expect(() => unprotectEnvironment({SYNCARE_SESSION_SECRET: 'aesgcm:v2:' + Buffer.from('unsupported').toString('base64')})).toThrow('invalid_private_envelope')
})

test('foreign native envelope families are rejected explicitly instead of guessed', () => {
  if (WINDOWS) {
    expect(() => unprotectText(aesSeal(Buffer.alloc(28, 7)))).toThrow('unsupported_private_envelope')
  } else {
    expect(() => unprotectText(DPAPI + Buffer.from('synthetic ciphertext').toString('base64'))).toThrow('windows_protection_required')
  }
})

windowsTest('native Windows CurrentUser DPAPI round-trips credentials via stdin/stdout only', () => {
  const parent = fixtureDirectory()
  const secret = randomBytes(32).toString('base64url')
  const sealed = protectText(secret)
  expect(sealed.startsWith(DPAPI)).toBe(true)
  expect(sealed).not.toContain(secret)
  expect(unprotectText(sealed)).toBe(secret)
  expect(unprotectText(sealed)).toBe(secret)
  const file = join(parent, 'credentials.json')
  writePrivateJson(file, {password: secret})
  expect(readPrivateJson(file).password).toBe(secret)
  expect(() => unprotectText(DPAPI + Buffer.from('corrupted synthetic payload').toString('base64'))).toThrow('private_material_unavailable')
}, 30000)

linuxTest('Linux AES-256-GCM uses a fresh nonce, canonical envelope layout and the exact AAD', () => {
  const parent = fixtureDirectory()
  const {environment, keyFile} = keyFixture(parent)
  const text = 'synthetic secret value'
  const first = protectText(text, environment), second = protectText(text, environment)
  expect(first).not.toBe(second)
  expect(unprotectText(first, environment)).toBe(text)
  expect(unprotectText(second, environment)).toBe(text)

  const payload = payloadOf(first, AESGCM)
  expect(payload.length).toBe(12 + 16 + Buffer.byteLength(text))
  expect(payload.subarray(0, 12)).not.toEqual(payloadOf(second, AESGCM).subarray(0, 12))

  const key = readFileSync(keyFile)
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12))
  decipher.setAAD(Buffer.from(AAD, 'utf8'))
  decipher.setAuthTag(payload.subarray(12, 28))
  const plaintext = Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()])
  expect(plaintext.toString('utf8')).toBe(text)

  const wrongAad = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12))
  wrongAad.setAAD(Buffer.from('SynCare.local.private.v1', 'utf8'))
  wrongAad.setAuthTag(payload.subarray(12, 28))
  expect(() => Buffer.concat([wrongAad.update(payload.subarray(28)), wrongAad.final()])).toThrow()
})

linuxTest('Linux AES-256-GCM round-trips empty text with an authentication tag and no ciphertext', () => {
  const parent = fixtureDirectory()
  const {environment} = keyFixture(parent)
  const sealed = protectText('', environment)
  expect(payloadOf(sealed, AESGCM).length).toBe(12 + 16)
  expect(unprotectText(sealed, environment)).toBe('')
})

linuxTest('Linux AES-256-GCM rejects a wrong key, does not cache plaintext and rechecks after rotation', () => {
  const parent = fixtureDirectory()
  const first = keyFixture(parent)
  const secondDirectory = join(parent, 'rotated')
  mkdirSync(secondDirectory, {mode: 0o700})
  const rotatedKey = join(secondDirectory, 'private.key')
  writeFileSync(rotatedKey, randomBytes(32), {mode: 0o600})
  chmodSync(rotatedKey, 0o600)
  const rotated = {SYNCARE_PRIVATE_KEY_FILE: rotatedKey}
  const sealed = protectText('rotation sensitive', first.environment)
  expect(() => unprotectText(sealed, rotated)).toThrow('private_material_unavailable')
  expect(() => unprotectEnvironment({...rotated, SYNCARE_SESSION_SECRET: sealed})).toThrow('private_material_unavailable')
  expect(unprotectText(sealed, first.environment)).toBe('rotation sensitive')
})

linuxTest('Linux AES-256-GCM rejects tampered IV, tag and ciphertext plus truncated or non-canonical payloads', () => {
  const parent = fixtureDirectory()
  const {environment} = keyFixture(parent)
  const text = 'synthetic-secret'
  const payload = payloadOf(protectText(text, environment), AESGCM)
  const tamperedIv = Buffer.from(payload); tamperedIv[0] = tamperedIv[0]! ^ 1
  const tamperedTag = Buffer.from(payload); tamperedTag[12] = tamperedTag[12]! ^ 1
  const tamperedCiphertext = Buffer.from(payload); tamperedCiphertext[tamperedCiphertext.length - 1] = tamperedCiphertext[tamperedCiphertext.length - 1]! ^ 1
  expect(() => unprotectText(aesSeal(tamperedIv), environment)).toThrow('private_material_unavailable')
  expect(() => unprotectText(aesSeal(tamperedTag), environment)).toThrow('private_material_unavailable')
  expect(() => unprotectText(aesSeal(tamperedCiphertext), environment)).toThrow('private_material_unavailable')
  expect(() => unprotectText(aesSeal(Buffer.from(payload.subarray(0, 27))), environment)).toThrow('invalid_private_envelope')
  expect(() => unprotectText(aesSeal(Buffer.from(payload.subarray(0, payload.length - 1))), environment)).toThrow('private_material_unavailable')
  expect(() => unprotectText(aesSeal(Buffer.from(payload.subarray(0, 28))), environment)).toThrow('private_material_unavailable')
  const canonical = payload.toString('base64')
  if (canonical.endsWith('=')) expect(() => unprotectText(AESGCM + canonical.replace(/=+$/, ''), environment)).toThrow('invalid_private_envelope')
})

linuxTest('Linux key file requires an absolute regular 32-byte owner-only single-link path without a final symlink', () => {
  const parent = fixtureDirectory()
  const {environment, keyFile} = keyFixture(parent)
  const expectUnavailable = (candidate: Record<string, string | undefined>) => {
    try {
      protectText('synthetic', candidate)
      throw Error('expected_private_key_unavailable')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toBe('private_key_unavailable')
      expect(message).not.toContain(parent)
    }
  }
  expectUnavailable({})
  expectUnavailable({SYNCARE_PRIVATE_KEY_FILE: 'relative/private.key'})
  expectUnavailable({SYNCARE_PRIVATE_KEY_FILE: join(parent, 'missing.key')})
  expectUnavailable({SYNCARE_PRIVATE_KEY_FILE: parent})
  const symlink = join(parent, 'private-link.key')
  symlinkSync(keyFile, symlink)
  expectUnavailable({SYNCARE_PRIVATE_KEY_FILE: symlink})
  const worldReadable = join(parent, 'world-readable.key')
  writeFileSync(worldReadable, randomBytes(32), {mode: 0o600}); chmodSync(worldReadable, 0o644)
  expectUnavailable({SYNCARE_PRIVATE_KEY_FILE: worldReadable})
  const groupReadable = join(parent, 'group-readable.key')
  writeFileSync(groupReadable, randomBytes(32), {mode: 0o600}); chmodSync(groupReadable, 0o640)
  expectUnavailable({SYNCARE_PRIVATE_KEY_FILE: groupReadable})
  for (const mode of [0o400, 0o700, 0o4600]) {
    const wrongMode = join(parent, `wrong-mode-${mode}.key`)
    writeFileSync(wrongMode, randomBytes(32), {mode: 0o600}); chmodSync(wrongMode, mode)
    expectUnavailable({SYNCARE_PRIVATE_KEY_FILE: wrongMode})
  }
  for (const size of [31, 33]) {
    const wrongSize = join(parent, `wrong-size-${size}.key`)
    writeFileSync(wrongSize, randomBytes(size), {mode: 0o600}); chmodSync(wrongSize, 0o600)
    expectUnavailable({SYNCARE_PRIVATE_KEY_FILE: wrongSize})
  }
  const hardSource = join(parent, 'hard-source.key')
  writeFileSync(hardSource, randomBytes(32), {mode: 0o600}); chmodSync(hardSource, 0o600)
  const hardLink = join(parent, 'hard-link.key')
  linkSync(hardSource, hardLink)
  expectUnavailable({SYNCARE_PRIVATE_KEY_FILE: hardLink})
  expect(unprotectText(protectText('synthetic', environment), environment)).toBe('synthetic')
})

linuxTest('a key replaced by a FIFO between lstat and open is rejected without blocking', () => {
  const parent = fixtureDirectory()
  const {keyFile} = keyFixture(parent)
  const adapter = fileURLToPath(new URL('../src/security/private-files.cjs', import.meta.url))
  const script = `
    const fs = require('node:fs');
    const {execFileSync} = require('node:child_process');
    const [adapter, key] = process.argv.slice(1);
    const original = fs.lstatSync;
    let replaced = false;
    fs.lstatSync = function(path, ...args) {
      const result = original.call(this, path, ...args);
      if (path === key && !replaced) {
        replaced = true;
        fs.unlinkSync(key);
        execFileSync('mkfifo', ['-m', '600', key]);
      }
      return result;
    };
    const {protectText} = require(adapter);
    try { protectText('owned-fifo-race', {SYNCARE_PRIVATE_KEY_FILE: key}); process.exitCode = 2; }
    catch (error) { process.stdout.write(error.message); }
  `
  const result = spawnSync('node', ['-e', script, adapter, keyFile], {encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL'})
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  expect(statSync(keyFile).isFIFO()).toBe(true)
  expect(result.stdout).toBe('private_key_unavailable')
  expect(result.stderr).toBe('')
}, 5000)

linuxTest('Linux key source comes from the supplied environment object, not process.env', () => {
  const parent = fixtureDirectory()
  const {environment} = keyFixture(parent)
  const previous = process.env.SYNCARE_PRIVATE_KEY_FILE
  try {
    process.env.SYNCARE_PRIVATE_KEY_FILE = join(parent, 'global-missing.key')
    const sealed = protectText('object isolated', environment)
    expect(unprotectText(sealed, environment)).toBe('object isolated')
    expect(unprotectEnvironment({...environment, SYNCARE_API_KEY: sealed})).toEqual({...environment, SYNCARE_API_KEY: 'object isolated'})
    const other = {...environment, SYNCARE_PRIVATE_KEY_FILE: join(parent, 'other-missing.key')}
    expect(() => unprotectEnvironment({...other, SYNCARE_API_KEY: sealed})).toThrow('private_key_unavailable')
  } finally {
    if (previous === undefined) delete process.env.SYNCARE_PRIVATE_KEY_FILE
    else process.env.SYNCARE_PRIVATE_KEY_FILE = previous
  }
})

linuxTest('failed protection never creates the target or a plaintext temporary file', () => {
  const parent = fixtureDirectory()
  const file = join(parent, 'credentials.json')
  const existing = join(parent, 'existing.json')
  writeFileSync(existing, 'synthetic sentinel')
  const secret = randomBytes(24).toString('base64url')
  expect(() => writePrivateJson(file, {password: secret}, {SYNCARE_PRIVATE_KEY_FILE: join(parent, 'missing.key')})).toThrow('private_key_unavailable')
  expect(existsSync(file)).toBe(false)
  expect(() => writePrivateJson(existing, {password: secret}, {SYNCARE_PRIVATE_KEY_FILE: join(parent, 'missing.key')})).toThrow('private_key_unavailable')
  expect(readFileSync(existing, 'utf8')).toBe('synthetic sentinel')
  expect(readdirSync(parent)).toEqual(['existing.json'])
})

linuxTest('successful writes are atomic, owner-only and leave no temporary or plaintext artifact', () => {
  const parent = fixtureDirectory()
  const {environment} = keyFixture(parent)
  const file = join(parent, 'credentials.json')
  const secret = randomBytes(24).toString('base64url')
  writePrivateJson(file, {password: secret}, environment)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(readdirSync(parent).concat(readdirSync(join(parent, 'keyring'))).some(name => name.includes('protected-tmp'))).toBe(false)
  for (const name of readdirSync(parent)) {
    if (name === 'keyring') continue
    expect(readFileSync(join(parent, name), 'utf8')).not.toContain(secret)
  }
  expect(readPrivateJson(file, environment)).toEqual({password: secret})
})
