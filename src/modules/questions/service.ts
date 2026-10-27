import {randomUUID} from 'node:crypto'
import type {Store} from '../../storage/database.ts'
import type {FlowRunResult} from '../../plugins/langflow.ts'
import {DomainError,type RequestContext} from '../contracts/errors.ts'
import {strictTextObject} from '../contracts/validation.ts'
import {currentIdentity,assertPatientScope} from '../patients/service.ts'
import {readGuidance} from '../alerts/guidance.ts'
import {normalizeAnswer,type AnswerOutcome} from './contracts.ts'
export class QuestionService {
  private readonly active=new Map<string,Promise<void>>()
  constructor(private readonly store:Store,private readonly options:{verify:()=>Promise<void>;runF5:(input:string,sessionId:string)=>Promise<FlowRunResult>;grounding:{validate:(patientId:string,answer:Extract<AnswerOutcome,{kind:'answer'}>)=>void};guidance?:unknown}){}
  authorize(ctx:RequestContext,patientId:string){currentIdentity(this.store,ctx.principal);assertPatientScope(this.store,ctx.principal,patientId)}
  async ask(ctx:RequestContext,patientId:string,input:unknown):Promise<AnswerOutcome>{
    this.authorize(ctx,patientId);const body=strictTextObject(input,{query:2000})
    const previous=this.active.get(patientId)??Promise.resolve();let release!:()=>void
    const pending=new Promise<void>(resolve=>{release=resolve}),tail=previous.then(()=>pending);this.active.set(patientId,tail)
    await previous
    try{
      this.authorize(ctx,patientId);await this.options.verify();this.authorize(ctx,patientId)
      let result:FlowRunResult
      try{result=await this.options.runF5(JSON.stringify({patient_id:patientId,query:body.query}),`qa:${patientId}:${randomUUID()}`)}catch{throw new DomainError('dependency_unavailable')}
      this.authorize(ctx,patientId)
      const answer=normalizeAnswer(result.outputText,patientId)
      if(answer.kind==='answer')this.options.grounding.validate(patientId,answer)
      if(answer.kind==='emergency'){try{answer.guidance=readGuidance(this.options.guidance)}catch{answer.guidance=null}}
      return answer
    }finally{release();if(this.active.get(patientId)===tail)this.active.delete(patientId)}
  }
}
