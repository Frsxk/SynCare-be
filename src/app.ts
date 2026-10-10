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

// F3 refuses to invent a follow-up date, so validate the ISO shape here rather
// than letting the flow reject it. Elysia's `pattern` wants a string.
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

    /**
     * BEARER GATE for every /api route.
     *
     * Registered as app-level `onBeforeHandle` BEFORE any route is declared, so
     * it applies to every /api route including ones added later -- a new
     * clinical route cannot escape it by forgetting to add a line. Matching on
     * the path prefix (rather than a plugin scope) also means the gate is
     * evaluated for routes that 404, so an unauthenticated caller cannot probe
     * which endpoints exist.
     *
     * This server serves NOTHING but the API. `/` returns a plain 404 and no
     * HTML is shipped from this repo -- the frontend is a separate application
     * that consumes these routes. `/api/health` sits behind the gate like every
     * other API route.
     */
    .onBeforeHandle(({ request, set, path }) => {
      if (!path.startsWith('/api/')) return
      // Fail CLOSED: no configured token means no access. There is no branch
      // that treats a missing token as "allow".
      if (config.apiKey === '') throw new AuthNotConfiguredError()
      const presented = extractBearer(request.headers.get('authorization'))
      if (presented === null || !tokensMatch(presented, config.apiKey)) {
        // RFC 6750 §3: a 401 SHOULD carry a WWW-Authenticate challenge; without
        // it some clients silently retry. Set before throwing because an
        // onError `status()` response is built fresh and would otherwise drop
        // any header assigned to `set` on the way out.
        set.headers['WWW-Authenticate'] = 'Bearer realm="syncare"'
        throw new AuthError()
      }
    })

    .error({ READ_ONLY: ReadOnlyViolation, AUTH: AuthError, AUTH_NOT_CONFIGURED: AuthNotConfiguredError })
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
          set: { headers: Record<string, string> }
          status: (n: number, body: unknown) => Response
        }
        switch (c.code) {
          case 'READ_ONLY':
            return c.status(403, { error: 'read_only_mode', message: 'This console is in read-only mode.' })
          case 'AUTH':
            // The challenge header must be attached HERE, on the response that
            // is actually returned. Assigning it to `set.headers` inside the
            // guard is discarded, because onError's `status()` constructs a new
            // Response rather than reusing the one the handler was mutating.
            c.set.headers['WWW-Authenticate'] = 'Bearer realm="syncare"'
            return c.status(401, {
              error: 'unauthorized',
              message: (c.error as Error).message,
              hint: 'Send "Authorization: Bearer <token>".',
            })
          case 'AUTH_NOT_CONFIGURED':
            // 503, not 401: the CLIENT is not at fault, the server is. This
            // distinguishes "your token is wrong" from "the server forgot to
            // set one" so the operator debugs the right machine.
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
            // Langflow is the clinical engine. If it is down the request cannot
            // be served at all, and a frontend must be able to tell that apart
            // from its own bad input -- hence 503, not 500.
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

    /**
     * Catch-all for unmatched /api paths.
     *
     * Elysia does NOT run app-level `onBeforeHandle` for a route that does not
     * match, so without this an anonymous caller could map the API surface for
     * free by distinguishing 404 (route absent) from 401 (route present). The
     * gate is re-applied here so an unknown /api path answers exactly like a
     * known one. Non-/api paths still fall through to Elysia's normal 404.
     */
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

    // F3 guards its input: it needs F1's scored output wrapped in an envelope,
    // plus an explicit ISO followup_date and a hotline. It refuses to invent a
    // date, so the caller must supply real values.
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

    // F4 is a Human-In-The-Loop flow: it must run as a v2 background job that
    // suspends at an approval gate. It is never called synchronously.
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

    // The browser cannot call Langflow directly (the API key must stay
    // server-side), so the console streams the SSE event feed through here.
    .get('/api/v1/reviews/:jobId/events', async ({ params, set }) => {
      const stream = await streamReviewEventsImpl(params.jobId)
      if (!stream) {
        // Ambiguous by nature: either Langflow is down, or this job id is
        // unknown/expired. Say so, and point at the one check that separates
        // them, rather than implying the stream alone is the problem.
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

    // F5 grounded Q&A. Fail-closed in the flow: an unapproved patient_id is
    // refused there, never here.
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