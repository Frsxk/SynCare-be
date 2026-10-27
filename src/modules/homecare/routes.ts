import { Elysia } from 'elysia'
import { randomUUID } from 'node:crypto'
import { extractBearer } from '../../auth.ts'
import type { AuthService } from '../auth/service.ts'
import { DomainError,errorResponse,type RequestContext } from '../contracts/errors.ts'
import { pageInput } from '../contracts/pagination.ts'
import { readJsonRequest } from '../contracts/validation.ts'
import type { BookingService } from './request.ts'
import { parseFilter } from './contracts.ts'

export function createHomecareRoutes(auth:AuthService,bookings:BookingService){
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
  const pageResponse=async(ctx:RequestContext,request:Request,patientId?:string)=>{
    const params=new URL(request.url).searchParams
    if(new Set(params.keys()).size!==[...params.keys()].length)throw new DomainError('validation_failed')
    const filter=patientId?undefined:parseFilter(params.get('status')??undefined)
    if(!patientId)params.delete('status')
    const page=await bookings.list(ctx,patientId,patientId?query(request):pageInput(Object.fromEntries(params)),filter)
    return Response.json({data:page.items,nextCursor:page.nextCursor,requestId:ctx.requestId},{headers:{'Cache-Control':'private, no-store'}})
  }
  return new Elysia({name:'syncare-homecare'})
    .get('/api/v1/homecare/staff',({request})=>execute(request,async ctx=>{
      const params=new URL(request.url).searchParams
      if(new Set(params.keys()).size!==[...params.keys()].length)throw new DomainError('validation_failed')
      const patientId=params.get('patientId')
      if(!patientId||!/^[A-Za-z0-9_-]{1,128}$/.test(patientId))throw new DomainError('validation_failed')
      params.delete('patientId')
      const page=await bookings.staff(ctx,patientId,pageInput(Object.fromEntries(params)))
      return Response.json({data:page.items,nextCursor:page.nextCursor,requestId:ctx.requestId},{headers:{'Cache-Control':'private, no-store'}})
    }))
    .get('/api/v1/homecare/services',({request})=>execute(request,async ctx=>{
      const page=await bookings.catalog(ctx,query(request))
      return Response.json({data:page.items,nextCursor:page.nextCursor,requestId:ctx.requestId},{headers:{'Cache-Control':'private, no-store'}})
    }))
    .post('/api/v1/patients/:patientId/bookings',({request,params})=>execute(request,async ctx=>{
      noQuery(request)
      return respond(await bookings.request(ctx,params.patientId,await readJsonRequest(request,16000)),ctx.requestId,201)
    }),{parse:'none'})
    .get('/api/v1/patients/:patientId/bookings',({request,params})=>execute(request,ctx=>pageResponse(ctx,request,params.patientId)))
    .get('/api/v1/bookings',({request})=>execute(request,ctx=>pageResponse(ctx,request)))
    .get('/api/v1/bookings/:bookingId',({request,params})=>execute(request,async ctx=>{
      noQuery(request);return respond(await bookings.read(ctx,params.bookingId),ctx.requestId)
    }))
    .post('/api/v1/bookings/:bookingId/transitions',({request,params})=>execute(request,async ctx=>{
      noQuery(request);return respond(await bookings.transition(ctx,params.bookingId,await readJsonRequest(request,16000)),ctx.requestId)
    }),{parse:'none'})
}
