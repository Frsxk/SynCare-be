/** Runtime config from the environment. Secrets are never hardcoded, logged, or returned. */
import { fileURLToPath } from 'node:url'
import { unprotectEnvironment } from './security/private-files.cjs'

/** Thrown when required configuration is absent. Messages never include values. */
export class ConfigError extends Error {}

export interface SecurityConfig { backendOrigin: string; webOrigin: string; allowLocalHttp: boolean }

export function loadSecurityConfig(environment: Record<string, string | undefined> = process.env): SecurityConfig {
  unprotectEnvironment(environment)
  const allowLocalHttp = environment.SYNCARE_ALLOW_LOCAL_HTTP === 'true'
  const parse = (value: string | undefined): string => {
    let url: URL
    try { url = new URL(value ?? '') } catch { throw new ConfigError('An explicit application origin is required.') }
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        (url.protocol !== 'https:' && !(allowLocalHttp && local && url.protocol === 'http:'))) {
      throw new ConfigError('Application origins require HTTPS or the explicit loopback development exception.')
    }
    return url.origin
  }
  return { backendOrigin: parse(environment.SYNCARE_BACKEND_ORIGIN), webOrigin: parse(environment.SYNCARE_WEB_ORIGIN), allowLocalHttp }
}

function required(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new ConfigError(`${name} is not set. Copy .env.example to .env and fill it in.`)
  }
  return value
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]
  return value && value.trim() !== '' ? value : fallback
}

function flag(name: string, fallback = false): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase())
}

export interface AppConfig {
  langflowBaseUrl: string
  langflowApiKey: string
  reviewDbPath: string
  consoleStateDbPath: string
  host: string
  port: number
  readOnly: boolean
  /** Server-only infrastructure credential for operator health; never a user session. */
  apiKey: string
}

/** Build config; missing required values fail at startup. */
export function loadConfig(): AppConfig {
  unprotectEnvironment()
  return {
    langflowBaseUrl: optional('LANGFLOW_BASE_URL', 'http://127.0.0.1:7860').replace(/\/$/, ''),
    langflowApiKey: required('LANGFLOW_API_KEY'),
    // Host-side mount target; runtime F4/F5 alignment still needs Q09 verification.
    reviewDbPath: optional(
      'SYNCARE_REVIEW_DB',
      fileURLToPath(new URL('../data/langflow/langflow/syncare-review.sqlite3', import.meta.url)),
    ),
    consoleStateDbPath: optional(
      'SYNCARE_STATE_DB',
      fileURLToPath(new URL('../data/console-state.sqlite3', import.meta.url)),
    ),
    host: optional('SYNCARE_HOST', '127.0.0.1'),
    port: Number(optional('SYNCARE_PORT', '8080')),
    readOnly: flag('SYNCARE_READ_ONLY', false),
    apiKey: optional('SYNCARE_API_KEY', ''),
  }
}

/** Returned by /api/health: synthetic demo, not a clinical device. */
export const DISCLAIMER =
  'Synthetic engineering demo. Not clinically validated and not a calibrated risk ' +
  'prediction model. No diagnosis, no medication changes, no emergency advice. Human ' +
  'clinical oversight required. FHIR-shaped output is not a SATUSEHAT submission.'
