import { createHmac, timingSafeEqual } from 'node:crypto'
import { DomainError } from './errors.ts'

export interface PageInput { limit: number; cursor?: string }
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface PageEnvelope<T> { data: T[]; nextCursor: string | null; requestId: string }
interface Position { createdAt: string; id: string }
const invalid = () => new DomainError('validation_failed')

export function pageInput(input: Record<string, unknown>): PageInput {
  if (Object.keys(input).some(key => key !== 'limit' && key !== 'cursor')) throw invalid()
  const limit = input.limit === undefined ? 20 : typeof input.limit === 'string' && /^[1-9]\d{0,2}$/.test(input.limit) ? Number(input.limit) : NaN
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid()
  if (input.cursor !== undefined && (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 2048)) throw invalid()
  return { limit, ...(input.cursor === undefined ? {} : { cursor: input.cursor as string }) }
}

export class CursorCodec {
  constructor(private readonly secret: string) {
    if (Buffer.byteLength(secret) < 32) throw new Error('cursor_secret_required')
  }
  private sign(text: string) { return createHmac('sha256', this.secret).update(text).digest('base64url') }
  encode(scope: string, position: Position): string {
    if (!scope || scope.length > 512 || !position.id || position.id.length > 128 || !Number.isFinite(Date.parse(position.createdAt))) throw invalid()
    const text = Buffer.from(JSON.stringify({ v: 1, scope, createdAt: position.createdAt, id: position.id })).toString('base64url')
    return `${text}.${this.sign(text)}`
  }
  decode(scope: string, cursor: string): Position {
    if (cursor.length > 2048) throw invalid()
    const match = /^([\w-]+)\.([\w-]{43})$/.exec(cursor)
    if (!match) throw invalid()
    const expected = Buffer.from(this.sign(match[1]!))
    const signature = Buffer.from(match[2]!)
    if (!timingSafeEqual(expected, signature)) throw invalid()
    try {
      const value = JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8'))
      if (value.v !== 1 || value.scope !== scope || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.id !== 'string' || !value.id || value.id.length > 128) throw invalid()
      return { createdAt: value.createdAt, id: value.id }
    } catch { throw invalid() }
  }
}

export function seekBoundary(position: Position, timeColumn: 'created_at' | 'occurred_at' = 'created_at') {
  if (!['created_at', 'occurred_at'].includes(timeColumn)) throw invalid()
  return {
    sql: `(julianday(${timeColumn}) < julianday(?) OR (julianday(${timeColumn}) = julianday(?) AND id < ?))`,
    bindings: [position.createdAt, position.createdAt, position.id],
  }
}
