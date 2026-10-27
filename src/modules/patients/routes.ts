import { Elysia } from 'elysia'
import { randomUUID } from 'node:crypto'
import { extractBearer } from '../../auth.ts'
import { DomainError, errorResponse, type RequestContext } from '../contracts/errors.ts'
import { pageInput } from '../contracts/pagination.ts'
import { readJsonRequest } from '../contracts/validation.ts'
import type { AuthService } from '../auth/service.ts'
import type { PatientService } from './service.ts'
import type { AssignmentService } from './assignments.ts'
import type { DischargeService } from './discharge.ts'

export function createPatientRoutes(auth: AuthService, patients: PatientService, assignments?: AssignmentService, discharges?: DischargeService) {
  const execute = async (request: Request, action: (ctx: RequestContext) => Promise<Response>): Promise<Response> => {
    const requestId = randomUUID()
    try {
      const token = extractBearer(request.headers.get('authorization'))
      if (!token) throw new DomainError('unauthenticated')
      const principal = await auth.getSession(token)
      return await action({ principal, requestId, idempotencyKey: request.headers.get('idempotency-key') ?? undefined })
    } catch (error) { return errorResponse(error, requestId) }
  }
  const respond = (data: unknown, requestId: string, status = 200) => Response.json({ data, requestId }, {
    status, headers: { 'Cache-Control': 'private, no-store' },
  })
  return new Elysia({ name: 'syncare-patients' })
    .get('/api/v1/patients', ({ request }) => execute(request, async ctx => {
      const query = new URL(request.url).searchParams
      if (new Set(query.keys()).size !== [...query.keys()].length) throw new DomainError('validation_failed')
      const page = await patients.list(ctx, pageInput(Object.fromEntries(query)))
      return Response.json({ data: page.items, nextCursor: page.nextCursor, requestId: ctx.requestId }, {
        headers: { 'Cache-Control': 'private, no-store' },
      })
    }))
    .post('/api/v1/patients', ({ request }) => execute(request, async ctx => {
      const result = await patients.create(ctx, await readJsonRequest(request))
      return respond(result, ctx.requestId, 201)
    }), { parse: 'none' })
    .get('/api/v1/patients/:patientId', ({ request, params }) => execute(request, async ctx => {
      return respond(await patients.read(ctx, params.patientId), ctx.requestId)
    }))
    .get('/api/v1/patients/:patientId/overview', ({ request, params }) => execute(request, async ctx => {
      if (new URL(request.url).search) throw new DomainError('validation_failed')
      return respond(await patients.overview(ctx, params.patientId), ctx.requestId)
    }))
    .patch('/api/v1/patients/:patientId', ({ request, params }) => execute(request, async ctx => {
      return respond(await patients.update(ctx, params.patientId, await readJsonRequest(request)), ctx.requestId)
    }), { parse: 'none' })
    .post('/api/v1/patients/:patientId/assignments', ({ request, params }) => execute(request, async ctx => {
      if (!assignments) throw new DomainError('dependency_unavailable')
      return respond(await assignments.assign(ctx, params.patientId, await readJsonRequest(request)), ctx.requestId)
    }), { parse: 'none' })
    .post('/api/v1/patients/:patientId/discharges', ({ request, params }) => execute(request, async ctx => {
      if (!discharges) throw new DomainError('dependency_unavailable')
      return respond(await discharges.addDischarge(ctx, params.patientId, await readJsonRequest(request)), ctx.requestId, 201)
    }), { parse: 'none' })
}
