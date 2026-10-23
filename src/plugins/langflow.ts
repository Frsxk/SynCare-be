/** Langflow client: sync /v1/run plus v2 background jobs for F4 human review. */
/** The API key is sent only in x-api-key; it never appears in logs, errors, or results. */

/** Inject a mock fetch in tests; defaults to global fetch. */
type FetchLike = typeof globalThis.fetch

export interface RunFlowOptions {
  /** Per-request timeout in ms. Default 55_000 (under the ~60s client budget). */
  timeoutMs?: number
  /** Optional session id for conversation continuity. */
  sessionId?: string
  /** Inject a mock fetch (for tests). */
  fetchImpl?: FetchLike
}

export interface ReviewJobOptions {
  /** Per-request timeout in ms. Default 55_000. */
  timeoutMs?: number
  /** Inject a mock fetch (for tests). */
  fetchImpl?: FetchLike
}

export interface ReviewDecision {
  /** The action_id of the chosen branch, e.g. "approve" or "reject". */
  action_id: string
  /** Optional free-text reason or input the human supplied. */
  input_value?: string
  /** Human Input request_id from the pause event; 1.12.3 leaves the job suspended without it. */
  request_id?: string
  /** Who approved. Recorded in audit_log.actor by F4. */
  actor?: string
  /** Free-text rationale stored alongside the approval. */
  reviewer_note?: string
}

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

export interface ResumeResult {
  jobId: string
  status: string
  raw: unknown
}

/** Request exceeded its timeout budget. */
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

/** Non-2xx response; the message carries the status and a truncated body. */
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

/** Langflow could not be reached at all: container stopped, wrong port, DNS, refused. */
/** Maps to 503 so engine failure stays distinct from bad input. */
export class LangflowUnreachableError extends Error {
  readonly endpoint: string
  /** Underlying transport error; named reason to avoid shadowing Error.cause. */
  readonly reason: unknown

  constructor(endpoint: string, reason: unknown) {
    super(
      `Langflow is unreachable at ${endpoint}. It is the clinical engine and must be ` +
        `running for F1-F5. Start it with: docker compose up -d langflow`,
    )
    this.name = 'LangflowUnreachableError'
    this.endpoint = endpoint
    this.reason = reason
  }
}

/** Default timeout: 55s, deliberately under the ~60s upstream client budget. */
const DEFAULT_TIMEOUT_MS = 55_000

/** Read base URL and API key from the environment; throws if the key is missing. */
function readConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = (process.env.LANGFLOW_BASE_URL ?? 'http://127.0.0.1:7860').replace(/\/$/, '')
  const apiKey = process.env.LANGFLOW_API_KEY ?? ''
  if (!apiKey) {
    throw new Error('LANGFLOW_API_KEY is required.')
  }
  return { baseUrl, apiKey }
}

/** Fetch with an AbortController timeout; wraps timeouts and transport failures into typed errors. */
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
    // DNS, refused, container stopped: wrap the bare TypeError so it maps to 503
    // instead of surfacing as an opaque 500.
    throw new LangflowUnreachableError(`${method} ${url}`, err)
  } finally {
    clearTimeout(timer)
  }

  return res
}

/** Fetch, check status, and parse JSON; non-2xx becomes LangflowHttpError. */
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
    // Non-JSON 2xx body: wrap the raw text.
    json = { _rawText: text } as unknown as T
  }

  return { status: res.status, json, text }
}

/** Run a flow synchronously via POST /api/v1/run/{flowId}; default timeout 55s. */
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

/** Start F4 as a v2 background job; it suspends at the human-input gate. */
/** Body: { flow_id, input_value, session_id, mode: "background" }. */
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

/** Proxy the job SSE feed; null on failure so the route can return 502. */
export async function streamReviewEvents(
  jobId: string,
  opts: { timeoutMs?: number } = {},
): Promise<Response | null> {
  const { baseUrl, apiKey } = readConfig()
  const controller = new AbortController()
  // The stream is long-lived; the caller closes it when the job settles.
  const timeoutMs = opts.timeoutMs ?? 120_000
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(`${baseUrl}/api/v2/workflows/${encodeURIComponent(jobId)}/events`, {
      headers: { 'x-api-key': apiKey, Accept: 'text/event-stream' },
      signal: controller.signal,
    })
    if (!res.ok || !res.body) {
      clearTimeout(timer)
      return null
    }
    return new Response(res.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    })
  } catch {
    clearTimeout(timer)
    return null
  }
}

/** Resume a suspended job with a human decision; request_id is required by 1.12.3. */
/** The decision is nested under "decision"; request_id stays top-level. */
export async function resumeReviewJob(
  jobId: string,
  decision: ReviewDecision,
  opts: ReviewJobOptions = {},
): Promise<ResumeResult> {
  const { baseUrl, apiKey } = readConfig()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch

  const url = `${baseUrl}/api/v2/workflows/${jobId}/resume`
  // 1.12.3 expects the decision nested under "decision", with request_id top-level.
  const body: Record<string, unknown> = {
    decision: {
      action_id: decision.action_id,
      actor: decision.actor,
      reviewer_note: decision.reviewer_note,
    },
  }
  if (decision.request_id !== undefined) {
    body.request_id = decision.request_id
  }
  if (decision.input_value !== undefined) {
    ;(body.decision as Record<string, unknown>).input_value = decision.input_value
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

/** Canonical flow keys in flows.json. */
export const FLOW_KEYS = [
  'f1_register_discharge_summary',
  'f2_record_patient_checkin',
  'f3_draft_followup_plan',
  'f4_review_care_plan',
  'f5_answer_care_questions',
] as const

export type FlowKey = (typeof FLOW_KEYS)[number]

/** Read and validate flows.json; throws when a canonical key is missing. */
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
