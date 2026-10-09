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

function baseConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    langflowBaseUrl: 'http://127.0.0.1:59999', // deliberately unreachable
    langflowApiKey: 'test-key',
    reviewDbPath: '/nonexistent/review.sqlite3',
    consoleStateDbPath: '/nonexistent/state.sqlite3',
    host: '127.0.0.1',
    port: 8080,
    readOnly: false,
    ...over,
  }
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

describe('/healthz', () => {
  test('reports langflow unreachable instead of crashing', async () => {
    const app = createApp({ config: baseConfig(), flows: FLOWS })
    const res = await app.handle(new Request('http://localhost/healthz'))
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
    const res = await app.handle(new Request('http://localhost/healthz'))
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
      new Request('http://localhost/api/v1/checkins', {
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
    const res = await app.handle(new Request('http://localhost/api/v1/flows'))
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
      new Request('http://localhost/api/v1/checkins', {
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
      new Request('http://localhost/api/v1/checkins', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input_value: '' }),
      }),
    )
    expect(res.status).toBe(422)
  })
})

describe('plans (read-only view of flow-written state)', () => {
  test('503 when the review DB does not exist yet', async () => {
    const app = createApp({ config: baseConfig(), flows: FLOWS })
    const res = await app.handle(new Request('http://localhost/api/v1/plans'))
    expect(res.status).toBe(503)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('review_db_absent')
  })

  test('lists approved plans from the fixture DB', async () => {
    const fixture = createFixtureDb()
    const app = createApp({ config: baseConfig({ reviewDbPath: fixture.path }), flows: FLOWS })
    const res = await app.handle(new Request('http://localhost/api/v1/plans'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { plans: unknown[]; audit: unknown[] }
    expect(body.plans.length).toBeGreaterThan(0)
    expect(body.audit.length).toBeGreaterThan(0)
    fixture.cleanup()
  })

  test('filters by patient and 404s an unknown one', async () => {
    const fixture = createFixtureDb()
    const app = createApp({ config: baseConfig({ reviewDbPath: fixture.path }), flows: FLOWS })

    const known = await app.handle(new Request('http://localhost/api/v1/plans/chf-high'))
    expect(known.status).toBe(200)

    const unknown = await app.handle(new Request('http://localhost/api/v1/plans/nobody'))
    expect(unknown.status).toBe(404)
    fixture.cleanup()
  })
})