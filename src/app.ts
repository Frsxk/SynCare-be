/**
 * SynCare console — Elysia application.
 *
 * ARCHITECTURAL RULE: Langflow owns ALL clinical logic (risk scoring, tiering,
 * red-flag escalation, plan drafting, human approval, retrieval). This app is a
 * THIN PROXY: it reads flow-written state and forwards requests. It must never
 * compute, infer, or adjust a clinical decision of its own.
 *
 * No `.listen()` here — tests drive the app with `app.handle(new Request(...))`.
 */
import { Elysia, t } from 'elysia'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DISCLAIMER, type AppConfig, loadConfig } from './config.ts'
import { ReviewDbReader } from './plugins/review-db.ts'
import { LangflowHttpError, LangflowTimeoutError, runFlow } from './plugins/langflow.ts'

type FlowMap = Record<string, string>

/** Own error type so read-only violations map to an honest 403. */
class ReadOnlyViolation extends Error {
  constructor() {
    super('This console is in read-only mode.')
  }
}

export interface AppDeps {
  config?: AppConfig
  /** Injected so tests can substitute a fixture reader. */
  openDb?: (path: string) => ReviewDbReader
  runFlowImpl?: typeof runFlow
  flows?: FlowMap
}

function resolveFlows(): FlowMap {
  return JSON.parse(readFileSync(join(import.meta.dir, '..', 'flows.json'), 'utf8')) as FlowMap
}

export function createApp(deps: AppDeps = {}) {
  const config = deps.config ?? loadConfig()
  const flows = deps.flows ?? resolveFlows()
  const openDb = deps.openDb ?? ((p: string) => new ReviewDbReader(p))
  const runFlowImpl = deps.runFlowImpl ?? runFlow

  /** Central guard: read-only mode blocks every state-changing verb. */
  const assertWritable = () => {
    if (config.readOnly) throw new ReadOnlyViolation()
  }

  const app = new Elysia({ name: 'syncare-console' })
      .error({ READ_ONLY: ReadOnlyViolation })
      // An onError registered for a code NAME is a CATCH-ALL for every error in
      // scope, so it must discriminate on ctx.code and default to 500. Without a
      // default branch, an unrelated TypeError would inherit a misleading status.
      //
      // This MUST be part of the builder chain: registering it afterwards via
      // `app.onError(...)` leaves the already-registered routes outside its
      // scope, and a thrown ReadOnlyViolation then surfaces as a bare 500.
      .onError({ READ_ONLY: 'scoped' } as never, ((ctx: never) => {
        const c = ctx as unknown as {
          code: string
          error: unknown
          status: (n: number, body: unknown) => Response
        }
        switch (c.code) {
          case 'READ_ONLY':
            return c.status(403, { error: 'read_only_mode', message: 'This console is in read-only mode.' })
          case 'VALIDATION':
            return c.status(422, { error: 'validation', message: 'Request failed schema validation.' })
          case 'NOT_FOUND':
            return c.status(404, { error: 'not_found', message: 'No such route.' })
          default:
            if (c.error instanceof LangflowTimeoutError) {
              return c.status(503, { error: 'langflow_timeout', message: c.error.message })
            }
            if (c.error instanceof LangflowHttpError) {
              return c.status(502, { error: 'langflow_http_error', message: c.error.message })
            }
            return c.status(500, { error: 'internal', message: 'Unexpected server error.' })
        }
      }) as never)

    .get('/healthz', async ({ set }) => {
      let langflow: 'reachable' | 'unreachable' = 'unreachable'
      try {
        const res = await fetch(`${config.langflowBaseUrl}/health`, { signal: AbortSignal.timeout(4000) })
        if (res.ok) langflow = 'reachable'
      } catch {
        // Unreachable is a valid, honestly-reported state: read screens still work.
      }
      const missing = Object.entries(flows)
        .filter(([, id]) => !/^[0-9a-f-]{36}$/.test(id))
        .map(([key]) => key)

      set.status = 200
      return {
        status: 'ok',
        langflow,
        reviewDbPresent: existsSync(config.reviewDbPath),
        flowCount: Object.keys(flows).length,
        manifestComplete: missing.length === 0,
        missingFlows: missing,
        readOnly: config.readOnly,
        disclaimer: DISCLAIMER,
      }
    })

    // ── Read-only clinical views (state written by the flows) ─────────────

    .get('/api/v1/plans', ({ set }) => {
      if (!existsSync(config.reviewDbPath)) {
        set.status = 503
        return {
          error: 'review_db_absent',
          message:
            'No review database yet. It is created by the Langflow F4 flow on its first approval.',
        }
      }
      const db = openDb(config.reviewDbPath)
      try {
        return { plans: db.approvedPlans(), audit: db.auditLog() }
      } finally {
        db.close()
      }
    })

    .get(
      '/api/v1/plans/:patientId',
      ({ params, set }) => {
        if (!existsSync(config.reviewDbPath)) {
          set.status = 503
          return { error: 'review_db_absent', message: 'No approved plans recorded yet.' }
        }
        const db = openDb(config.reviewDbPath)
        try {
          const plans = db.approvedPlans().filter((p) => p.patientId === params.patientId)
          if (plans.length === 0) {
            set.status = 404
            return { error: 'not_found', message: `No approved plan for ${params.patientId}.` }
          }
          return { patientId: params.patientId, plans }
        } finally {
          db.close()
        }
      },
      { params: t.Object({ patientId: t.String({ minLength: 1 }) }) },
    )

    .get('/api/v1/flows', () => ({ flows }))

    // ── Thin proxy to Langflow (the flow decides everything) ──────────────

    .post(
      '/api/v1/discharge',
      async ({ body }) => {
        assertWritable()
        const flowId = flows.f1_register_discharge_summary
        if (!flowId) return { error: 'flow_unavailable', message: 'F1 missing from flows.json.' }
        // Flow output is returned verbatim: no re-scoring, no rewriting.
        return await runFlowImpl(flowId, body.input_value)
      },
      { body: t.Object({ input_value: t.String({ minLength: 1 }) }) },
    )

    .post(
      '/api/v1/checkins',
      async ({ body }) => {
        assertWritable()
        const flowId = flows.f2_record_patient_checkin
        if (!flowId) return { error: 'flow_unavailable', message: 'F2 missing from flows.json.' }
        return await runFlowImpl(flowId, body.input_value)
      },
      { body: t.Object({ input_value: t.String({ minLength: 1 }) }) },
    )

  return app
}