import type { Store } from '../../storage/database.ts'
import type { RequestContext } from '../contracts/errors.ts'
import { CursorCodec,seekBoundary,type PageInput } from '../contracts/pagination.ts'
import { authorizePlan } from '../plans/service.ts'
import { patientScope,requireCapability } from '../patients/service.ts'
import type { ReviewRow } from './contracts.ts'
import { readReview } from './registry.ts'
export class ReviewQueries {
  constructor(readonly store:Store,readonly codec:CursorCodec){}
  read(ctx:RequestContext,id:string){return readReview(this.store,ctx,id)}
  list(ctx:RequestContext,page:PageInput,patientId?:string){
    requireCapability(this.store,ctx.principal,'review.decide');if(patientId)authorizePlan(this.store,ctx,patientId)
    const ns=`${ctx.principal.id}:reviews:${patientId??'assigned'}`,boundary=page.cursor?seekBoundary(this.codec.decode(ns,page.cursor)):null,scope=patientScope(this.store,ctx.principal)
    const rows=this.store.all<ReviewRow>(`SELECT * FROM review_jobs WHERE patient_id IN (SELECT id FROM patients WHERE ${scope.sql})${patientId?' AND patient_id=?':''}${boundary?` AND ${boundary.sql}`:''} ORDER BY julianday(created_at) DESC,id DESC LIMIT ?`,[...scope.bindings,...(patientId?[patientId]:[]),...(boundary?.bindings??[]),page.limit+1])
    const items=rows.slice(0,page.limit).map(r=>readReview(this.store,ctx,r.id)),last=items.at(-1)
    return{items,nextCursor:rows.length>page.limit&&last?this.codec.encode(ns,last):null}
  }
}
