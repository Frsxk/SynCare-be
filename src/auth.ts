/** Bearer-token auth for the console API. Fail-closed: a missing token locks the API. */
import { createHash, timingSafeEqual } from 'node:crypto'

export class AuthError extends Error {
  constructor(message = 'A valid bearer token is required.') {
    super(message)
    this.name = 'AuthError'
  }
}

/** No token configured on the server; distinct from a bad client token. */
export class AuthNotConfiguredError extends Error {
  constructor() {
    super('SYNCARE_API_KEY is not set on the server. The API is locked.')
    this.name = 'AuthNotConfiguredError'
  }
}

/** Extract a Bearer token; returns null for absent or malformed headers. */
export function extractBearer(header: string | null | undefined): string | null {
  if (!header) return null
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim())
  if (!match) return null
  const token = match[1]
  if (token === undefined) return null
  const trimmed = token.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Constant-time comparison; both sides are hashed so length differences cannot throw or leak. */
export function tokensMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}