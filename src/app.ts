import { Elysia } from 'elysia'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { extractBearer, tokensMatch } from './auth.ts'
import { loadConfig, loadSecurityConfig, type SecurityConfig } from './config.ts'
import { createLegacyApp, type AppDeps } from './legacy-app.ts'
import type { Store } from './storage/database.ts'
import { AuthService } from './modules/auth/service.ts'
import { createAuthRoutes } from './modules/auth/routes.ts'
import { ProvisionService } from './modules/auth/provision.ts'
import { Policy } from './modules/auth/policy.ts'
import { PatientService, requireCapability } from './modules/patients/service.ts'
import { AssignmentService } from './modules/patients/assignments.ts'
import { DischargeService } from './modules/patients/discharge.ts'
import { OverviewService } from './modules/patients/overview.ts'
import { AssessmentService } from './modules/assessments/service.ts'
import { ConfirmationService } from './modules/assessments/confirmation.ts'
import { createAssessmentRoutes } from './modules/assessments/routes.ts'
import { runFlow } from './plugins/langflow.ts'
import { createPatientRoutes } from './modules/patients/routes.ts'
import { createCheckinRoutes } from './modules/checkins/routes.ts'
import { CheckinService } from './modules/checkins/service.ts'
import { BookingService } from './modules/homecare/request.ts'
import { createHomecareRoutes } from './modules/homecare/routes.ts'
import { AlertService } from './modules/alerts/actions.ts'
import { createAlertRoutes } from './modules/alerts/routes.ts'
import { createPlanRoutes } from './modules/plans/routes.ts'
import { ReviewService } from './modules/reviews/service.ts'
import { LangflowReviewGateway } from './modules/reviews/gateway.ts'
import { QuestionService } from './modules/questions/service.ts'
import { QuestionGateway } from './modules/questions/gateway.ts'
import { QuestionGrounding } from './modules/questions/grounding.ts'
import { createQuestionRoutes } from './modules/questions/routes.ts'
import type { CheckinProcessor } from './modules/checkins/processor.ts'
import { CursorCodec } from './modules/contracts/pagination.ts'
import { DomainError, errorResponse } from './modules/contracts/errors.ts'

export interface ApplicationDependencies extends AppDeps {
  store: Store
  security?: SecurityConfig
  auth?: AuthService
  cursorSecret: string
  guidance?: unknown
  checkinProcessor?:CheckinProcessor
  reviews?:ReviewService
  questions?:QuestionService
}

