/**
 * Langflow API client plugin for the SynCare console.
 *
 * Three operations:
 *  1. runFlow(flowId, inputValue, opts?)           — POST /api/v1/run/{flowId} (sync)
 *  2. startReviewJob(flowId, inputValue, sessionId) — POST /api/v2/workflows (background mode, HITL)
 *  3. resumeReviewJob(jobId, decision)              — POST /api/v2/workflows/{jobId}/resume
 *
 * Design rules (from scripts/discover-flows.ts):
 *  - Never hardcode a credential, URL, or flow ID.
 *  - BASE = LANGFLOW_BASE_URL ?? 'http://127.0.0.1:7860' (trailing slash stripped).
 *  - Throw if LANGFLOW_API_KEY is missing.
 *  - Flow IDs come from flows.json at the repo root, read at runtime.
 *
 * Timeout constraint: an upstream MCP client aborts at ~60s. Default request
 * timeout is 55s (deliberately under 60), configurable via opts.timeoutMs.
 *
 * Secret hygiene: the API key must NEVER appear in any log line, thrown error
 * message, or returned object.
 *
 * Dependency-free: uses global fetch + AbortController. No axios, no SDK.
 *
 * v2 background-job API reference:
 *   https://docs.langflow.org/next/workflow-api
 *   https://docs.langflow.org/api/workflow
 *
 * Resume endpoint reference:
 *   POST /api/v2/workflows/{job_id}/resume
 *   (src/backend/base/langflow/api/v2/workflow.py — DeepWiki documents the
 *    endpoint; the request body carries the human decision payload.)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Inject a mock fetch in tests; defaults to global fetch. */
type FetchLike = typeof globalThis.fetch

/** Options accepted by runFlow. */
export interface RunFlowOptions {
  /** Per-request timeout in ms. Default 55_000 (under the ~60s client budget). */
  timeoutMs?: number
  /** Optional session id for conversation continuity. */
  sessionId?: string
  /** Inject a mock fetch (for tests). */
  fetchImpl?: FetchLike
}

/** Options accepted by startReviewJob / resumeReviewJob. */
export interface ReviewJobOptions {
  /** Per-request timeout in ms. Default 55_000. */
  timeoutMs?: number
  /** Inject a mock fetch (for tests). */
  fetchImpl?: FetchLike
}

/** Human decision passed to resumeReviewJob. */
export interface ReviewDecision {
  /** The action_id of the chosen branch, e.g. "approve" or "reject". */
  action_id: string
  /** Optional free-text reason or input the human supplied. */
  input_value?: string
}

/** Parsed result of a synchronous /v1/run call. */
export interface FlowRunResult {
  /** The raw JSON body from Langflow. */
  raw: unknown
  /** Best-effort extraction of the primary output text. */
  outputText: string | null
  /** Session id echoed by Langflow, if present. */
  sessionId: string | null
}

/** Background job created by POST /api/v2/workflows with mode=background. */
export interface ReviewJobHandle {
  jobId: string
  flowId: string
  status: string
  links?: {
    status?: string
    events?: string
    stop?: string
  }
  raw: unknown
}

/** Result of resuming a suspended job. */
export interface ResumeResult {
  jobId: string
  status: string
  raw: unknown
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the request exceeds its timeout budget.
 *
 * The message deliberately omits the API key and flow id specifics; it tells
 * the operator that demo runs must complete within the client budget and
 * suggests pre-warming.
 */
export class LangflowTimeoutError extends Error {
  readonly timeoutMs: number
  readonly endpoint: string

  constructor(timeoutMs: number, endpoint: string) {
    super(
      `Langflow request to ${endpoint} timed out after ${timeoutMs}ms. ` +
        'Demo runs must complete within the ~60s client budget (IBM Bob MCP client aborts at 60s). ' +
        'Pre-warm the flow with a trivial request before the demo, ' +
        'or increase opts.timeoutMs if the client budget allows.',
    )
    this.name = 'LangflowTimeoutError'
    this.timeoutMs = timeoutMs
    this.endpoint = endpoint
  }
}

/**
 * Thrown when Langflow returns a non-2xx HTTP status.
 * Includes the status code and response body text for diagnostics.
 * Never includes the API key.
 */
export class LangflowHttpError extends Error {
  readonly status: number
  readonly endpoint: string
  readonly bodyText: string

