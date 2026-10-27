import { createHash } from 'node:crypto'
import type { Store, Transaction } from '../../storage/database.ts'
import { DomainError } from './errors.ts'
import { MAX_REQUEST_BYTES } from './validation.ts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function canonicalPayloadHash(payload: unknown): string {
  const ancestors = new Set<object>()
  const canonical = (value: unknown, depth: number): string => {
    if (depth > 32) throw new DomainError('validation_failed')
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
    if (typeof value !== 'object' || ancestors.has(value)) throw new DomainError('validation_failed')
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new DomainError('validation_failed')
    ancestors.add(value)
    const result = Array.isArray(value)
      ? `[${Array.from(value, item => canonical(item, depth + 1)).join(',')}]`
      : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`
    ancestors.delete(value)
    return result
  }
  const text = canonical(payload, 0)
  if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) throw new DomainError('validation_failed')
  return createHash('sha256').update(text).digest('hex')
}

interface Intent { principalId: string; method: string; resourceKey: string; key: string; payload: unknown }
interface Receipt<T> { resourceId: string; status: number; data: T }
interface Saved { payload_hash: string; resource_id: string; response_status: number; response_json: string }

// Only local, synchronous DB effects belong here. Upstream calls need a durable job/unknown-outcome protocol.
export async function withIdempotency<T>(store: Store, intent: Intent, work: (tx: Transaction) => Receipt<T>): Promise<Receipt<T> & { replayed: boolean }> {
  if (!uuid.test(intent.key) || !intent.principalId || !intent.resourceKey || !['POST', 'PATCH', 'DELETE'].includes(intent.method)) throw new DomainError('validation_failed')
  if (work.constructor.name === 'AsyncFunction') throw new DomainError('validation_failed')
  const hash = canonicalPayloadHash(intent.payload)
  return store.transaction(tx => {
    const keys = [intent.principalId, intent.method, intent.resourceKey, intent.key]
    const saved = tx.get<Saved>('SELECT * FROM idempotency_receipts WHERE principal_id=? AND method=? AND resource_key=? AND idempotency_key=?', keys)
    if (saved) {
      if (saved.payload_hash !== hash) throw new DomainError('idempotency_conflict')
      return { resourceId: saved.resource_id, status: saved.response_status, data: JSON.parse(saved.response_json) as T, replayed: true }
    }
    const receipt = work(tx)
    if (!receipt || typeof (receipt as unknown as { then?: unknown }).then === 'function') throw new DomainError('validation_failed')
    if (!receipt.resourceId || !Number.isInteger(receipt.status) || receipt.status < 200 || receipt.status > 299) throw new DomainError('validation_failed')
    canonicalPayloadHash(receipt.data)
    tx.run(`INSERT INTO idempotency_receipts(principal_id,method,resource_key,idempotency_key,payload_hash,resource_id,response_status,response_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, [...keys, hash, receipt.resourceId, receipt.status, JSON.stringify(receipt.data), new Date().toISOString()])
    return { ...receipt, replayed: false }
  })
}
