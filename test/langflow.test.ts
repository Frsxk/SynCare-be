/**
 * Tests for src/plugins/langflow.ts
 *
 * These tests do NOT require a live Langflow. They use dependency injection
 * (a mock fetch passed via opts.fetchImpl) to verify:
 *  - success path (runFlow, startReviewJob, resumeReviewJob)
 *  - non-2xx → LangflowHttpError containing the status
 *  - timeout → LangflowTimeoutError with the guidance message
 *  - secret redaction: the API key never appears in console output or error messages
 */
import { describe, test, expect, beforeAll, afterAll, spyOn } from 'bun:test'
import {
  runFlow,
  startReviewJob,
  resumeReviewJob,
  LangflowTimeoutError,
  LangflowHttpError,
} from '../src/plugins/langflow'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A fake API key used across tests. We assert it never leaks. */
const TEST_API_KEY = 'sk-test-secret-key-DO-NOT-LEAK-1234567890'

/** A fake flow id. */
const TEST_FLOW_ID = 'dd096aae-e02c-4a36-b3c3-ec8c741b0e66'

/** A fake job id. */
const TEST_JOB_ID = 'a98d9753-9259-47ca-9783-69a9d8d26889'

/** Build a mock Response object. */
function mockResponse(body: unknown, init: { status?: number; statusText?: string } = {}): Response {
  const status = init.status ?? 200
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return new Response(text, {
    status,
    statusText: init.statusText ?? (status === 200 ? 'OK' : 'Error'),
    headers: { 'Content-Type': 'application/json' },
  })
}

/** A fetch stub that records calls and returns a queue of responses. */
function makeMockFetch(responses: Response[]): {
  fetch: typeof globalThis.fetch
  calls: { url: string; init: RequestInit }[]
} {
  const calls: { url: string; init: RequestInit }[] = []
  let idx = 0
  const fetch = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: url.toString(), init: init ?? {} })
    const res = responses[idx] ?? responses[responses.length - 1]
    idx++
    return Promise.resolve(res)
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

/** A fetch stub that never resolves normally but rejects on abort (for timeout tests). */
function makeHangingFetch(): typeof globalThis.fetch {
  const fn = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    return new Promise<Response>((_, reject) => {
      const signal = init?.signal
      if (signal) {
        if (signal.aborted) {
          const err = new DOMException('The operation was aborted.', 'AbortError')
          reject(err)
          return
        }
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        }, { once: true })
      }
      // Never resolves otherwise
    })
  }
  return fn as unknown as typeof globalThis.fetch
}

// ---------------------------------------------------------------------------
// Setup / teardown: set env vars
// ---------------------------------------------------------------------------

beforeAll(() => {
  process.env.LANGFLOW_BASE_URL = 'http://127.0.0.1:7860'
  process.env.LANGFLOW_API_KEY = TEST_API_KEY
})

afterAll(() => {
  delete process.env.LANGFLOW_BASE_URL
  delete process.env.LANGFLOW_API_KEY
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runFlow', () => {
  test('success path: returns parsed output text and session id', async () => {
    const langflowResponse = {
      session_id: 'chat-123',
      outputs: [
        {
          inputs: { input_value: 'hello' },
          outputs: [
            {
              results: {
                message: {
                  text: 'Sure! Here is your answer.',
                  sender: 'Machine',
                  sender_name: 'AI',
                  session_id: 'chat-123',
                },
              },
            },
          ],
        },
      ],
    }
    const { fetch, calls } = makeMockFetch([mockResponse(langflowResponse)])

    const result = await runFlow(TEST_FLOW_ID, 'hello', {
      fetchImpl: fetch,
      sessionId: 'chat-123',
    })

    expect(result.outputText).toBe('Sure! Here is your answer.')
    expect(result.sessionId).toBe('chat-123')

    // Verify the request shape
    expect(calls.length).toBe(1)
    const call = calls[0]!
    expect(call.url).toBe('http://127.0.0.1:7860/api/v1/run/' + TEST_FLOW_ID)
    expect(call.init.method).toBe('POST')
    const body = JSON.parse(call.init.body as string)
    expect(body.input_value).toBe('hello')
    expect(body.session_id).toBe('chat-123')
    // API key in header, not body
    const headers = call.init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe(TEST_API_KEY)
    expect(body).not.toHaveProperty('x-api-key')
  })

  test('non-2xx → throws LangflowHttpError with status and body', async () => {
    const { fetch } = makeMockFetch([
      mockResponse({ detail: 'Flow not found' }, { status: 404 }),
    ])

    try {
      await runFlow(TEST_FLOW_ID, 'hello', { fetchImpl: fetch })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(LangflowHttpError)
      const httpErr = err as LangflowHttpError
      expect(httpErr.status).toBe(404)
      expect(httpErr.message).toContain('404')
      expect(httpErr.message).toContain('Flow not found')
    }
  })

  test('timeout → throws LangflowTimeoutError with guidance message', async () => {
    const hangingFetch = makeHangingFetch()

    try {
      await runFlow(TEST_FLOW_ID, 'hello', {
        fetchImpl: hangingFetch,
        timeoutMs: 50,
      })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(LangflowTimeoutError)
      const timeoutErr = err as LangflowTimeoutError
      expect(timeoutErr.timeoutMs).toBe(50)
      // Guidance message must mention the client budget and pre-warming
      expect(timeoutErr.message.toLowerCase()).toContain('60s')
      expect(timeoutErr.message.toLowerCase()).toContain('pre-warm')
      // Must NOT contain the API key
      expect(timeoutErr.message).not.toContain(TEST_API_KEY)
    }
  })
})

