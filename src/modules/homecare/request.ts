import { randomUUID } from 'node:crypto'
import type { Store } from '../../storage/database.ts'
import { DomainError,type RequestContext } from '../contracts/errors.ts'
import { CursorCodec,type PageInput } from '../contracts/pagination.ts'
import { withIdempotency } from '../contracts/idempotency.ts'
import { currentIdentity,assertPatientScope } from '../patients/service.ts'
import { parseInput,type BookingFilter } from './contracts.ts'
import { catalog,serviceProjection,type ServiceRow } from './catalog.ts'
import { read,list } from './queries.ts'
import { transition } from './transitions.ts'
import { staff } from './scheduling.ts'

export class BookingService {
  private readonly clock:()=>Date
  constructor(private readonly store:Store,private readonly options:{codec:CursorCodec;clock?:()=>Date}){this.clock=options.clock??(()=>new Date())}
  catalog(ctx:RequestContext,page:PageInput){return catalog(this.store,ctx,page,this.options.codec)}
  staff(ctx:RequestContext,patientId:string,page:PageInput){return staff(this.store,ctx,patientId,page,this.options.codec,this.clock)}
  async read(ctx:RequestContext,id:string){return read(this.store,ctx,id)}
  list(ctx:RequestContext,patientId:string|undefined,page:PageInput,filter?:BookingFilter){return list(this.store,ctx,patientId,page,this.options.codec,filter)}
  transition(ctx:RequestContext,id:string,input:unknown){return transition(this.store,ctx,id,input,this.clock)}
  async request(ctx:RequestContext,patientId:string,input:unknown){
    const parsed=parseInput(input)
    currentIdentity(this.store,ctx.principal)
    if(ctx.principal.role!=='patient')throw new DomainError('forbidden')
    assertPatientScope(this.store,ctx.principal,patientId)
    const saved=await withIdempotency(this.store,{principalId:ctx.principal.id,method:'POST',resourceKey:`/patients/${patientId}/bookings`,key:ctx.idempotencyKey??'',payload:parsed},tx=>{
      currentIdentity(tx,ctx.principal);assertPatientScope(tx,ctx.principal,patientId)
      const service=tx.get<ServiceRow>('SELECT * FROM homecare_services WHERE id=? AND active=1',[parsed.serviceId])
      if(!service||Date.parse(parsed.preferredWindow.startAt)<=this.clock().getTime())throw new DomainError('validation_failed')
      const id=randomUUID(),now=this.clock().toISOString()
      tx.run(`INSERT INTO bookings(id,patient_id,service_id,service_snapshot_json,address_json,visit_note,preferred_start_at,preferred_end_at,
        preferred_timezone,status,version,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'Requested',1,?,?,?)`,
        [id,patientId,service.id,JSON.stringify(serviceProjection(service)),JSON.stringify(parsed.address),parsed.visitNote,
          parsed.preferredWindow.startAt,parsed.preferredWindow.endAt,parsed.preferredWindow.timezone,ctx.principal.id,now,now])
      tx.run('INSERT INTO booking_history VALUES (?,?,?,?,?,?,?,?,?)',[randomUUID(),id,1,null,'Requested',ctx.principal.id,now,null,null])
      return {resourceId:id,status:201,data:{id}}
    })
    return {resource:read(this.store,ctx,saved.resourceId),replayed:saved.replayed}
  }
}
