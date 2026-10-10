/**
 * App-level tests. No live Langflow required: the flow runner is injected.
 */
import { describe, expect, test } from 'bun:test'
import { createApp } from '../src/app.ts'
import type { AppConfig } from '../src/config.ts'
import { createFixtureDb } from './fixture-db.ts'

const FLOWS = {
  f1_register_discharge_summary: '11111111-1111-1111-1111-111111111111',
  f2_record_patient_checkin: '22222222-2222-2222-2222-222222222222',
}

const TEST_TOKEN = 'test-token-abc123'

function baseConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    langflowBaseUrl: 'http://127.0.0.1:59999', // deliberately unreachable
    langflowApiKey: 'test-key',
    reviewDbPath: '/nonexistent/review.sqlite3',
    consoleStateDbPath: '/nonexistent/state.sqlite3',
    host: '127.0.0.1',
    port: 8080,
    readOnly: false,
    apiKey: TEST_TOKEN,
    ...over,
  }
}

/**
 * Every /api route requires the bearer token, so tests that exercise
 * non-auth behaviour must still present a valid one. Centralising this keeps
 * the auth suite the only place that deliberately omits the header.
 */
function authed(pathname: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  })
}

describe('config validation', () => {
  test('missing API key fails fast with a message that omits any value', async () => {
    const prev = process.env.LANGFLOW_API_KEY
    delete process.env.LANGFLOW_API_KEY
    const { loadConfig } = await import('../src/config.ts')
    expect(() => loadConfig()).toThrow(/LANGFLOW_API_KEY is not set/)
    if (prev !== undefined) process.env.LANGFLOW_API_KEY = prev
  })
})

describe('/api/health', () => {
  test('reports langflow unreachable instead of crashing', async () => {
    const app = createApp({ config: baseConfig(), flows: FLOWS })
    const res = await app.handle(authed('/api/health'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.status).toBe('ok')
    expect(body.langflow).toBe('unreachable')
    expect(body.flowCount).toBe(2)
    expect(String(body.disclaimer)).toContain('Not clinically validated')
  })

  test('flags an incomplete manifest rather than reporting ready', async () => {
    const app = createApp({
      config: baseConfig(),
      flows: { f1_register_discharge_summary: 'not-a-uuid' },
    })
    const res = await app.handle(authed('/api/health'))
    const body = (await res.json()) as Record<string, unknown>
    expect(body.manifestComplete).toBe(false)
    expect(body.missingFlows).toEqual(['f1_register_discharge_summary'])
  })
})

describe('read-only mode', () => {
  test('blocks mutating routes with 403', async () => {
    const app = createApp({
      config: baseConfig({ readOnly: true }),
      flows: FLOWS,
      runFlowImpl: async () => ({ raw: 'nope' }) as never,
    })
    const res = await app.handle(
      authed('/api/v1/checkins', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input_value: 'merasa lebih baik' }),
      }),
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('read_only_mode')
  })

  test('read routes still work while writes are blocked', async () => {
    const app = createApp({ config: baseConfig({ readOnly: true }), flows: FLOWS })
    const res = await app.handle(authed('/api/v1/flows'))
    expect(res.status).toBe(200)
  })
})

describe('flow proxy', () => {
  test('returns the flow output verbatim without re-scoring', async () => {
    // A red-flag escalation exactly as F2 emits it. The console must not
    // soften it, add a tier, or reword it.
    const flowOutput = {
      raw: { action: 'escalate_immediately', patient_id: 'chf-high' },
      outputText: null,
      sessionId: 's1',
    }
    const calls: { flowId: string; input: string }[] = []
    const app = createApp({
      config: baseConfig(),
      flows: FLOWS,
      runFlowImpl: (async (flowId: string, input: string) => {
        calls.push({ flowId, input })
        return flowOutput
      }) as never,
    })

    const res = await app.handle(
      authed('/api/v1/checkins', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input_value: 'nyeri dada' }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { raw: { action: string; patient_id: string } }
    expect(body.raw.action).toBe('escalate_immediately')
    expect(body.raw.patient_id).toBe('chf-high')
    // The console must not invent a tier the flow did not emit.
    expect(Object.keys(body.raw).sort()).toEqual(['action', 'patient_id'])
    expect(calls).toEqual([
      { flowId: FLOWS.f2_record_patient_checkin, input: 'nyeri dada' },
    ])
  })

  test('rejects an empty body with 422', async () => {
    const app = createApp({ config: baseConfig(), flows: FLOWS })
    const res = await app.handle(
      authed('/api/v1/checkins', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input_value: '' }),
      }),
    )
    expect(res.status).toBe(422)
  })
})

