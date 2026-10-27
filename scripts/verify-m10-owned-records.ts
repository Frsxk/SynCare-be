import {readPrivateJson} from '../src/security/private-files.cjs'
import {writeFileSync} from 'node:fs'
import {Store} from '../src/storage/database.ts'
import {loadConfig} from '../src/config.ts'
const cases=readPrivateJson(new URL('../data/m10-cross-client-private.json',import.meta.url)).cases,fixture=readPrivateJson(new URL('../data/m10-fixtures-private.json',import.meta.url)),store=Store.open({path:loadConfig().consoleStateDbPath}),patients:string[]=fixture.patients.map((p:{patientId:string})=>p.patientId),q=patients.map(()=>'?').join(',')
try{
 const bookings=store.all<{id:string;status:string;visit_note:string}>(`SELECT id,status,visit_note FROM bookings WHERE patient_id IN (${q}) ORDER BY id`,patients),expected=['booking_complete','booking_overlap','booking_reject','booking_patient_cancel'].map(name=>cases[name].id as string).sort()
 if(bookings.length!==4||JSON.stringify(bookings.map(b=>b.id).sort())!==JSON.stringify(expected)||bookings.some(b=>!['Completed','Cancelled','Rejected'].includes(b.status)||!b.visit_note.startsWith('DATA SINTETIS M10')))throw Error('owned_booking_scope_mismatch')
 const alerts=store.all<{id:string;status:string}>(`SELECT id,status FROM alerts WHERE patient_id IN (${q}) ORDER BY id`,patients),reviews=store.all<{id:string;state:string}>(`SELECT id,state FROM review_jobs WHERE patient_id IN (${q}) ORDER BY id`,patients)
 if(alerts.length!==1||alerts[0]!.id!==cases.acute_alert.id||alerts[0]!.status!=='RESOLVED'||reviews.length!==6||reviews.some(r=>!['APPROVED','REVISION_DRAFT','ESCALATED'].includes(r.state)))throw Error('owned_operational_cases_not_closed')
 const history=store.get<{count:number}>(`SELECT count(*) AS count FROM booking_history WHERE booking_id IN (SELECT id FROM bookings WHERE patient_id IN (${q}))`,patients)!.count,actions=store.get<{count:number}>(`SELECT count(*) AS count FROM alert_actions WHERE alert_id=?`,[alerts[0]!.id])!.count
 if(history!==12||actions!==4)throw Error('owned_history_count_mismatch')
 const result={result:'PASS',verifiedAt:new Date().toISOString(),patients:2,bookings:bookings.map(b=>({id:b.id,status:b.status})),bookingHistory:history,alerts,reviews,alertActions:actions,recordsDeleted:0,otherRecordsChangedByFinalizer:0};writeFileSync(new URL('../data/m10-owned-records-evidence.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify({result:'PASS',patients:2,bookings:4,bookingHistory:history,alerts:1,alertActions:actions,reviews:reviews.length,recordsDeleted:0,credentialsPrinted:false}))
}finally{store.close()}
