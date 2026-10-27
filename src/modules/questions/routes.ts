import {Elysia} from 'elysia'
import {randomUUID} from 'node:crypto'
import {extractBearer} from '../../auth.ts'
import type {AuthService} from '../auth/service.ts'
import {DomainError,errorResponse} from '../contracts/errors.ts'
import {readJsonRequest,strictTextObject} from '../contracts/validation.ts'
import type {QuestionService} from './service.ts'
export function createQuestionRoutes(auth:AuthService,questions:QuestionService){
  const execute=async(request:Request,patientId?:string)=>{
    const requestId=randomUUID()
    try{
      if(new URL(request.url).search)throw new DomainError('validation_failed')
      const token=extractBearer(request.headers.get('authorization'));if(!token)throw new DomainError('unauthenticated')
      const principal=await auth.getSession(token),raw=await readJsonRequest(request,8192)
      const input=patientId?raw:strictTextObject(raw,{patient_id:128,query:2000}),id=patientId??(input as Record<string,string>).patient_id!
      const data=await questions.ask({principal,requestId},id,patientId?input:{query:(input as Record<string,string>).query})
      await auth.getSession(token);questions.authorize({principal,requestId},id)
      return Response.json({data,requestId},{headers:{'Cache-Control':'private, no-store'}})
    }catch(e){return errorResponse(e,requestId)}
  }
  return new Elysia({name:'syncare-questions'})
    .post('/api/v1/patients/:patientId/questions',({request,params})=>execute(request,params.patientId),{parse:'none'})
    .post('/api/v1/answers',({request})=>execute(request),{parse:'none'})
}
