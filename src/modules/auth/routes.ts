import { Elysia } from 'elysia'
import { randomUUID } from 'node:crypto'
import { extractBearer } from '../../auth.ts'
import { DomainError, errorResponse } from '../contracts/errors.ts'
import { readJsonRequest, strictTextObject } from '../contracts/validation.ts'
import type { AuthService } from './service.ts'
import type { ProvisionService } from './provision.ts'

export function createAuthRoutes(auth: AuthService, provision?: ProvisionService) {
  const execute = async (request: Request, action: (requestId: string) => Promise<Response>) => {
    const requestId = randomUUID()
    try { return await action(requestId) } catch (error) { return errorResponse(error, requestId) }
  }
  const privateHeaders = { 'Cache-Control': 'private, no-store', 'Pragma': 'no-cache' }
  return new Elysia({ name: 'syncare-auth' })
    .post('/api/v1/auth/login', ({ request }) => execute(request, async requestId => {
      const body = strictTextObject(await readJsonRequest(request, 4096), { identifier: 320, password: 128 })
      return Response.json({ data: await auth.login(body.identifier, body.password), requestId }, { headers: privateHeaders })
    }), { parse: 'none' })
    .get('/api/v1/auth/session', ({ request }) => execute(request, async requestId => {
      const token = extractBearer(request.headers.get('authorization'))
      if (!token) throw new DomainError('unauthenticated')
      const { principal, expiresAt } = await auth.inspect(token)
      return Response.json({ data: { principal, expiresAt }, requestId }, { headers: privateHeaders })
    }))
    .delete('/api/v1/auth/session', ({ request }) => execute(request, async () => {
      const token = extractBearer(request.headers.get('authorization'))
      if (!token) throw new DomainError('unauthenticated')
      await auth.revoke((await auth.inspect(token)).sessionId)
      return new Response(null, { status: 204, headers: privateHeaders })
    }))
    .post('/api/v1/accounts/patient-links', ({ request }) => execute(request, async requestId => {
      const token = extractBearer(request.headers.get('authorization'))
      if (!token) throw new DomainError('unauthenticated')
      const principal = await auth.getSession(token)
      if (!provision) throw new DomainError('dependency_unavailable')
      return Response.json({ data: await provision.provision({ principal, requestId }, await readJsonRequest(request, 8192)), requestId },
        { status: 201, headers: privateHeaders })
    }), { parse: 'none' })
}
