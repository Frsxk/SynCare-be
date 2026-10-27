import { Elysia } from 'elysia'
import { randomUUID } from 'node:crypto'
import { extractBearer } from '../../auth.ts'
import type { AuthService } from '../auth/service.ts'
import { DomainError,errorResponse,type RequestContext } from '../contracts/errors.ts'
import { pageInput } from '../contracts/pagination.ts'
import { readJsonRequest } from '../contracts/validation.ts'
import { readGuidance } from '../alerts/guidance.ts'
import type { CheckinService } from './service.ts'

export function createCheckinRoutes(auth:AuthService,checkins:CheckinService,guidance?:unknown){
  const execute=async(request:Request,action:(ctx:RequestContext)=>Promise<Response>)=>{
    const requestId=randomUUID()
    try{
      const token=extractBearer(request.headers.get('authorization'))
      if(!token)throw new DomainError('unauthenticated')
      const principal=await auth.getSession(token)
      const result=await action({principal,requestId,idempotencyKey:request.headers.get('idempotency-key')??undefined})
      await auth.getSession(token)
      return result
    }catch(error){return errorResponse(error,requestId)}
  }
  const respond=(data:unknown,requestId:string,status=200)=>Response.json({data,requestId},{status,headers:{'Cache-Control':'private, no-store'}})
  const query=(request:Request)=>{
    const params=new URL(request.url).searchParams
    if(new Set(params.keys()).size!==[...params.keys()].length)throw new DomainError('validation_failed')
    return pageInput(Object.fromEntries(params))
  }
  const noQuery=(request:Request)=>{if(new URL(request.url).search)throw new DomainError('validation_failed')}
  return new Elysia({name:'syncare-checkins'})
    .post('/api/v1/patients/:patientId/checkins',({request,params})=>execute(request,async ctx=>{
      noQuery(request)
      return respond(await checkins.submit(ctx,params.patientId,await readJsonRequest(request,16000)),ctx.requestId,202)
    }),{parse:'none'})
    .get('/api/v1/patients/:patientId/checkins',({request,params})=>execute(request,async ctx=>{
      const page=await checkins.list(ctx,params.patientId,query(request))
      return Response.json({data:page.items,nextCursor:page.nextCursor,requestId:ctx.requestId},{headers:{'Cache-Control':'private, no-store'}})
    }))
    .get('/api/v1/checkins/:checkinId',({request,params})=>execute(request,async ctx=>{
      noQuery(request);return respond(await checkins.read(ctx,params.checkinId),ctx.requestId)
    }))
    .get('/api/v1/monitoring',({request})=>execute(request,async ctx=>{
      const page=await checkins.monitoring(ctx,query(request))
      return Response.json({data:page.items,nextCursor:page.nextCursor,requestId:ctx.requestId},{headers:{'Cache-Control':'private, no-store'}})
    }))
    .get('/api/v1/emergency-guidance',({request})=>execute(request,async ctx=>{
      noQuery(request);return respond(readGuidance(guidance),ctx.requestId)
    }))
}