describe('Langflow unavailable', () => {
  /**
   * Langflow is the clinical engine. When it is down the request cannot be
   * served, and the frontend must be able to tell "the engine is down, retry"
   * apart from "your input was wrong". This shipped as an opaque 500 before
   * LangflowUnreachableError existed, because fetch rejects with a bare
   * TypeError that matched no branch in the error handler.
   */
  const refused = () => {
    // Exactly what Bun's fetch throws on connection refused.
    const err = new TypeError('fetch failed')
    return (async () => {
      throw err
    }) as never
  }

  test('runFlow wraps a transport failure into LangflowUnreachableError', async () => {
    // Tested at the CLIENT layer, not by injecting a throwing runFlowImpl: the
    // wrapping happens inside doFetch, so stubbing the caller would bypass the
    // very code path that is being fixed.
    const { LangflowUnreachableError, runFlow: realRunFlow } = await import('../src/plugins/langflow.ts')
    const prevKey = process.env.LANGFLOW_API_KEY
    const prevBase = process.env.LANGFLOW_BASE_URL
    process.env.LANGFLOW_API_KEY = 'test-key'
    // Port 1 is reserved and never listening -> connection refused.
    process.env.LANGFLOW_BASE_URL = 'http://127.0.0.1:1'
    try {
      let thrown: unknown
      try {
        await realRunFlow('11111111-1111-1111-1111-111111111111', 'x', {
          fetchImpl: (() => Promise.reject(new TypeError('fetch failed'))) as never,
        })
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(LangflowUnreachableError)
      expect((thrown as Error).message).toContain('docker compose up -d langflow')
    } finally {
      if (prevKey === undefined) delete process.env.LANGFLOW_API_KEY
      else process.env.LANGFLOW_API_KEY = prevKey
      if (prevBase === undefined) delete process.env.LANGFLOW_BASE_URL
      else process.env.LANGFLOW_BASE_URL = prevBase
    }
  })

  test('the error handler maps it to 503 langflow_unreachable', async () => {
    // The handler only discriminates on the typed error, so inject exactly that
    // -- reproducing the post-doFetch state rather than a bare TypeError.
    const { LangflowUnreachableError } = await import('../src/plugins/langflow.ts')
    const app = createApp({
      config: baseConfig(),
      flows: FLOWS,
      runFlowImpl: (async () => {
        throw new LangflowUnreachableError('POST http://127.0.0.1:7860/api/v1/run/x', new TypeError('fetch failed'))
      }) as never,
    })
    const res = await app.handle(
      authed('/api/v1/checkins', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input_value: 'merasa lebih baik' }),
      }),
    )
    expect(res.status).toBe(503)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('langflow_unreachable')
    // The message must tell the operator how to fix it.
    expect(String(body.message)).toContain('docker compose up -d langflow')
  })

  test('the 503 body never leaks the Langflow API key', async () => {
    const { LangflowUnreachableError } = await import('../src/plugins/langflow.ts')
    const app = createApp({
      config: baseConfig({ langflowApiKey: 'super-secret-langflow-key' }),
      flows: FLOWS,
      runFlowImpl: (async () => {
        throw new LangflowUnreachableError('POST http://127.0.0.1:7860/run', new TypeError('fetch failed'))
      }) as never,
    })
    const res = await app.handle(
      authed('/api/v1/checkins', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input_value: 'x' }),
      }),
    )
    expect(res.status).toBe(503)
    expect(await res.text()).not.toContain('super-secret-langflow-key')
  })

  test('reads still work while Langflow is down (they never touch it)', async () => {
    const fixture = createFixtureDb()
    const app = createApp({
      config: baseConfig({ reviewDbPath: fixture.path, langflowBaseUrl: 'http://127.0.0.1:59999' }),
      flows: FLOWS,
      runFlowImpl: refused(),
    })
    // /api/health still answers, and honestly reports the engine as down.
    const health = await app.handle(authed('/api/health'))
    expect(health.status).toBe(200)
    const hb = (await health.json()) as { langflow: string }
    expect(hb.langflow).toBe('unreachable')

    // Plan reads are pure SQLite, so they keep working.
    const plans = await app.handle(authed('/api/v1/plans'))
    expect(plans.status).toBe(200)
    expect(((await plans.json()) as { plans: unknown[] }).plans.length).toBeGreaterThan(0)

    const flows = await app.handle(authed('/api/v1/flows'))
    expect(flows.status).toBe(200)
    fixture.cleanup()
  })
})

