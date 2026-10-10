/**
 * Runtime configuration, read from the environment only.
 *
 * No secret is ever hardcoded, logged, or returned by an error message.
 */

/** Thrown when required configuration is absent. Messages never include values. */
export class ConfigError extends Error {}

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
  /**
   * Bearer token required on every /api/v1 route. Deliberately NOT required()
   * at startup: a missing value must LOCK the API rather than crash the
   * process, so the operator can read the startup error while /api stays shut.
   * An empty string here means "no token configured" -> every API call 401s.
   */
  apiKey: string
}

/**
 * Build the config. Throws ConfigError when a required value is missing —
 * failing at startup is better than failing on the first request.
 */
export function loadConfig(): AppConfig {
  return {
    langflowBaseUrl: optional('LANGFLOW_BASE_URL', 'http://127.0.0.1:7860').replace(/\/$/, ''),
    langflowApiKey: required('LANGFLOW_API_KEY'),
    // Default MUST match where F4 actually writes inside the container's bind
    // mount: /app/langflow/langflow/syncare-review.sqlite3 maps to
    // <repo>/data/langflow/langflow/syncare-review.sqlite3 on the host.
    // See scripts/fix-review-db-path.ts, which repointed the flow from the
    // /home/frxskie path baked in by the original export.
    reviewDbPath: optional(
      'SYNCARE_REVIEW_DB',
      new URL('../data/langflow/langflow/syncare-review.sqlite3', import.meta.url).pathname,
    ),
    consoleStateDbPath: optional(
      'SYNCARE_STATE_DB',
      new URL('../data/console-state.sqlite3', import.meta.url).pathname,
    ),
    host: optional('SYNCARE_HOST', '127.0.0.1'),
    port: Number(optional('SYNCARE_PORT', '8080')),
    readOnly: flag('SYNCARE_READ_ONLY', false),
    apiKey: optional('SYNCARE_API_KEY', ''),
  }
}

/** Footer shown on every page: this is a synthetic demo, not a clinical device. */
export const DISCLAIMER =
  'Synthetic engineering demo. Not clinically validated and not a calibrated risk ' +
  'prediction model. No diagnosis, no medication changes, no emergency advice. Human ' +
  'clinical oversight required. FHIR-shaped output is not a SATUSEHAT submission.'