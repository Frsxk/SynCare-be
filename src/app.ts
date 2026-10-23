/** SynCare console. Langflow owns all clinical logic; this app only proxies and reads. */
/** No listen() here: tests drive the app with app.handle(). */
import { Elysia, t } from 'elysia'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AuthError, AuthNotConfiguredError, extractBearer, tokensMatch } from './auth.ts'
import { DISCLAIMER, type AppConfig, loadConfig } from './config.ts'
import { ReviewDbReader } from './plugins/review-db.ts'
import {
  LangflowHttpError,
  LangflowTimeoutError,
  LangflowUnreachableError,
  resumeReviewJob,
  runFlow,
  startReviewJob,
  streamReviewEvents,
} from './plugins/langflow.ts'

type FlowMap = Record<string, string>

/** Read-only mode blocked a mutating route; mapped to 403. */
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
  /** F4 must run as a v2 background job, so it gets its own client entry points. */
  startReviewJobImpl?: typeof startReviewJob
  resumeReviewJobImpl?: typeof resumeReviewJob
  /** Injected so the SSE route can be tested without a live Langflow job. */
  streamReviewEventsImpl?: typeof streamReviewEvents
  flows?: FlowMap
}

function resolveFlows(): FlowMap {
  return JSON.parse(readFileSync(join(import.meta.dir, '..', 'flows.json'), 'utf8')) as FlowMap
}

// F3 refuses to invent a follow-up date, so validate the ISO shape here.
const ISO_DATE = '^\\d{4}-\\d{2}-\\d{2}$'

