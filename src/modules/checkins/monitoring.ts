import type { Store } from '../../storage/database.ts'
import { DomainError,type RequestContext } from '../contracts/errors.ts'
import { CursorCodec,seekBoundary,type Page,type PageInput } from '../contracts/pagination.ts'
import { currentIdentity,patientScope } from '../patients/service.ts'
import type { CheckinRecord } from './contracts.ts'
export interface MonitoringRow {id:string;createdAt:string;profile:{displayName:string};latestReport:CheckinRecord|null}
export function monitoringRows(store:Store,codec:CursorCodec,ctx:RequestContext,input:PageInput,latest:(patientId:string)=>CheckinRecord|null):Page<MonitoringRow>{
  if(currentIdentity(store,ctx.principal).role!=='nurse')throw new DomainError('forbidden')
  if(!Number.isInteger(input.limit)||input.limit<1||input.limit>100)throw new DomainError('validation_failed')
  const namespace=`${ctx.principal.id}:monitoring`,scope=patientScope(store,ctx.principal)
  const boundary=input.cursor?seekBoundary(codec.decode(namespace,input.cursor)):null
  const rows=store.all<{id:string;profile_json:string;created_at:string}>(`SELECT id,profile_json,created_at FROM patients WHERE ${scope.sql}
    ${boundary?`AND ${boundary.sql}`:''} ORDER BY julianday(created_at) DESC,id DESC LIMIT ?`,[...scope.bindings,...(boundary?.bindings??[]),input.limit+1])
  const items=rows.slice(0,input.limit).map(row=>({id:row.id,createdAt:row.created_at,profile:{displayName:(JSON.parse(row.profile_json) as {displayName:string}).displayName},latestReport:latest(row.id)}))
  const last=items.at(-1)
  return{items,nextCursor:rows.length>input.limit&&last?codec.encode(namespace,last):null}
}