export function createApp(deps: ApplicationDependencies) {
  const config = deps.config ?? loadConfig()
  const security = deps.security ?? loadSecurityConfig()
  const auth = deps.auth ?? new AuthService(deps.store)
  const flowMap=deps.flows??JSON.parse(readFileSync(new URL('../flows.json',import.meta.url),'utf8')) as Record<string,string>
  const reviews=deps.reviews??new ReviewService(deps.store,{codec:new CursorCodec(deps.cursorSecret),reviewDbPath:config.reviewDbPath,
    gateway:new LangflowReviewGateway({baseUrl:config.langflowBaseUrl,apiKey:config.langflowApiKey,flowId:flowMap.f4_review_care_plan!,f5FlowId:flowMap.f5_answer_care_questions!,reviewDbPath:config.reviewDbPath}),
    runF3:(input,sessionId)=>(deps.runFlowImpl??runFlow)(flowMap.f3_draft_followup_plan!,input,{sessionId})})
  const planRoutes=createPlanRoutes(auth,reviews)
  const questionGateway=new QuestionGateway({baseUrl:config.langflowBaseUrl,apiKey:config.langflowApiKey,flowId:flowMap.f5_answer_care_questions!,reviewDbPath:config.reviewDbPath})
  const questionRoutes=createQuestionRoutes(auth,deps.questions??new QuestionService(deps.store,{verify:()=>questionGateway.verify(),
    runF5:(input,sessionId)=>(deps.runFlowImpl??runFlow)(flowMap.f5_answer_care_questions!,input,{sessionId}),grounding:new QuestionGrounding(deps.store,config.reviewDbPath),guidance:deps.guidance}))
  const overview = new OverviewService(deps.store)
  const checkinRoutes = createCheckinRoutes(auth,new CheckinService(deps.store,{codec:new CursorCodec(deps.cursorSecret),processor:deps.checkinProcessor}),deps.guidance)
  const homecareRoutes = createHomecareRoutes(auth,new BookingService(deps.store,{codec:new CursorCodec(deps.cursorSecret)}))
  const alertRoutes = createAlertRoutes(auth,new AlertService(deps.store,{codec:new CursorCodec(deps.cursorSecret)}))
  const patients = new PatientService(deps.store, { codec: new CursorCodec(deps.cursorSecret), overview: (ctx, profile) => overview.read(ctx, profile) })
  const policy = new Policy(deps.store)
  const authRoutes = createAuthRoutes(auth, new ProvisionService(deps.store))
  const patientRoutes = createPatientRoutes(auth, patients, new AssignmentService(deps.store), new DischargeService(deps.store))
  const assessmentRoutes = createAssessmentRoutes(auth, new AssessmentService(deps.store, {
    codec: new CursorCodec(deps.cursorSecret), runF1: async (sourceText, sessionId) => {
      const flows = deps.flows ?? JSON.parse(readFileSync(new URL('../flows.json', import.meta.url), 'utf8')) as Record<string, string>
      const flowId = flows.f1_register_discharge_summary
      if (!flowId) throw new DomainError('dependency_unavailable')
      return (deps.runFlowImpl ?? runFlow)(flowId, sourceText, { sessionId })
    },
  }), new ConfirmationService(deps.store))
  const internalKey = randomBytes(32).toString('base64url')
  const legacy = createLegacyApp({ ...deps, config: { ...config, apiKey: internalKey } })

  const forward = (request: Request) => {
    const headers = new Headers(request.headers)
    headers.set('authorization', `Bearer ${internalKey}`)
    return legacy.handle(new Request(request, { headers }))
  }

  return new Elysia({ name: 'syncare-application' }).all('*', async ({ request }) => {
    const requestId = randomUUID()
    try {
      const url = new URL(request.url)
      if (!url.pathname.startsWith('/api/')) return new Response(null, { status: 404 })
      const backend = new URL(security.backendOrigin)
      const localAlias = security.allowLocalHttp && backend.protocol === 'http:' && url.protocol === 'http:' && backend.port === url.port &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(backend.hostname) && ['127.0.0.1', 'localhost', '[::1]', '10.0.2.2'].includes(url.hostname)
      if (url.origin !== security.backendOrigin && !localAlias) throw new DomainError('forbidden')
      const origin = request.headers.get('origin')
      if (origin !== null && origin !== security.webOrigin) throw new DomainError('forbidden')
      if (/%2f|%5c|%25|\\/i.test(url.pathname)) throw new DomainError('validation_failed')
      if (url.pathname === '/api/v1/auth/login' && request.method === 'POST') return await authRoutes.handle(request)
      const token = extractBearer(request.headers.get('authorization'))
      if (!token) throw new DomainError('unauthenticated')
      if (url.pathname === '/api/health' && request.method === 'GET' && config.apiKey && tokensMatch(token, config.apiKey)) return await forward(request)
      const principal = await auth.getSession(token)
      if (url.pathname === '/api/v1/auth/session') return await authRoutes.handle(request)
      if (config.readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) throw new DomainError('forbidden')
      if (url.pathname === '/api/v1/accounts/patient-links') return await authRoutes.handle(request)
      if (/^\/api\/v1\/(?:patients\/[A-Za-z0-9_-]+\/(?:care-plan-drafts|care-plans)|care-plan-drafts\/[A-Za-z0-9_-]+(?:\/reviews)?|reviews(?:\/[A-Za-z0-9_-]+(?:\/(?:decisions|stream))?)?)$/.test(url.pathname)) return await planRoutes.handle(request)
      if (/^\/api\/v1\/(?:alerts(?:\/[A-Za-z0-9_-]+(?:\/actions)?)?|patients\/[A-Za-z0-9_-]+\/alerts)$/.test(url.pathname)) return await alertRoutes.handle(request)
      if (/^\/api\/v1\/(?:homecare\/(?:services|staff)|patients\/[A-Za-z0-9_-]+\/bookings|bookings(?:\/[A-Za-z0-9_-]+(?:\/transitions)?)?)$/.test(url.pathname)) return await homecareRoutes.handle(request)
      if (/^\/api\/v1\/(?:patients\/[A-Za-z0-9_-]+\/checkins|checkins\/[A-Za-z0-9_-]+|monitoring|emergency-guidance)$/.test(url.pathname)) return await checkinRoutes.handle(request)
      if (/^\/api\/v1\/(?:discharges\/[A-Za-z0-9_-]+\/assessments|assessments\/[A-Za-z0-9_-]+\/confirmations|patients\/[A-Za-z0-9_-]+\/assessments)$/.test(url.pathname)) return await assessmentRoutes.handle(request)
      if (/^\/api\/v1\/patients(?:\/[A-Za-z0-9_-]+(?:\/(?:assignments|discharges|overview))?)?$/.test(url.pathname)) return await patientRoutes.handle(request)
      if (url.pathname === '/api/health' && request.method === 'GET') return await forward(request)
      if (url.pathname === '/api/v1/flows' && request.method === 'GET') {
        requireCapability(deps.store, principal, 'account.provision')
        return await forward(request)
      }
      if (url.pathname === '/api/v1/plans' && request.method === 'GET') {
        const result=reviews.approved.legacy({principal,requestId})
        await auth.getSession(token)
        return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
      }
      const plan = /^\/api\/v1\/plans\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
      if (plan && request.method === 'GET') {
        await policy.authorize(principal, 'patient.read', { patientId: plan[1]! })
        const result=reviews.approved.legacy({principal,requestId},plan[1]!)
        if(!result.plans.length)throw new DomainError('not_found')
        await auth.getSession(token)
        await policy.authorize(principal, 'patient.read', { patientId: plan[1]! })
        return Response.json({patientId:plan[1]!,plans:result.plans},
          { headers: { 'Cache-Control': 'private, no-store' } })
      }
      if (url.pathname === '/api/v1/answers'||/^\/api\/v1\/patients\/[A-Za-z0-9_-]+\/questions$/.test(url.pathname)) return await questionRoutes.handle(request)
      // Raw clinical inputs and upstream job IDs lack durable ownership until their domain milestones.
      if (/^\/api\/v1\/(?:discharge|checkins|plans\/draft|reviews(?:\/.*)?)$/.test(url.pathname)) throw new DomainError('forbidden')
      throw new DomainError('not_found')
    } catch (error) { return errorResponse(error, requestId) }
  }, { parse: 'none' }).onAfterHandle(({ set }) => {
    set.headers['Cache-Control'] = 'private, no-store'
    set.headers['X-Content-Type-Options'] = 'nosniff'
  })
}