describe('startReviewJob', () => {
  test('success path: returns job handle with jobId', async () => {
    const langflowResponse = {
      job_id: TEST_JOB_ID,
      flow_id: TEST_FLOW_ID,
      object: 'job',
      created_timestamp: '2026-06-30T16:00:56.917538+00:00',
      status: 'queued',
      links: {
        status: `/api/v2/workflows?job_id=${TEST_JOB_ID}`,
        events: `/api/v2/workflows/${TEST_JOB_ID}/events`,
        stop: '/api/v2/workflows/stop',
      },
      errors: [],
      globals: {},
    }
    const { fetch, calls } = makeMockFetch([mockResponse(langflowResponse)])

    const result = await startReviewJob(TEST_FLOW_ID, 'review this', 'session-456', {
      fetchImpl: fetch,
    })

    expect(result.jobId).toBe(TEST_JOB_ID)
    expect(result.flowId).toBe(TEST_FLOW_ID)
    expect(result.status).toBe('queued')
    expect(result.links?.events).toContain(TEST_JOB_ID)

    // Verify request shape — v2 workflows endpoint with mode=background
    expect(calls.length).toBe(1)
    const call = calls[0]!
    expect(call.url).toBe('http://127.0.0.1:7860/api/v2/workflows')
    expect(call.init.method).toBe('POST')
    const body = JSON.parse(call.init.body as string)
    expect(body.flow_id).toBe(TEST_FLOW_ID)
    expect(body.input_value).toBe('review this')
    expect(body.session_id).toBe('session-456')
    expect(body.mode).toBe('background')
  })

  test('non-2xx → throws LangflowHttpError with status', async () => {
    const { fetch } = makeMockFetch([
      mockResponse({ detail: 'Flow not found' }, { status: 404 }),
    ])

    try {
      await startReviewJob(TEST_FLOW_ID, 'review', 'sess', { fetchImpl: fetch })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(LangflowHttpError)
      expect((err as LangflowHttpError).status).toBe(404)
    }
  })

  test('timeout → throws LangflowTimeoutError', async () => {
    const hangingFetch = makeHangingFetch()

    try {
      await startReviewJob(TEST_FLOW_ID, 'review', 'sess', {
        fetchImpl: hangingFetch,
        timeoutMs: 50,
      })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(LangflowTimeoutError)
    }
  })
})

describe('resumeReviewJob', () => {
  test('success path: sends action_id and returns status', async () => {
    const langflowResponse = {
      job_id: TEST_JOB_ID,
      status: 'in_progress',
      object: 'job',
    }
    const { fetch, calls } = makeMockFetch([mockResponse(langflowResponse)])

    const result = await resumeReviewJob(
      TEST_JOB_ID,
      { action_id: 'approve', input_value: 'Looks good', request_id: 'HumanInput-test:job' },
      { fetchImpl: fetch },
    )

    expect(result.jobId).toBe(TEST_JOB_ID)
    expect(result.status).toBe('in_progress')

    // Verify request shape — POST /api/v2/workflows/{jobId}/resume
    expect(calls.length).toBe(1)
    const call = calls[0]!
    expect(call.url).toBe(`http://127.0.0.1:7860/api/v2/workflows/${TEST_JOB_ID}/resume`)
    expect(call.init.method).toBe('POST')
    const body = JSON.parse(call.init.body as string)
    // Verified against Langflow 1.12.3: the decision is NESTED and the Human
    // Input request_id sits at the top level.
    expect(body.decision.action_id).toBe('approve')
    expect(body.decision.input_value).toBe('Looks good')
    expect(body.request_id).toBe('HumanInput-test:job')
  })

  test('non-2xx → throws LangflowHttpError', async () => {
    const { fetch } = makeMockFetch([
      mockResponse({ detail: 'Job not found' }, { status: 404 }),
    ])

    try {
      await resumeReviewJob(TEST_JOB_ID, { action_id: 'reject' }, { fetchImpl: fetch })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(LangflowHttpError)
      expect((err as LangflowHttpError).status).toBe(404)
    }
  })

  test('timeout → throws LangflowTimeoutError', async () => {
    const hangingFetch = makeHangingFetch()

    try {
      await resumeReviewJob(TEST_JOB_ID, { action_id: 'approve' }, {
        fetchImpl: hangingFetch,
        timeoutMs: 50,
      })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(LangflowTimeoutError)
    }
  })
})