describe('plans (read-only view of flow-written state)', () => {
  test('503 when the review DB does not exist yet', async () => {
    const app = createApp({ config: baseConfig(), flows: FLOWS })
    const res = await app.handle(authed('/api/v1/plans'))
    expect(res.status).toBe(503)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('review_db_absent')
  })

  test('lists approved plans from the fixture DB', async () => {
    const fixture = createFixtureDb()
    const app = createApp({ config: baseConfig({ reviewDbPath: fixture.path }), flows: FLOWS })
    const res = await app.handle(authed('/api/v1/plans'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { plans: unknown[]; audit: unknown[] }
    expect(body.plans.length).toBeGreaterThan(0)
    expect(body.audit.length).toBeGreaterThan(0)
    fixture.cleanup()
  })

  test('filters by patient and 404s an unknown one', async () => {
    const fixture = createFixtureDb()
    const app = createApp({ config: baseConfig({ reviewDbPath: fixture.path }), flows: FLOWS })

    const known = await app.handle(authed('/api/v1/plans/chf-high'))
    expect(known.status).toBe(200)

    const unknown = await app.handle(authed('/api/v1/plans/nobody'))
    expect(unknown.status).toBe(404)
    fixture.cleanup()
  })
})

describe('bearer authentication', () => {
  /**
   * The clinical routes that matter most. `/api/v1/reviews` plus its /resume
   * endpoint IS the human-approval gate: if those are reachable without a
   * token, the entire human-in-the-loop safety property is void. They are
   * listed here explicitly so a regression names the actual hole.
   */
  const PROTECTED = [
    { method: 'GET', path: '/api/v1/plans' },
    { method: 'GET', path: '/api/v1/plans/chf-high' },
    { method: 'GET', path: '/api/v1/flows' },
    { method: 'POST', path: '/api/v1/discharge', body: { input_value: 'x' } },
    { method: 'POST', path: '/api/v1/checkins', body: { input_value: 'x' } },
    { method: 'POST', path: '/api/v1/reviews', body: { draft: 'x' } },
    { method: 'POST', path: '/api/v1/reviews/job-1/resume', body: { request_id: 'r', action_id: 'approve', actor: 'a' } },
    { method: 'POST', path: '/api/v1/answers', body: { patient_id: 'p', query: 'q' } },
  ]

  test('every /api route rejects a request with no Authorization header', async () => {
    const app = createApp({
      config: baseConfig(),
      flows: FLOWS,
      runFlowImpl: async () => ({ raw: 'leak' }) as never,
      startReviewJobImpl: async () => ({ jobId: 'leak' }) as never,
    })
    for (const r of PROTECTED) {
      const res = await app.handle(
        new Request(`http://localhost${r.path}`, {
          method: r.method,
          headers: { 'content-type': 'application/json' },
          body: r.body ? JSON.stringify(r.body) : undefined,
        }),
      )
      expect(`${r.method} ${r.path} -> ${res.status}`).toBe(`${r.method} ${r.path} -> 401`)
    }
  })

  test('a wrong token is rejected on the approval gate itself', async () => {
    let called = false
    const app = createApp({
      config: baseConfig(),
      flows: FLOWS,
      startReviewJobImpl: async () => {
        called = true
        return { jobId: 'should-not-happen' } as never
      },
    })
    const res = await app.handle(
      new Request('http://localhost/api/v1/reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token' },
        body: JSON.stringify({ draft: 'x' }),
      }),
    )
    expect(res.status).toBe(401)
    // The critical assertion: the gate's implementation was never invoked.
    expect(called).toBe(false)
  })

  test('malformed Authorization headers are rejected without a 500', async () => {
    const app = createApp({ config: baseConfig(), flows: FLOWS })
    for (const header of ['', 'Bearer', 'Bearer ', 'Basic dXNlcjpwYXNz', TEST_TOKEN, 'Bearer  ']) {
      const res = await app.handle(
        new Request('http://localhost/api/v1/plans', { headers: { authorization: header } }),
      )
      expect(res.status).toBe(401)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.error).toBe('unauthorized')
    }
  })

  test('a 401 carries a WWW-Authenticate challenge', async () => {
    const app = createApp({ config: baseConfig(), flows: FLOWS })
    const res = await app.handle(new Request('http://localhost/api/v1/plans'))
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Bearer')
  })

  test('the correct token is accepted', async () => {
    const app = createApp({ config: baseConfig(), flows: FLOWS })
    const res = await app.handle(authed('/api/v1/flows'))
    expect(res.status).toBe(200)
  })

  test('a near-miss token is rejected (no prefix match)', async () => {
    const app = createApp({ config: baseConfig(), flows: FLOWS })
    for (const bad of [`Bearer ${TEST_TOKEN}x`, `Bearer ${TEST_TOKEN.slice(0, -1)}`, `BearerX${TEST_TOKEN}`]) {
      const res = await app.handle(
        new Request('http://localhost/api/v1/flows', { headers: { authorization: bad } }),
      )
      expect(res.status).toBe(401)
    }
  })

  test('the token scheme is case-insensitive per RFC 7235', async () => {
    const app = createApp({ config: baseConfig(), flows: FLOWS })
    const res = await app.handle(
      new Request('http://localhost/api/v1/flows', {
        headers: { authorization: `bearer ${TEST_TOKEN}` },
      }),
    )
    expect(res.status).toBe(200)
  })

  test('FAIL CLOSED: no configured token locks the API instead of opening it', async () => {
    const app = createApp({ config: baseConfig({ apiKey: '' }), flows: FLOWS })
    const res = await app.handle(authed('/api/v1/plans'))
    expect(res.status).toBe(503)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('auth_not_configured')
  })

  test('an unauthenticated caller cannot enumerate routes via 404 vs 401', async () => {
    const app = createApp({ config: baseConfig(), flows: FLOWS })
    // A route that does not exist must still answer 401, not 404. If it 404ed,
    // an anonymous caller could map the API surface for free.
    const res = await app.handle(new Request('http://localhost/api/v1/nonexistent'))
    expect(res.status).toBe(401)
  })

  test('/api/health is itself gated (this server exposes only the API)', async () => {
    const app = createApp({ config: baseConfig(), flows: FLOWS })
    expect((await app.handle(new Request('http://localhost/api/health'))).status).toBe(401)
    expect((await app.handle(authed('/api/health'))).status).toBe(200)
  })

  test('/ returns a plain 404 and no HTML (the frontend is a separate app)', async () => {
    const app = createApp({ config: baseConfig(), flows: FLOWS })
    for (const p of ['/', '/index.html', '/app', '/login']) {
      const res = await app.handle(new Request(`http://localhost${p}`))
      expect(`${p} -> ${res.status}`).toBe(`${p} -> 404`)
      // Nothing HTML may be served from this repo at all.
      expect(res.headers.get('content-type') ?? '').not.toContain('text/html')
    }
  })

  test('no error response ever echoes the expected token back', async () => {
    const app = createApp({ config: baseConfig(), flows: FLOWS })
    const res = await app.handle(
      new Request('http://localhost/api/v1/plans', {
        headers: { authorization: 'Bearer definitely-not-the-key' },
      }),
    )
    const text = await res.text()
    expect(text).not.toContain(TEST_TOKEN)
    expect(text).not.toContain('definitely-not-the-key')
  })

  /**
   * SYNCare-fe INTEGRATION NOTE: native `EventSource` cannot set an
   * Authorization header, so the browser MUST consume this SSE route with
   * `fetch()` + `ReadableStream` instead. That is deliberate: passing the token
   * as a query parameter would work, but query strings land in access logs,
   * proxy logs, and browser history. Fetch lets the header stay in the header.
   */
  test('the SSE event route requires the token too', async () => {
    const app = createApp({
      config: baseConfig(),
      flows: FLOWS,
      streamReviewEventsImpl: async () =>
        new Response('event: end\ndata: {}\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    } as never)

    const anon = await app.handle(
      new Request('http://localhost/api/v1/reviews/job-1/events'),
    )
    expect(anon.status).toBe(401)

    const ok = await app.handle(authed('/api/v1/reviews/job-1/events'))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toContain('text/event-stream')
  })
})