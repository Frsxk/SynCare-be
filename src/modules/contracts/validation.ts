import { DomainError } from './errors.ts'

export const textLimits = { query: 2000, checkin: 8000, discharge: 64000, note: 4000, address: 2000 } as const
export const MAX_REQUEST_BYTES = 262144

export function strictTextObject<K extends string>(input: unknown, fields: Record<K, number>): Record<K, string> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new DomainError('validation_failed')
  const object = input as Record<string, unknown>
  const names = Object.keys(fields) as K[]
  if (Object.keys(object).some(key => !Object.hasOwn(fields, key))) throw new DomainError('validation_failed')
  for (const name of names) {
    const value = object[name]
    if (typeof value !== 'string' || !value.trim() || [...value].length > fields[name]) throw new DomainError('validation_failed')
  }
  return Object.fromEntries(names.map(name => [name, object[name]])) as Record<K, string>
}

export function parseBoundedJson(text: string): unknown {
  if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BYTES) throw new DomainError('validation_failed')
  try { return JSON.parse(text) } catch { throw new DomainError('validation_failed') }
}

export async function readJsonRequest(request: Request, maximumBytes = MAX_REQUEST_BYTES): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new DomainError('validation_failed')
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximumBytes)) throw new DomainError('validation_failed')
  const reader = request.body?.getReader()
  if (!reader) throw new DomainError('validation_failed')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maximumBytes) { await reader.cancel(); throw new DomainError('validation_failed') }
      chunks.push(chunk.value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } catch { throw new DomainError('validation_failed') }
  finally { reader.releaseLock() }
}
