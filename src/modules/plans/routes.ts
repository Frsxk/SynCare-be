import { Elysia } from 'elysia'
import { randomUUID } from 'node:crypto'
import { extractBearer } from '../../auth.ts'
import type { AuthService } from '../auth/service.ts'
import { DomainError,errorResponse,type RequestContext } from '../contracts/errors.ts'
import { readJsonRequest } from '../contracts/validation.ts'
import { pageInput } from '../contracts/pagination.ts'
import type { ReviewService } from '../reviews/service.ts'
import { reviewStream } from '../reviews/stream.ts'
export function createPlanRoutes(auth:AuthService,reviews:ReviewService){
  const execute=async(request:Request,action:(ctx:RequestContext,token:string)=>Promise<Response>)=>{
    const requestId=randomUUID()
    try{
      const token=extractBearer(request.headers.get('authorization'));if(!token)throw new DomainError('unauthenticated')
      const principal=await auth.getSession(token),response=await action({principal,requestId,idempotencyKey:request.headers.get('idempotency-key')??undefined},token)
      await auth.getSession(token);return response
    }catch(error){return errorResponse(error,requestId)}
  }
  const params=(request:Request)=>{const p=new URL(request.url).searchParams;if(new Set(p.keys()).size!==[...p.keys()].length)throw new DomainError('validation_failed');return p}
  const respond=(data:unknown,requestId:string,status=200)=>Response.json({data,requestId},{status,headers:{'Cache-Control':'private, no-store'}})
  const page=(value:{items:unknown[];nextCursor:string|null},requestId:string)=>Response.json({data:value.items,nextCursor:value.nextCursor,requestId},{headers:{'Cache-Control':'private, no-store'}})
  const body=async(request:Request)=>{if(new URL(request.url).search)throw new DomainError('validation_failed');return readJsonRequest(request,16000)}
  return new Elysia({name:'syncare-care-plans'})
    .post('/api/v1/patients/:id/care-plan-drafts',({request,params:p})=>execute(request,async ctx=>respond(await reviews.plans.draft(ctx,p.id,await body(request)),ctx.requestId,202)),{parse:'none'})
    .get('/api/v1/care-plan-drafts/:id',({request,params:p})=>execute(request,async ctx=>{if(params(request).size)throw new DomainError('validation_failed');return respond(reviews.plans.read(ctx,p.id),ctx.requestId)}))
    .post('/api/v1/care-plan-drafts/:id/reviews',({request,params:p})=>execute(request,async ctx=>respond(await reviews.start(ctx,p.id,await body(request)),ctx.requestId,202)),{parse:'none'})
    .get('/api/v1/reviews',({request})=>execute(request,async ctx=>{const p=params(request),patientId=p.get('patientId')??undefined;p.delete('patientId');return page(reviews.list(ctx,pageInput(Object.fromEntries(p)),patientId),ctx.requestId)}))
    .get('/api/v1/reviews/:id',({request,params:p})=>execute(request,async ctx=>{if(params(request).size)throw new DomainError('validation_failed');return respond(reviews.read(ctx,p.id),ctx.requestId)}))
    .get('/api/v1/reviews/:id/stream',({request,params:p})=>execute(request,async(ctx,token)=>{if(params(request).size)throw new DomainError('validation_failed');return reviewStream(reviews.store,auth,token,ctx,p.id,request)}))
    .post('/api/v1/reviews/:id/decisions',({request,params:p})=>execute(request,async ctx=>respond(await reviews.decide(ctx,p.id,await body(request)),ctx.requestId,202)),{parse:'none'})
    .get('/api/v1/patients/:id/care-plans',({request,params:p})=>execute(request,async ctx=>page(reviews.approved.list(ctx,p.id,pageInput(Object.fromEntries(params(request)))),ctx.requestId)))
}
