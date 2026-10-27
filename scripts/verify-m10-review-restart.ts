import {readPrivateJson} from '../src/security/private-files.cjs'
import {Database} from 'bun:sqlite'
import {writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {Store} from '../src/storage/database.ts'
import {loadConfig} from '../src/config.ts'
const mode=process.argv[2],file=new URL('../data/m10-review-restart-evidence.json',import.meta.url)
if(!['prepare','verify'].includes(mode??''))throw Error('choose_prepare_or_verify')
const prior=mode==='verify'?readPrivateJson(file):null,config=loadConfig(),store=Store.open({path:config.consoleStateDbPath}),canonical=new Database(config.reviewDbPath,{readonly:true}),fixture=readPrivateJson(new URL('../data/m10-fixtures-private.json',import.meta.url))
try{
 const patients:string[]=fixture.patients.map((p:{patientId:string})=>p.patientId),pq=patients.map(()=>'?').join(','),ids:string[]=prior?.ids??store.all<{id:string}>(`SELECT id FROM review_jobs WHERE patient_id IN (${pq}) ORDER BY id`,patients).map(r=>r.id)
 if(ids.length!==5)throw Error('five_owned_review_records_required')
 const q=ids.map(()=>'?').join(','),reviews=store.all<{session_id:string;draft_id:string}>(`SELECT * FROM review_jobs WHERE id IN (${q}) ORDER BY id`,ids),sessions=reviews.map(r=>r.session_id),sq=sessions.map(()=>'?').join(',')
 const snapshot={reviews,drafts:store.all(`SELECT * FROM care_plan_drafts WHERE patient_id IN (${pq}) ORDER BY id`,patients),events:store.all(`SELECT * FROM review_events WHERE review_id IN (${q}) ORDER BY id`,ids),decisions:store.all(`SELECT * FROM review_decisions WHERE review_id IN (${q}) ORDER BY id`,ids),links:store.all(`SELECT * FROM approval_links WHERE review_id IN (${q}) ORDER BY id`,ids),receipts:store.all(`SELECT * FROM idempotency_receipts WHERE resource_id IN (${q}) OR resource_id IN (SELECT id FROM care_plan_drafts WHERE patient_id IN (${pq})) ORDER BY principal_id,method,resource_key,idempotency_key`,[...ids,...patients]),canonicalAudit:canonical.query(`SELECT rowid,* FROM audit_log WHERE CASE WHEN json_valid(payload) THEN json_extract(payload,'$.session_id') END IN (${sq}) ORDER BY rowid`).all(...sessions),canonicalPlans:canonical.query(`SELECT rowid,* FROM approved_plans WHERE approved_at IN (SELECT timestamp FROM audit_log WHERE action='Approve' AND CASE WHEN json_valid(payload) THEN json_extract(payload,'$.session_id') END IN (${sq})) ORDER BY rowid`).all(...sessions)}
 const sha256=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');if(prior&&sha256!==prior.sha256)throw Error('selected_review_snapshot_changed')
 const counts=Object.fromEntries(Object.entries(snapshot).map(([name,rows])=>[name,rows.length]));writeFileSync(file,JSON.stringify({...(prior??{ids,preparedAt:new Date().toISOString()}),sha256,counts,...(mode==='verify'?{verifiedAt:new Date().toISOString()}:{} )},null,2));console.log(JSON.stringify({result:'PASS',mode,counts,sha256}))
}finally{store.close();canonical.close()}
