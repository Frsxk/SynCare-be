/**
 * Bearer-token authentication for the console API.
 *
 * WHY BEARER AND NOT BASIC AUTH: a token-based SPA sends the credential in a
 * header it controls. Basic Auth couples the credential to the browser's own
 * auth dialog and origin-bound credential caching, which breaks fetch/XHR and
 * forces the user through a native prompt on every origin.
 *
 * FAIL-CLOSED BY CONSTRUCTION: this module never has an "open" branch. If no
 * token is configured the server refuses the request; it does not fall back to
 * allowing anonymous access. Deploying with a missing env var must lock the API
 * shut, not expose it.
 */
import { createHash, timingSafeEqual } from 'node:crypto'

/** Thrown when a request presents no credential or the wrong one. */
export class AuthError extends Error {
  constructor(message = 'A valid bearer token is required.') {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * Thrown when the server has no token configured at all. Distinct from
 * AuthError so the operator gets an actionable message ("set SYNCARE_API_KEY")
 * rather than being told their token is wrong.
 */
export class AuthNotConfiguredError extends Error {
  constructor() {
    super('SYNCARE_API_KEY is not set on the server. The API is locked.')
    this.name = 'AuthNotConfiguredError'
  }
}

/**
 * Pull the credential out of an Authorization header.
 * Returns null for absent, non-Bearer, or malformed values — never throws, so
 * a hostile header cannot reach the comparison logic with junk.
 */
export function extractBearer(header: string | null | undefined): string | null {
  if (!header) return null
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim())
  if (!match) return null
  const token = match[1]
  if (token === undefined) return null
  const trimmed = token.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Constant-time string comparison.
 *
 * timingSafeEqual throws if the buffers differ in length, so both sides are
 * hashed first: that makes the comparison constant-time regardless of token
 * length AND keeps it from leaking the expected length via an exception.
 */
export function tokensMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}