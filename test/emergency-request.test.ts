import { expect,test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { alertFixture } from './alert-fixture.ts'
import { AlertService } from '../src/modules/alerts/actions.ts'

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const emergency=(f:Awaited<ReturnType<typeof alertFixture>>,patientId:string,reason:string,key=randomUUID(),accountId=patientId===f.first.id?'patient-a':'patient-b')=>
  f.alerts.requestEmergency({...f.ctx(accountId),idempotencyKey:key},patientId,{reason})

test('patient emergency writes an immediate durable alert without F1 baseline, F2 call, work item or dispatch claim',async()=>{
  const f=await alertFixture()
  const beforeAttempts=f.store.all('SELECT * FROM processing_attempts').length
  const beforeWork=f.store.all("SELECT * FROM work_items WHERE kind='ALERT_F2'").length
  const saved=await emergency(f,f.second.id,'  Nyeri dada hebat  ')
  expect(saved.replayed).toBe(false)
  const alert=saved.resource
  expect(Object.keys(alert).sort()).toEqual(['acknowledgedAt','createdAt','id','patientId','resolvedAt','source','status','timeline','timelineNextCursor','updatedAt','urgency','version'])
  expect(alert.source).toMatchObject({type:'PATIENT_REQUEST',action:'request_immediate_help',reason:'Nyeri dada hebat'})
  expect(uuid.test(alert.source.type==='PATIENT_REQUEST'?alert.source.requestId:'')).toBe(true)
  expect(alert.source.type==='PATIENT_REQUEST'?alert.source.requestId:'').toBe(alert.id)
  expect(alert.source.reportedAt).toBe(alert.source.outcomeAt)
  expect(alert.urgency).toBe('acute')
  expect(alert.status).toBe('PENDING_REVIEW')
  expect(alert.version).toBe(1)
  expect(alert.acknowledgedAt).toBeNull()
  expect(alert.timeline).toHaveLength(1)
  expect(alert.timeline[0]).toMatchObject({version:1,status:'PENDING_REVIEW',patientSummary:null})
  const row=f.store.get<Record<string,unknown>>("SELECT * FROM alerts WHERE id=?",[alert.id])!
  expect(row).toMatchObject({patient_id:f.second.id,checkin_id:null,attempt_id:null,source_type:'PATIENT_REQUEST',
    source_action:'request_immediate_help',reason:'Nyeri dada hebat',request_origin:'patient_status_page',requested_by:'patient-b',status:'PENDING_REVIEW',version:1})
  expect(f.store.all('SELECT * FROM processing_attempts')).toHaveLength(beforeAttempts)
  expect(f.store.all("SELECT * FROM work_items WHERE kind='ALERT_F2'")).toHaveLength(beforeWork)
  expect(JSON.stringify(alert)).not.toMatch(/dispatch|ambulance|dikirim|terkirim/i)
})

test('emergency authorization is authenticated patient own-scope only; server identity cannot be forged',async()=>{
  const f=await alertFixture()
  await expect(emergency(f,f.second.id,'Nyeri',randomUUID(),'patient-a')).rejects.toMatchObject({code:'not_found',status:404})
  await expect(f.alerts.requestEmergency(f.ctx('nurse-a'),f.first.id,{reason:'Nyeri'})).rejects.toMatchObject({code:'forbidden',status:403})
  const forged={...f.ctx('patient-a'),principal:{id:'patient-a',role:'nurse' as const,capabilities:['alert.manage']}}
  await expect(f.alerts.requestEmergency(forged,f.first.id,{reason:'Nyeri'})).rejects.toMatchObject({code:'unauthenticated',status:401})
  const keyless={...f.ctx('patient-a'),idempotencyKey:undefined}
  await expect(f.alerts.requestEmergency(keyless,f.first.id,{reason:'Nyeri'})).rejects.toMatchObject({code:'validation_failed',status:422})
  expect(f.store.all('SELECT * FROM alerts')).toHaveLength(0)
})

test('emergency body is strict: reason only, trimmed non-empty, 8000 code points',async()=>{
  const f=await alertFixture()
  for(const body of [{},{reason:''},{reason:'   '},{reason:42},{reason:'ok',extra:1},null,[],{reason:'ok',reason2:'x'}])
    await expect(f.alerts.requestEmergency(f.ctx('patient-a'),f.first.id,body)).rejects.toMatchObject({code:'validation_failed'})
  await expect(f.alerts.requestEmergency(f.ctx('patient-a'),f.first.id,{reason:'x'.repeat(8001)})).rejects.toMatchObject({code:'validation_failed'})
  expect(f.store.all('SELECT * FROM alerts')).toHaveLength(0)
  const max=await f.alerts.requestEmergency(f.ctx('patient-a'),f.first.id,{reason:'x'.repeat(8000)})
  expect((max.resource.source.type==='PATIENT_REQUEST'?max.resource.source.reason:'').length).toBe(8000)
  const trimmed=await f.alerts.requestEmergency(f.ctx('patient-b'),f.second.id,{reason:'  Sesak napas  '})
  expect(trimmed.resource.source.reason).toBe('Sesak napas')
  expect(f.store.all('SELECT * FROM alerts')).toHaveLength(2)
})

test('emergency idempotency replays one receipt, conflicts on changed body, and never blocks a later legitimate request',async()=>{
  const f=await alertFixture(),key=randomUUID()
  const first=await emergency(f,f.first.id,'Nyeri dada',key)
  expect((await emergency(f,f.first.id,'Nyeri dada',key)).replayed).toBe(true)
  expect((await emergency(f,f.first.id,'Nyeri dada',key)).resource.id).toBe(first.resource.id)
  expect(f.store.all('SELECT * FROM alerts')).toHaveLength(1)
  await expect(emergency(f,f.first.id,'Alasan berbeda',key)).rejects.toMatchObject({code:'idempotency_conflict',status:409})
  const freshKey=randomUUID()
  const [duplicateA,duplicateB]=await Promise.all([emergency(f,f.first.id,'Nyeri dada',freshKey),emergency(f,f.first.id,'Nyeri dada',freshKey)])
  expect(new Set([duplicateA.resource.id,duplicateB.resource.id]).size).toBe(1)
  expect([duplicateA.replayed,duplicateB.replayed].filter(Boolean)).toHaveLength(1)
  const next=await emergency(f,f.first.id,'Nyeri dada',randomUUID())
  expect(next.resource.id).not.toBe(first.resource.id)
  expect(f.store.all('SELECT * FROM alerts')).toHaveLength(3)
})

test('nurse queue shows both sources; existing lifecycle/action permissions and patient privacy stay intact',async()=>{
  const f=await alertFixture(),f2=await f.create()
  const requested=await emergency(f,f.first.id,'Sesak dan pusing')
  expect(f2.alert.source.type).toBe('F2')
  expect(f.alerts.list(f.ctx(),undefined,{limit:20}).items.map(item=>item.source.type).sort()).toEqual(['F2','PATIENT_REQUEST'])
  const patientView=await f.alerts.read(f.ctx('patient-a'),requested.resource.id)
  expect(JSON.stringify(patientView)).not.toContain('internalNote')
  await expect(f.alerts.act(f.ctx('patient-a'),requested.resource.id,{action:'acknowledge',expectedVersion:1})).rejects.toMatchObject({code:'forbidden'})
  await expect(f.alerts.act(f.ctx('nurse-b'),requested.resource.id,{action:'acknowledge',expectedVersion:1})).rejects.toMatchObject({code:'not_found'})
  const ack=await f.alerts.act(f.ctx('nurse-a'),requested.resource.id,{action:'acknowledge',expectedVersion:1,note:'Catatan internal rahasia'})
  expect(ack.resource.status).toBe('ACKNOWLEDGED')
  expect(JSON.stringify(await f.alerts.read(f.ctx('patient-a'),requested.resource.id))).not.toContain('Catatan internal rahasia')
  expect(JSON.stringify(await f.alerts.read(f.ctx('nurse-a'),requested.resource.id))).toContain('Catatan internal rahasia')
  const follow=await f.alerts.act(f.ctx('nurse-a'),requested.resource.id,{action:'follow_up',expectedVersion:2,note:'Menghubungi pasien',
    patientSummary:'Petugas sedang menindaklanjuti permintaan Anda.',actionType:'contact_attempt',occurredAt:f.clock().toISOString()})
  expect(follow.resource.status).toBe('IN_PROGRESS')
  expect(JSON.stringify(await f.alerts.read(f.ctx('patient-a'),requested.resource.id))).toContain('Petugas sedang menindaklanjuti permintaan Anda.')
  expect(JSON.stringify(await f.alerts.read(f.ctx('patient-a'),requested.resource.id))).not.toContain('Menghubungi pasien')
  const resolved=await f.alerts.act(f.ctx('nurse-a'),requested.resource.id,{action:'resolve',expectedVersion:3,note:'Selesai ditindaklanjuti'})
  expect(resolved.resource.status).toBe('RESOLVED')
  expect(f.alerts.read(f.ctx('nurse-a'),f2.alert.id).source.type).toBe('F2')
  const later=await emergency(f,f.first.id,'Keluhan baru setelah penutupan')
  expect(later.resource.status).toBe('PENDING_REVIEW')
  expect(f.alerts.list(f.ctx(),undefined,{limit:20}).items).toHaveLength(3)
  expect(new AlertService(f.store,{codec:f.codec,clock:f.clock}).read(f.ctx('nurse-a'),requested.resource.id).source.type).toBe('PATIENT_REQUEST')
})