  constructor(status: number, endpoint: string, bodyText: string) {
    const trimmedBody = bodyText.length > 500 ? bodyText.slice(0, 500) + '…[truncated]' : bodyText
    super(`Langflow ${endpoint} returned HTTP ${status}: ${trimmedBody}`)
    this.name = 'LangflowHttpError'
    this.status = status
    this.endpoint = endpoint
    this.bodyText = bodyText
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Default timeout: 55s, deliberately under the ~60s upstream client budget. */
const DEFAULT_TIMEOUT_MS = 55_000

/**
 * Read config from the environment. Throws if the API key is missing.
 * Mirrors the pattern in scripts/discover-flows.ts.
 */
function readConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = (process.env.LANGFLOW_BASE_URL ?? 'http://127.0.0.1:7860').replace(/\/$/, '')
  const apiKey = process.env.LANGFLOW_API_KEY ?? ''
  if (!apiKey) {
    throw new Error('LANGFLOW_API_KEY is required.')
  }
  return { baseUrl, apiKey }
}

/**
 * Internal: perform a fetch with timeout via AbortController, distinguishing
 * transport timeout from HTTP error status.
 *
 * The API key is passed only in the x-api-key header — it never enters log
 * lines, error messages, or return values.
 */
async function doFetch(
  method: string,
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    signal: controller.signal,
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
  }

  let res: Response
  try {
    res = await fetchImpl(url, init)
  } catch (err) {
    // AbortError = our timeout fired.
    if (err instanceof Error && (err.name === 'AbortError' || controller.signal.aborted)) {
      throw new LangflowTimeoutError(timeoutMs, `${method} ${url}`)
    }
    // Other transport errors (DNS, connection refused) — rethrow without key.
    throw err
  } finally {
    clearTimeout(timer)
  }