describe('secret hygiene — API key never leaks', () => {
  test('API key absent from console output during success path', async () => {
    const langflowResponse = {
      session_id: 'chat-123',
      outputs: [
        {
          outputs: [
            { results: { message: { text: 'ok' } } },
          ],
        },
      ],
    }
    const { fetch } = makeMockFetch([mockResponse(langflowResponse)])

    // Capture console output
    const logSpy = spyOn(console, 'log')
    const errSpy = spyOn(console, 'error')
    const warnSpy = spyOn(console, 'warn')

    await runFlow(TEST_FLOW_ID, 'hello', { fetchImpl: fetch })

    // Assert the key string is absent from every console call
    for (const [args] of logSpy.mock.calls) {
      expect(String(args)).not.toContain(TEST_API_KEY)
    }
    for (const [args] of errSpy.mock.calls) {
      expect(String(args)).not.toContain(TEST_API_KEY)
    }
    for (const [args] of warnSpy.mock.calls) {
      expect(String(args)).not.toContain(TEST_API_KEY)
    }

    logSpy.mockRestore()
    errSpy.mockRestore()
    warnSpy.mockRestore()
  })

  test('API key absent from thrown error messages on HTTP error', async () => {
    // The response body is server content; use a realistic detail without the key.
    const responseBody = { detail: 'Unauthorized: invalid or expired API key' }
    const { fetch } = makeMockFetch([mockResponse(responseBody, { status: 403 })])

    try {
      await runFlow(TEST_FLOW_ID, 'hello', { fetchImpl: fetch })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(LangflowHttpError)
      const msg = (err as Error).message
      expect(msg).toContain('403')
      // The key from the x-api-key header must not appear in the error message
      expect(msg).not.toContain(TEST_API_KEY)
      // The key must not appear anywhere in the serialized error object
      expect(JSON.stringify(err)).not.toContain(TEST_API_KEY)
    }
  })

  test('API key absent from thrown error message on timeout', async () => {
    const hangingFetch = makeHangingFetch()

    try {
      await runFlow(TEST_FLOW_ID, 'hello', {
        fetchImpl: hangingFetch,
        timeoutMs: 30,
      })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(LangflowTimeoutError)
      const msg = (err as Error).message
      expect(msg).not.toContain(TEST_API_KEY)
      expect(JSON.stringify(err)).not.toContain(TEST_API_KEY)
    }
  })

  test('API key absent from returned objects', async () => {
    const langflowResponse = {
      session_id: 'chat-123',
      outputs: [
        {
          outputs: [
            { results: { message: { text: 'ok' } } },
          ],
        },
      ],
    }
    const { fetch } = makeMockFetch([mockResponse(langflowResponse)])

    const result = await runFlow(TEST_FLOW_ID, 'hello', { fetchImpl: fetch })

    // The returned object must not contain the API key anywhere
    expect(JSON.stringify(result)).not.toContain(TEST_API_KEY)
  })

  test('API key absent from startReviewJob returned object', async () => {
    const langflowResponse = {
      job_id: TEST_JOB_ID,
      flow_id: TEST_FLOW_ID,
      object: 'job',
      status: 'queued',
      links: {},
      errors: [],
      globals: {},
    }
    const { fetch } = makeMockFetch([mockResponse(langflowResponse)])

    const result = await startReviewJob(TEST_FLOW_ID, 'review', 'sess', {
      fetchImpl: fetch,
    })

    expect(JSON.stringify(result)).not.toContain(TEST_API_KEY)
  })

  test('API key absent from resumeReviewJob returned object', async () => {
    const langflowResponse = {
      job_id: TEST_JOB_ID,
      status: 'in_progress',
    }
    const { fetch } = makeMockFetch([mockResponse(langflowResponse)])

    const result = await resumeReviewJob(
      TEST_JOB_ID,
      { action_id: 'approve' },
      { fetchImpl: fetch },
    )

    expect(JSON.stringify(result)).not.toContain(TEST_API_KEY)
  })
})

describe('missing API key', () => {
  test('throws when LANGFLOW_API_KEY is not set', async () => {
    const savedKey = process.env.LANGFLOW_API_KEY
    delete process.env.LANGFLOW_API_KEY

    try {
      await runFlow(TEST_FLOW_ID, 'hello')
      throw new Error('should have thrown')
    } catch (err) {
      expect((err as Error).message).toContain('LANGFLOW_API_KEY')
      // The error must not contain any actual key value
      expect((err as Error).message).not.toContain(TEST_API_KEY)
    }

    process.env.LANGFLOW_API_KEY = savedKey
  })
})
