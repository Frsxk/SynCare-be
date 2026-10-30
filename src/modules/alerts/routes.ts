import { Elysia } from 'elysia'
import { randomUUID } from 'node:crypto'
import { extractBearer } from '../../auth.ts'
import type { AuthService } from '../auth/service.ts'
import { DomainError,errorResponse,type RequestContext } from '../contracts/errors.ts'
import { pageInput } from '../contracts/pagination.ts'
import { readJsonRequest } from '../contracts/validation.ts'
import type { AlertService } from './actions.ts'
import { parseAlertFilter } from './contracts.ts'
export function createAlertRoutes(auth:AuthService,alerts:AlertService){
  const execute=async(request:Request,action:(ctx:RequestContext)=>Promise<Response>)=>{
    const requestId=randomUUID()
    try{
      const token=extractBearer(request.headers.get('authorization'));if(!token)throw new DomainError('unauthenticated')
      const principal=await auth.getSession(token)
      const result=await action({principal,requestId,idempotencyKey:request.headers.get('idempotency-key')??undefined})
      await auth.getSession(token);return result
    }catch(error){return errorResponse(error,requestId)}
  }
  const respond=(data:unknown,requestId:string,status=200)=>Response.json({data,requestId},{status,headers:{'Cache-Control':'private, no-store'}})
  const params=(request:Request)=>{const p=new URL(request.url).searchParams;if(new Set(p.keys()).size!==[...p.keys()].length)throw new DomainError('validation_failed');return p}
  const list=(request:Request,patientId?:string)=>execute(request,async ctx=>{
    const p=params(request),filter=parseAlertFilter(p.get('status')??undefined);p.delete('status')
    const page=alerts.list(ctx,patientId,pageInput(Object.fromEntries(p)),filter)
    return Response.json({data:page.items,nextCursor:page.nextCursor,requestId:ctx.requestId},{headers:{'Cache-Control':'private, no-store'}})
  })
  return new Elysia({name:'syncare-alerts'})
    .get('/api/v1/alerts',({request})=>list(request))
    .get('/api/v1/patients/:patientId/alerts',({request,params})=>list(request,params.patientId))
    .post('/api/v1/patients/:patientId/emergencies',({request,params:route})=>execute(request,async ctx=>{
      if(new URL(request.url).search)throw new DomainError('validation_failed')
      return respond(await alerts.requestEmergency(ctx,route.patientId,await readJsonRequest(request)),ctx.requestId,201)
    }),{parse:'none'})
    .get('/api/v1/alerts/:alertId',({request,params:route})=>execute(request,async ctx=>respond(alerts.read(ctx,route.alertId,pageInput(Object.fromEntries(params(request)))),ctx.requestId)))
    .post('/api/v1/alerts/:alertId/actions',({request,params:route})=>execute(request,async ctx=>{
      if(new URL(request.url).search)throw new DomainError('validation_failed')
      return respond(await alerts.act(ctx,route.alertId,await readJsonRequest(request,24000)),ctx.requestId)
    }),{parse:'none'})
}
