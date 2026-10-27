import { expect, test } from 'bun:test'
import { DomainError, errorResponse } from '../src/modules/contracts/errors.ts'
import { parseBoundedJson, strictTextObject, textLimits } from '../src/modules/contracts/validation.ts'
import { canonicalPayloadHash, withIdempotency } from '../src/modules/contracts/idempotency.ts'
import { CursorCodec, pageInput, seekBoundary } from '../src/modules/contracts/pagination.ts'
import { database, NOW } from './migrations/fixture.ts'

const KEY = 'b32f13e3-d010-4109-8572-13d88d268423'
test('contracts_reject_unknown_fields: malformed and oversize mutation cannot write a row', async () => {
  const { store } = await database()
  for (const body of [null, [], { message: 'hi', patientId: 'forged' }, { message: ' ' }, { message: 'a'.repeat(8001) }]) {
    await expect((async () => {
      strictTextObject(body, { message: textLimits.checkin })
      await store.transaction(tx => tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)', ['a', 'n', 'x', 'x', 'x', NOW, '{}']))
    })()).rejects.toBeInstanceOf(DomainError)
  }
  expect(store.all('SELECT * FROM operational_audit')).toHaveLength(0)
  expect(strictTextObject({ message: '  Original clinical text  ' }, { message: 8000 }).message).toBe('  Original clinical text  ')
  expect(() => parseBoundedJson('{malformed')).toThrow('validation_failed')
  expect(() => parseBoundedJson(JSON.stringify({ message: 'a'.repeat(262144) }))).toThrow('validation_failed')
})
test('idempotency payload canonicalization, replay, principal isolation and transactional rollback', async () => {
  const { store, reopen } = await database()
  const input = { principalId: 'actor-a', method: 'POST', resourceKey: '/patients', key: KEY, payload: { b: 2, a: 1 } }
  const write = () => withIdempotency(store, input, tx => {
    tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)', ['audit-a', 'actor-a', 'created', 'patient', 'p1', NOW, '{}'])
    return { resourceId: 'p1', status: 201, data: { id: 'p1' } }
  })
  expect((await write()).replayed).toBe(false)
  expect((await withIdempotency(store, { ...input, payload: { a: 1, b: 2 } }, () => { throw new Error('must not execute') })).replayed).toBe(true)
  await expect(withIdempotency(store, { ...input, payload: { a: 9 } }, () => ({ resourceId: 'bad', status: 201, data: {} }))).rejects.toMatchObject({ code: 'idempotency_conflict', status: 409 })
  await withIdempotency(store, { ...input, principalId: 'actor-b' }, () => ({ resourceId: 'p2', status: 201, data: { id: 'p2' } }))
  await expect(withIdempotency(store, { ...input, resourceKey: '/rollback' }, tx => {
    tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)', ['rollback', 'a', 'x', 'x', 'x', NOW, '{}'])
    throw new Error('after side effect')
  })).rejects.toThrow('after side effect')
  expect(store.all('SELECT * FROM operational_audit')).toHaveLength(1)
  expect(store.all('SELECT * FROM idempotency_receipts')).toHaveLength(2)
  store.close()
  const restored = reopen()
  expect((await withIdempotency(restored, input, () => { throw new Error('no replay after restart') })).replayed).toBe(true)
  expect(canonicalPayloadHash({ a: 1, b: 2 })).toBe(canonicalPayloadHash({ b: 2, a: 1 }))
  expect(() => canonicalPayloadHash({ value: NaN })).toThrow('validation_failed')
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  expect(() => canonicalPayloadHash(cyclic)).toThrow('validation_failed')
})
test('stable signed scope-bound cursor pages equal timestamps without gaps or repeats', async () => {
  const { store } = await database()
  await store.transaction(tx => {
    for (const id of ['a', 'b', 'c']) tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)', [id, 'actor', 'x', 'x', 'x', NOW, '{}'])
  })
  const codec = new CursorCodec('synthetic-pagination-test-secret-at-least-32-bytes')
  const scope = 'actor-a:patients:status=active'
  const first = store.all<{ id: string; createdAt: string }>('SELECT id,occurred_at AS createdAt FROM operational_audit ORDER BY julianday(occurred_at) DESC,id DESC LIMIT 2')
  const cursor = codec.encode(scope, first[1]!)
  const last = codec.decode(scope, cursor)
  const boundary = seekBoundary(last, 'occurred_at')
  const second = store.all<{ id: string }>(`SELECT id FROM operational_audit WHERE ${boundary.sql} ORDER BY julianday(occurred_at) DESC,id DESC`, boundary.bindings)
  expect([...first, ...second].map(row => row.id)).toEqual(['c', 'b', 'a'])
  expect(() => codec.decode('actor-b:patients', cursor)).toThrow('validation_failed')
  expect(() => codec.decode(scope, cursor.slice(0, -3) + 'bad')).toThrow('validation_failed')
  expect(pageInput({})).toEqual({ limit: 20 })
  expect(pageInput({ limit: '100', cursor })).toEqual({ limit: 100, cursor })
  for (const value of ['101', '0', '1.5', '01', 'no']) expect(() => pageInput({ limit: value })).toThrow('validation_failed')
  expect(() => pageInput({ extra: 'value' })).toThrow('validation_failed')
})
test('errors expose stable sanitized codes, conflict versions and ambiguous mutation recovery', async () => {
  const conflict = errorResponse(new DomainError('version_conflict', { resourceId: 'p1', currentVersion: 2 }), 'request-a')
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toMatchObject({ error: { code: 'version_conflict', requestId: 'request-a', currentVersion: 2, retryable: false } })
  const unknown = errorResponse(new Error('secret upstream exception'), 'request-b', true)
  expect(await unknown.text()).not.toContain('secret')
  expect(errorResponse(new DomainError('outcome_unknown'), 'r').status).toBe(502)
})
