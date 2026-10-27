import { Elysia } from 'elysia'
import { randomUUID } from 'node:crypto'
import { extractBearer } from '../../auth.ts'
import type { AuthService } from '../auth/service.ts'
import { DomainError, errorResponse, type RequestContext } from '../contracts/errors.ts'
import { pageInput } from '../contracts/pagination.ts'
import { readJsonRequest } from '../contracts/validation.ts'
import { exactObject } from '../patients/service.ts'
import type { AssessmentService } from './service.ts'
import type { ConfirmationService } from './confirmation.ts'

export function createAssessmentRoutes(auth: AuthService, assessments: AssessmentService, confirmations: ConfirmationService) {
  const execute = async (request: Request, action: (ctx: RequestContext) => Promise<Response>) => {
    const requestId = randomUUID()
    try {
      const token = extractBearer(request.headers.get('authorization'))
      if (!token) throw new DomainError('unauthenticated')
      const principal = await auth.getSession(token)
      const response = await action({ principal, requestId, idempotencyKey: request.headers.get('idempotency-key') ?? undefined })
      await auth.getSession(token)
      return response
    } catch (error) { return errorResponse(error, requestId) }
  }
  const respond = (data: unknown, requestId: string, status = 200) => Response.json({ data, requestId }, {
    status, headers: { 'Cache-Control': 'private, no-store' },
  })
  return new Elysia({ name: 'syncare-assessments' })
    .post('/api/v1/discharges/:dischargeId/assessments', ({ request, params }) => execute(request, async ctx => {
      exactObject(await readJsonRequest(request, 4096), [])
      const assessment = await assessments.run(ctx, params.dischargeId)
      return respond(assessment, ctx.requestId, assessment.state==='RUNNING' ? 202 : 200)
    }), { parse: 'none' })
    .get('/api/v1/patients/:patientId/assessments', ({ request, params }) => execute(request, async ctx => {
      const query = new URL(request.url).searchParams
      if (new Set(query.keys()).size!==[...query.keys()].length) throw new DomainError('validation_failed')
      const page = await assessments.list(ctx, params.patientId, pageInput(Object.fromEntries(query)))
      return Response.json({ data: page.items, nextCursor: page.nextCursor, confirmations: confirmations.history(ctx, params.patientId), requestId: ctx.requestId },
        { headers: { 'Cache-Control': 'private, no-store' } })
    }))
    .post('/api/v1/assessments/:assessmentId/confirmations', ({ request, params }) => execute(request, async ctx => {
      return respond(await confirmations.confirm(ctx, params.assessmentId, await readJsonRequest(request, 4096)), ctx.requestId, 201)
    }), { parse: 'none' })
}
