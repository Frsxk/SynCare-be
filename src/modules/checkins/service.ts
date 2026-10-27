import { randomUUID } from 'node:crypto'
import type { Store } from '../../storage/database.ts'
import { DomainError,type RequestContext } from '../contracts/errors.ts'
import { withIdempotency } from '../contracts/idempotency.ts'
import { strictTextObject } from '../contracts/validation.ts'
import { CursorCodec,type PageInput } from '../contracts/pagination.ts'
import { assertPatientScope,currentIdentity } from '../patients/service.ts'
import { ConfirmationService } from '../assessments/confirmation.ts'
import { CheckinQueries } from './queries.ts'
import { enqueueWork } from './contracts.ts'
import type { CheckinProcessor } from './processor.ts'

export class CheckinService {
  private readonly queries:CheckinQueries
  private readonly clock:()=>Date
  private readonly processor?:Pick<CheckinProcessor,'process'>
  constructor(private readonly store:Store,options:{codec:CursorCodec;clock?:()=>Date;processor?:Pick<CheckinProcessor,'process'>}){
    this.queries=new CheckinQueries(store,options.codec);this.clock=options.clock??(()=>new Date())
    this.processor=options.processor
  }
  async process(checkinId:string,attemptId:string){
    if(!this.processor)throw new DomainError('dependency_unavailable')
    return this.processor.process(checkinId,attemptId)
  }
  async submit(ctx:RequestContext,patientId:string,input:unknown){
    const body=strictTextObject(input,{message:8000})
    if(currentIdentity(this.store,ctx.principal).role!=='patient')throw new DomainError('forbidden')
    assertPatientScope(this.store,ctx.principal,patientId)
    const receipt=await withIdempotency(this.store,{principalId:ctx.principal.id,method:'POST',resourceKey:`/patients/${patientId}/checkins`,
      key:ctx.idempotencyKey??'',payload:body},tx=>{
      assertPatientScope(tx,ctx.principal,patientId)
      const risk=new ConfirmationService(this.store).summary(ctx,patientId).current
      const baseline=risk&&Number.isInteger(risk.score)&&risk.score>=0?risk:null
      const id=randomUUID(),attemptId=randomUUID(),now=this.clock().toISOString()
      tx.run('INSERT INTO checkins VALUES (?,?,?,?,?,?,?,?,?)',[id,patientId,ctx.principal.id,body.message,now,baseline?.assessmentId??null,baseline?.id??null,baseline?.score??null,1])
      tx.run('INSERT INTO processing_attempts(id,checkin_id,session_id,state,version,created_at,updated_at,failure_code) VALUES (?,?,?,?,?,?,?,?)',
        [attemptId,id,`checkin:${patientId}:${id}:${randomUUID()}`,baseline?'PENDING':'BLOCKED_BASELINE',1,now,now,baseline?null:'baseline_unavailable'])
      if(baseline)enqueueWork(tx,'CHECKIN_F2',id,{checkinId:id},now)
      tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)',[randomUUID(),ctx.principal.id,'checkin.submitted','checkin',id,now,JSON.stringify({patientId,baselineAssessmentId:baseline?.assessmentId??null})])
      return{resourceId:id,status:202,data:{id}}
    })
    return{resource:this.queries.read(ctx,receipt.resourceId),replayed:receipt.replayed}
  }
  async read(ctx:RequestContext,id:string){return this.queries.read(ctx,id)}
  async list(ctx:RequestContext,patientId:string,input:PageInput){return this.queries.list(ctx,patientId,input)}
  async monitoring(ctx:RequestContext,input:PageInput){return this.queries.monitoring(ctx,input)}
}
