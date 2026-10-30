import { expect,test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { database,account } from './fixture.ts'
import { loadMigrations } from '../../src/storage/migrations.ts'
import { AlertService } from '../../src/modules/alerts/actions.ts'
import { CursorCodec } from '../../src/modules/contracts/pagination.ts'

const T='2026-10-20T00:00:00.000Z',T2='2026-10-20T00:05:00.000Z',T3='2026-10-20T00:10:00.000Z'
const P1='legacy-patient-a',P2='legacy-patient-b',C1='legacy-checkin-a',C2='legacy-checkin-b',A1='legacy-attempt-a',A2='legacy-attempt-b'
const E1='legacy-alert-pending',E2='legacy-alert-ack',K1='legacy-action-created-a',K2='legacy-action-created-b',K3='legacy-action-ack-b'
const alertColumns=['id','patient_id','checkin_id','attempt_id','source_type','source_action','reason','reported_at','source_at','status','version','acknowledged_at','resolved_at','created_at','updated_at']

async function legacyEight(){
  const {store,reopen}=await database(8)
  await account(store,'patient-a')
  await account(store,'patient-b')
  await account(store,'nurse-a','nurse')
  await account(store,'operator','nurse')
  await store.transaction(tx=>{
    tx.run('UPDATE accounts SET active=1')
    for(const [id,name] of [[P1,'Legacy A'],[P2,'Legacy B']] as const) tx.run(
      'INSERT INTO patients(id,profile_json,recorded_condition,version,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      [id,JSON.stringify({displayName:name}),null,1,'operator','operator',T,T])
    tx.run('INSERT INTO patient_account_links VALUES (?,?,?,?)',[P1,'patient-a','operator',T])
    tx.run('INSERT INTO patient_account_links VALUES (?,?,?,?)',[P2,'patient-b','operator',T])
    tx.run('INSERT INTO patient_assignments VALUES (?,?,?,?,?,?,?)',[randomUUID(),P1,'nurse-a','operator',T,null,null])
    tx.run('INSERT INTO capability_grants VALUES (?,?,?,?,?,?,?)',[randomUUID(),'nurse-a','alert.manage','operator',T,null,null])
    for(const [checkin,attempt,session] of [[C1,A1,'legacy-session-a'],[C2,A2,'legacy-session-b']] as const){
      tx.run('INSERT INTO checkins(id,patient_id,submitted_by,message,created_at,version) VALUES (?,?,?,?,?,1)',[checkin,P1,'patient-a','Legacy synthetic report',T])
      tx.run(`INSERT INTO processing_attempts(id,checkin_id,session_id,state,version,created_at,updated_at,output_json,raw_json,failure_code)
        VALUES (?,?,?,'SUCCEEDED',3,?,?,?,?,NULL)`,[attempt,checkin,session,T,T2,JSON.stringify({action:'escalate_immediately',reason:'Alasan F2 lama'}),JSON.stringify({synthetic:true})])
    }
    tx.run(`INSERT INTO alerts(${alertColumns.join(',')}) VALUES (?,?,?,?,'F2','escalate_immediately',?,?,?,'PENDING_REVIEW',1,NULL,NULL,?,?)`,
      [E1,P1,C1,A1,'Alasan F2 lama',T,T2,T2,T2])
    tx.run(`INSERT INTO alerts(${alertColumns.join(',')}) VALUES (?,?,?,?,'F2','escalate_immediately',?,?,?,'PENDING_REVIEW',1,NULL,NULL,?,?)`,
      [E2,P1,C2,A2,'Alasan F2 lama',T,T2,T2,T2])
    tx.run("INSERT INTO alert_actions VALUES (?,?,1,'created',NULL,'PENDING_REVIEW',NULL,?,?,NULL,NULL,NULL)",[K1,E1,T2,T2])
    tx.run("INSERT INTO alert_actions VALUES (?,?,1,'created',NULL,'PENDING_REVIEW',NULL,?,?,NULL,NULL,NULL)",[K2,E2,T2,T2])
    tx.run("UPDATE alerts SET status='ACKNOWLEDGED',version=2,acknowledged_at=?,updated_at=? WHERE id=?",[T3,T3,E2])
    tx.run("INSERT INTO alert_actions VALUES (?,?,2,'acknowledge','PENDING_REVIEW','ACKNOWLEDGED','nurse-a',?,?,NULL,'Legacy nurse note',NULL)",[K3,E2,T3,T3])
  })
  return {store,reopen}
}

test('0009 rebuild preserves legacy F2 alert/action ids, evidence, timestamps and foreign keys',async()=>{
  const {store,reopen}=await legacyEight()
  const beforeAlerts=store.all<Record<string,unknown>>(`SELECT ${alertColumns.join(',')} FROM alerts ORDER BY id`)
  const beforeActions=store.all<Record<string,unknown>>('SELECT * FROM alert_actions ORDER BY alert_id,version')
  expect(beforeAlerts).toHaveLength(2)
  expect(beforeActions).toHaveLength(3)
  expect(store.diagnostics().schemaVersion).toBe(8)
  await store.migrate(loadMigrations())
  expect(store.diagnostics().schemaVersion).toBe(9)
  expect(store.all(`SELECT ${alertColumns.join(',')} FROM alerts ORDER BY id`)).toEqual(beforeAlerts)
  expect(store.all('SELECT * FROM alert_actions ORDER BY alert_id,version')).toEqual(beforeActions)
  expect(store.all('PRAGMA foreign_key_check')).toEqual([])
  expect(store.get<{integrity_check:string}>('PRAGMA integrity_check')).toEqual({integrity_check:'ok'})
  expect(store.all<{table:string}>('PRAGMA foreign_key_list(alert_actions)').map(row=>row.table).sort()).toEqual(['accounts','alerts'])
  expect(store.all<{table:string}>('PRAGMA foreign_key_list(alerts)').map(row=>row.table).sort()).toEqual(['accounts','checkins','patients','processing_attempts'])
  const indexes=store.all<{name:string}>("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('alerts','alert_actions') AND name NOT LIKE 'sqlite_autoindex%'").map(row=>row.name).sort()
  expect(indexes).toEqual(['alert_actions_order','alerts_patient_order','alerts_status_order'])
  expect(store.get<{sql:string}>("SELECT sql FROM sqlite_master WHERE name='alerts'")?.sql).toContain("'PATIENT_REQUEST'")
  expect(store.all<{name:string}>("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('alerts','alert_actions')").map(row=>row.name).sort())
    .toEqual(['alert_action_current','alert_action_no_delete','alert_action_no_update','alert_no_delete','alert_source_immutable','alert_trusted_source'])
  const service=new AlertService(store,{codec:new CursorCodec('legacy-migration-cursor-secret-longer-than-32'),clock:()=>new Date(T3)})
  const nurseCtx={principal:{id:'nurse-a',role:'nurse' as const,capabilities:[]},requestId:randomUUID()}
  const pending=service.read(nurseCtx,E1)
  expect(pending.source).toEqual({type:'F2',reportId:C1,attemptId:A1,action:'escalate_immediately',reason:'Alasan F2 lama',reportedAt:T,outcomeAt:T2})
  expect(pending.status).toBe('PENDING_REVIEW')
  expect(pending.timeline.map(item=>item.id)).toEqual([K1])
  const acknowledged=service.read(nurseCtx,E2)
  expect(acknowledged.source.type).toBe('F2')
  expect(acknowledged.status).toBe('ACKNOWLEDGED')
  expect(acknowledged.version).toBe(2)
  expect(acknowledged.timeline.map(item=>item.id)).toEqual([K2,K3])
  await store.migrate();await store.migrate();store.close()
  const restored=reopen()
  await restored.migrate()
  expect(restored.diagnostics().schemaVersion).toBe(9)
  expect(restored.all(`SELECT ${alertColumns.join(',')} FROM alerts ORDER BY id`)).toEqual(beforeAlerts)
  expect(restored.all('SELECT * FROM alert_actions ORDER BY alert_id,version')).toEqual(beforeActions)
})

test('0009 accepts only discriminated F2/PATIENT_REQUEST rows and keeps history/authority constraints',async()=>{
  const {store}=await legacyEight()
  await store.migrate(loadMigrations())
  const insert=(values:unknown[])=>store.transaction(tx=>tx.run(`INSERT INTO alerts(id,patient_id,checkin_id,attempt_id,source_type,source_action,reason,reported_at,source_at,status,version,created_at,updated_at,request_origin,requested_by)
    VALUES (?,?,?,?,?,?,?,?,?,'PENDING_REVIEW',1,?,?,?,?)`,values as never))
  await expect(insert(['bad-f2-null',P1,null,null,'F2','escalate_immediately','x',T,T,T,T,null,null])).rejects.toThrow()
  await expect(insert(['bad-request-checkin',P1,C1,null,'PATIENT_REQUEST','request_immediate_help','x',T,T,T,T,'patient_status_page','patient-a'])).rejects.toThrow()
  await expect(insert(['bad-source',P1,null,null,'F3','escalate_immediately','x',T,T,T,T,null,null])).rejects.toThrow()
  await expect(insert(['bad-unlinked',P1,null,null,'PATIENT_REQUEST','request_immediate_help','x',T,T,T,T,'patient_status_page','patient-b'])).rejects.toThrow()
  await expect(insert(['bad-origin',P1,null,null,'PATIENT_REQUEST','request_immediate_help','x',T,T,T,T,null,'patient-a'])).rejects.toThrow()
  await expect(insert(['bad-long',P1,null,null,'PATIENT_REQUEST','request_immediate_help','x'.repeat(8001),T,T,T,T,'patient_status_page','patient-a'])).rejects.toThrow()
  await expect(store.transaction(tx=>tx.run("DELETE FROM alerts WHERE id=?",[E1]))).rejects.toThrow()
  await expect(store.transaction(tx=>tx.run("UPDATE alerts SET reason='changed',version=2 WHERE id=?",[E1]))).rejects.toThrow()
  await expect(store.transaction(tx=>tx.run("UPDATE alerts SET requested_by='patient-b',version=2 WHERE id=?",[E1]))).rejects.toThrow()
  expect(store.all('SELECT * FROM alerts')).toHaveLength(2)
  await store.transaction(tx=>{
    tx.run(`INSERT INTO alerts(id,patient_id,checkin_id,attempt_id,source_type,source_action,reason,reported_at,source_at,status,version,created_at,updated_at,request_origin,requested_by)
      VALUES (?,?,NULL,NULL,'PATIENT_REQUEST','request_immediate_help','Permintaan pasien',?,?,'PENDING_REVIEW',1,?,?,'patient_status_page','patient-a')`,
      ['new-request',P1,T,T,T,T])
    tx.run("INSERT INTO alert_actions VALUES (?,?,1,'created',NULL,'PENDING_REVIEW',NULL,?,?,NULL,NULL,NULL)",[randomUUID(),'new-request',T,T])
  })
  const service=new AlertService(store,{codec:new CursorCodec('legacy-migration-cursor-secret-longer-than-32'),clock:()=>new Date(T3)})
  const created=await service.requestEmergency({principal:{id:'patient-a',role:'patient',capabilities:[]},requestId:randomUUID(),idempotencyKey:randomUUID()},P1,{reason:'Nyeri dada'})
  expect(created.resource.source).toMatchObject({type:'PATIENT_REQUEST',action:'request_immediate_help',reason:'Nyeri dada'})
  expect(created.resource.status).toBe('PENDING_REVIEW')
  expect(store.all("SELECT * FROM alerts WHERE source_type='PATIENT_REQUEST'")).toHaveLength(2)
})
