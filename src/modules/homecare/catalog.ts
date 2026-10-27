import type { Store,Transaction } from '../../storage/database.ts'
import type { RequestContext } from '../contracts/errors.ts'
import { CursorCodec,seekBoundary,type Page,type PageInput } from '../contracts/pagination.ts'
import { currentIdentity } from '../patients/service.ts'
import { CITIES,TIMEZONE,type Service } from './contracts.ts'

export interface ServiceRow {id:string;name:string;description:string;active:number;version:number;created_at:string}
export const serviceProjection=(row:ServiceRow):Service=>({id:row.id,name:row.name,description:row.description,version:row.version,
  synthetic:true,coverageProvince:'DKI Jakarta',coverageCities:CITIES,timezone:TIMEZONE})
export async function catalog(store:Store,ctx:RequestContext,page:PageInput,codec:CursorCodec):Promise<Page<Service>>{
  currentIdentity(store,ctx.principal)
  const scope=`homecare-catalog:${ctx.principal.id}`
  const boundary=page.cursor?seekBoundary(codec.decode(scope,page.cursor)):null
  const rows=store.all<ServiceRow>(`SELECT * FROM homecare_services WHERE active=1 ${boundary?`AND ${boundary.sql}`:''}
    ORDER BY julianday(created_at) DESC,id DESC LIMIT ?`,[...(boundary?.bindings??[]),page.limit+1])
  const items=rows.slice(0,page.limit),last=items.at(-1)
  return {items:items.map(serviceProjection),nextCursor:rows.length>page.limit&&last?codec.encode(scope,{id:last.id,createdAt:last.created_at}):null}
}
export async function seedDemoCatalog(store:Store):Promise<void>{
  await store.transaction((tx:Transaction)=>tx.run(`INSERT INTO homecare_services(id,name,description,active,version,created_at)
    VALUES (?,?,?,1,1,?) ON CONFLICT(id) DO NOTHING`,['post-discharge-nurse-demo','Kunjungan perawat pascapulang (simulasi)',
    'Permintaan kunjungan perawat untuk tindak lanjut pascapulang di DKI Jakarta. Seluruh proses merupakan simulasi; pengajuan tidak mengirim petugas atau memastikan jadwal.',new Date().toISOString()]))
}