export function createApp(deps: AppDeps = {}) {
  const config = deps.config ?? loadConfig()
  const flows = deps.flows ?? resolveFlows()
  const openDb = deps.openDb ?? ((p: string) => new ReviewDbReader(p))
  const runFlowImpl = deps.runFlowImpl ?? runFlow
  const startReviewJobImpl = deps.startReviewJobImpl ?? startReviewJob
  const resumeReviewJobImpl = deps.resumeReviewJobImpl ?? resumeReviewJob
  const streamReviewEventsImpl = deps.streamReviewEventsImpl ?? streamReviewEvents

  /** Central guard: read-only mode blocks every state-changing verb. */
  const assertWritable = () => {
    if (config.readOnly) throw new ReadOnlyViolation()
  }

  const app = new Elysia({ name: 'syncare-console' })

    // Bearer gate for every /api route, registered before any route so later routes cannot escape it.
    // Prefix matching also gates 404s, so an anonymous caller cannot map the API surface.
    .onBeforeHandle(({ request, set, path }) => {
      if (!path.startsWith('/api/')) return
      // Fail closed: no configured token means no access.
      if (config.apiKey === '') throw new AuthNotConfiguredError()
      const presented = extractBearer(request.headers.get('authorization'))
      if (presented === null || !tokensMatch(presented, config.apiKey)) {
        // RFC 6750: a 401 SHOULD carry WWW-Authenticate. Set it before throwing;
        // onError builds a fresh response and would drop headers assigned here.
        set.headers['WWW-Authenticate'] = 'Bearer realm="syncare"'
        throw new AuthError()
      }
    })

    .error({ READ_ONLY: ReadOnlyViolation, AUTH: AuthError, AUTH_NOT_CONFIGURED: AuthNotConfiguredError })
      // An onError registered by code name is a catch-all, so discriminate on ctx.code and default to 500.
      // It must stay in the builder chain; app.onError() after the routes leaves them out of scope.
      .onError({ READ_ONLY: 'scoped' } as never, ((ctx: never) => {
        const c = ctx as unknown as {
          code: string
          error: unknown
          set: { headers: Record<string, string> }
          status: (n: number, body: unknown) => Response
        }
        switch (c.code) {
          case 'READ_ONLY':
            return c.status(403, { error: 'read_only_mode', message: 'This console is in read-only mode.' })
          case 'AUTH':
            // Attach the challenge to the returned response; set.headers from the guard is dropped here.
            c.set.headers['WWW-Authenticate'] = 'Bearer realm="syncare"'
            return c.status(401, {
              error: 'unauthorized',
              message: (c.error as Error).message,
              hint: 'Send "Authorization: Bearer <token>".',
            })
          case 'AUTH_NOT_CONFIGURED':
            // 503, not 401: the client is not at fault; the server has no token.
            return c.status(503, {
              error: 'auth_not_configured',
              message: 'The server has no API token configured. The API is locked.',
            })
          case 'VALIDATION':
            return c.status(422, { error: 'validation', message: 'Request failed schema validation.' })
          case 'NOT_FOUND':
            return c.status(404, { error: 'not_found', message: 'No such route.' })
          default:
            if (c.error instanceof LangflowTimeoutError) {
              return c.status(503, { error: 'langflow_timeout', message: c.error.message })
            }
            // Langflow down: 503 so a frontend can distinguish engine failure from bad input.
            if (c.error instanceof LangflowUnreachableError) {
              return c.status(503, {
                error: 'langflow_unreachable',
                message: c.error.message,
              })
            }
            if (c.error instanceof LangflowHttpError) {
              return c.status(502, { error: 'langflow_http_error', message: c.error.message })
            }
            return c.status(500, { error: 'internal', message: 'Unexpected server error.' })
        }
      }) as never)

    .get('/api/health', async ({ set }) => {
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

    // Elysia skips app-level onBeforeHandle for unmatched routes, so re-apply the gate here.
    // Otherwise 404 vs 401 lets an anonymous caller map the API.
    .all('/api/*', async ({ request, set }) => {
      if (config.apiKey === '') throw new AuthNotConfiguredError()
      const presented = extractBearer(request.headers.get('authorization'))
      if (presented === null || !tokensMatch(presented, config.apiKey)) {
        set.headers['WWW-Authenticate'] = 'Bearer realm="syncare"'
        throw new AuthError()
      }
      // Authenticated but genuinely absent: only now is a 404 honest.
      set.status = 404
      return { error: 'not_found', message: 'No such route.' }
    })

    // Thin proxy to Langflow.
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

    // F3 needs F1's scored output in an envelope, plus an explicit ISO date and hotline.
    // It refuses to invent a date.
    .post(
      '/api/v1/plans/draft',
      async ({ body }) => {
        assertWritable()
        const flowId = flows.f3_draft_followup_plan
        if (!flowId) return { error: 'flow_unavailable', message: 'F3 missing from flows.json.' }
        return await runFlowImpl(
          flowId,
          JSON.stringify({
            patient_id: body.patient_id,
            followup_date: body.followup_date,
            hotline: body.hotline,
            f1_scored_output: body.f1_scored_output,
          }),
        )
      },
      {
        body: t.Object({
          patient_id: t.String({ minLength: 1 }),
          followup_date: t.String({ pattern: ISO_DATE }),
          hotline: t.String({ minLength: 1 }),
          f1_scored_output: t.Object({
            episode: t.Object({
              diagnosis: t.String(),
              medications: t.Array(t.String()),
              instructions: t.Array(t.String()),
              followup_needs: t.Array(t.String()),
              length_of_stay_days: t.Union([t.Number(), t.Null()]),
              admission_type: t.String(),
              comorbidity_count: t.Union([t.Number(), t.Null()]),
              admissions_prior_12m: t.Union([t.Number(), t.Null()]),
            }),
            score: t.Union([t.Number(), t.Null()]),
            tier: t.Union([t.String(), t.Null()]),
            risk_factors: t.Optional(t.Unknown()),
            rationale: t.Optional(t.String()),
            label: t.String(),
          }),
        }),
      },
    )

    // F4 runs as a v2 background job that suspends at the approval gate.
    .post(
      '/api/v1/reviews',
      async ({ body }) => {
        assertWritable()
        const flowId = flows.f4_review_care_plan
        if (!flowId) return { error: 'flow_unavailable', message: 'F4 missing from flows.json.' }
        if (!startReviewJobImpl) {
          return {
            error: 'review_unavailable',
            message: 'The background-job client is not configured on this server.',
          }
        }
        // F4 accepts ONLY a guarded F3 DRAFT and rejects anything else with
        // "Only a guarded synthetic F3 DRAFT may enter review".
        return await startReviewJobImpl(flowId, body.draft, body.session_id ?? '')
      },
      { body: t.Object({ draft: t.String({ minLength: 1 }), session_id: t.Optional(t.String()) }) },
    )

    // F4 resume: supply the human decision exactly as the gate advertised.
    .post(
      '/api/v1/reviews/:jobId/resume',
      async ({ params, body }) => {
        assertWritable()
        if (!resumeReviewJobImpl) {
          return {
            error: 'review_unavailable',
            message: 'The background-job client is not configured on this server.',
          }
        }
        return await resumeReviewJobImpl(params.jobId, {
          request_id: body.request_id,
          action_id: body.action_id,
          actor: body.actor,
          reviewer_note: body.reviewer_note,
        })
      },
      {
        params: t.Object({ jobId: t.String({ minLength: 1 }) }),
        body: t.Object({
          request_id: t.String({ minLength: 1 }),
          // The gate advertises exactly these four allowed decisions.
          action_id: t.Union([
            t.Literal('approve'),
            t.Literal('request_changes'),
            t.Literal('escalate'),
            t.Literal('fallback'),
          ]),
          actor: t.String({ minLength: 1 }),
          reviewer_note: t.Optional(t.String()),
        }),
      },
    )

    // The browser cannot call Langflow directly, so the console proxies the SSE feed.
    .get('/api/v1/reviews/:jobId/events', async ({ params, set }) => {
      const stream = await streamReviewEventsImpl(params.jobId)
      if (!stream) {
        // Langflow down or unknown/expired job: 502, and point at /api/health.
        set.status = 502
        return {
          error: 'events_unavailable',
          message:
            'Could not open the job event stream. Either Langflow is unreachable or this ' +
            'job id is unknown or already finished. Check /api/health first.',
        }
      }
      return stream
    })

    // F5 grounded Q&A; approval is enforced inside the flow.
    .post(
      '/api/v1/answers',
      async ({ body }) => {
        assertWritable()
        const flowId = flows.f5_answer_care_questions
        if (!flowId) return { error: 'flow_unavailable', message: 'F5 missing from flows.json.' }
        return await runFlowImpl(
          flowId,
          JSON.stringify({ patient_id: body.patient_id, query: body.query }),
        )
      },
      {
        body: t.Object({
          patient_id: t.String({ minLength: 1 }),
          query: t.String({ minLength: 1 }),
        }),
      },
    )

  return app
}