  return res
}

/**
 * Internal: fetch, check status, and parse JSON.
 * Throws LangflowHttpError on non-2xx, LangflowTimeoutError on timeout.
 */
async function fetchJson<T>(
  method: string,
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<{ status: number; json: T; text: string }> {
  const res = await doFetch(method, url, apiKey, body, timeoutMs, fetchImpl)
  const text = await res.text()

  if (!res.ok) {
    throw new LangflowHttpError(res.status, `${method} ${url}`, text)
  }

  let json: T
  try {
    json = JSON.parse(text) as T
  } catch {
    // Non-JSON 2xx body — return as-is wrapped.
    json = { _rawText: text } as unknown as T
  }

  return { status: res.status, json, text }
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/**
 * Run a flow synchronously via POST /api/v1/run/{flowId}.
 *
 * Sends { input_value } (plus optional session_id) and returns the parsed
 * flow output. The default timeout is 55s to stay under the ~60s upstream
 * client budget.
 *
 * @param flowId   UUID of the flow (from flows.json).
 * @param inputValue  The main input text/prompt.
 * @param opts     Optional timeout, session id, and mock fetch.
 */
export async function runFlow(
  flowId: string,
  inputValue: string,
  opts: RunFlowOptions = {},
): Promise<FlowRunResult> {
  const { baseUrl, apiKey } = readConfig()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch

  const url = `${baseUrl}/api/v1/run/${flowId}`
  const body: Record<string, unknown> = { input_value: inputValue }
  if (opts.sessionId) {
    body.session_id = opts.sessionId
  }

  const { json } = await fetchJson<unknown>(
    'POST',
    url,
    apiKey,
    body,
    timeoutMs,
    fetchImpl,
  )

  // Extract the primary output text from the Langflow v1 run response.
  // Shape: { session_id, outputs: [{ outputs: [{ results: { message: { text } } }] }] }
  let outputText: string | null = null
  let sessionId: string | null = null

  if (typeof json === 'object' && json !== null) {
    const obj = json as Record<string, unknown>
    if (typeof obj.session_id === 'string') {
      sessionId = obj.session_id
    }
    const outputs = obj.outputs
    if (Array.isArray(outputs) && outputs.length > 0) {
      const first = outputs[0] as Record<string, unknown>
      const innerOutputs = first.outputs
      if (Array.isArray(innerOutputs) && innerOutputs.length > 0) {
        const firstInner = innerOutputs[0] as Record<string, unknown>
        const results = firstInner.results as Record<string, unknown> | undefined
        const message = results?.message as Record<string, unknown> | undefined
        if (typeof message?.text === 'string') {
          outputText = message.text
        }
      }
    }
  }

  return { raw: json, outputText, sessionId }
}

/**
 * Start a background review job for the F4 human-approval flow.
 *
 * Uses the Langflow v2 Workflow API: POST /api/v2/workflows with
 * mode=background. The job starts, runs until the Human Input node,
 * then SUSPENDS waiting for a human decision.
 *
 * Request body:
 *   { flow_id, input_value, session_id, mode: "background" }
 *
 * Response (job object):
 *   { job_id, flow_id, object: "job", status: "queued",
 *     links: { status, events, stop }, errors: [], globals: {} }
 *
 * @param flowId     UUID of the F4 flow.
 * @param inputValue  Input text for the review.
 * @param sessionId  Session id for conversation scoping.
 * @param opts       Optional timeout and mock fetch.
 */
export async function startReviewJob(
  flowId: string,
  inputValue: string,
  sessionId: string,
  opts: ReviewJobOptions = {},
): Promise<ReviewJobHandle> {
  const { baseUrl, apiKey } = readConfig()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch

  const url = `${baseUrl}/api/v2/workflows`
  const body = {
    flow_id: flowId,
    input_value: inputValue,
    session_id: sessionId,
    mode: 'background',
  }

  const { json } = await fetchJson<Record<string, unknown>>(
    'POST',
    url,
    apiKey,
    body,
    timeoutMs,
    fetchImpl,
  )

  const jobId = typeof json.job_id === 'string' ? json.job_id : ''
  const flowIdEcho = typeof json.flow_id === 'string' ? json.flow_id : flowId
  const status = typeof json.status === 'string' ? json.status : ''
  const links = json.links as ReviewJobHandle['links'] | undefined

  return {
    jobId,
    flowId: flowIdEcho,
    status,
    links,
    raw: json,
  }
}

/**
 * Resume a suspended background job with a human decision.
 *
 * Uses POST /api/v2/workflows/{job_id}/resume — the HITL resume endpoint
 * documented in Langflow's v2 Workflow API (DeepWiki: src/backend/base/
 * langflow/api/v2/workflow.py). The request body carries the human's
 * decision: the chosen action_id and optional input_value.
 *
 * @param jobId     The job_id from startReviewJob.
 * @param decision  The human's decision (action_id + optional input_value).
 * @param opts      Optional timeout and mock fetch.
 */
export async function resumeReviewJob(
  jobId: string,
  decision: ReviewDecision,
  opts: ReviewJobOptions = {},
): Promise<ResumeResult> {
  const { baseUrl, apiKey } = readConfig()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch

  const url = `${baseUrl}/api/v2/workflows/${jobId}/resume`
  const body: Record<string, unknown> = {
    action_id: decision.action_id,
  }
  if (decision.input_value !== undefined) {
    body.input_value = decision.input_value
  }

  const { json } = await fetchJson<Record<string, unknown>>(
    'POST',
    url,
    apiKey,
    body,
    timeoutMs,
    fetchImpl,
  )

  const status = typeof json.status === 'string' ? json.status : ''

  return {
    jobId,
    status,
    raw: json,
  }
}

// ---------------------------------------------------------------------------
// Flow-ID resolution from flows.json
// ---------------------------------------------------------------------------

/** Canonical flow keys in flows.json. */
export const FLOW_KEYS = [
  'f1_register_discharge_summary',
  'f2_record_patient_checkin',
  'f3_draft_followup_plan',
  'f4_review_care_plan',
  'f5_answer_care_questions',
] as const

export type FlowKey = (typeof FLOW_KEYS)[number]

/**
 * Read flows.json from the given path (default: repo root) and return the
 * mapping. Throws if the file is missing or a key is absent.
 */
export async function loadFlowMap(
  filePath: string = new URL('../../flows.json', import.meta.url).pathname,
): Promise<Record<string, string>> {
  const { readFile } = await import('node:fs/promises')
  const text = await readFile(filePath, 'utf-8')
  const map = JSON.parse(text) as Record<string, string>

  const missing: string[] = []
  for (const key of FLOW_KEYS) {
    if (typeof map[key] !== 'string' || !map[key]) {
      missing.push(key)
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `flows.json is incomplete: missing ${missing.join(', ')}. ` +
        'Run `bun scripts/discover-flows.ts` to regenerate.',
    )
  }

  return map
}
