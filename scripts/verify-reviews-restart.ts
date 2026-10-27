import { Database } from 'bun:sqlite'
import { readFileSync,writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Store } from '../src/storage/database.ts'
import { loadConfig } from '../src/config.ts'
const mode=process.argv[2],file=new URL('../data/m08-restart-evidence.json',import.meta.url)
if(!['prepare','verify'].includes(mode??''))throw Error('choose_prepare_or_verify')
const prior=mode==='verify'?JSON.parse(readFileSync(file,'utf8')):null,config=loadConfig(),store=Store.open({path:config.consoleStateDbPath}),canonical=new Database(config.reviewDbPath,{readonly:true})
try{
  const ids:string[]=prior?.ids??store.all<{id:string}>('SELECT id FROM review_jobs ORDER BY id').map(r=>r.id)
  if(!ids.length)throw Error('no_actual_reviews')
  const q=ids.map(()=>'?').join(','),reviews=store.all<{session_id:string;draft_id:string}>(`SELECT * FROM review_jobs WHERE id IN (${q}) ORDER BY id`,ids),sessions=reviews.map(r=>r.session_id),sq=sessions.map(()=>'?').join(',')
  const snapshot={reviews,drafts:store.all(`SELECT * FROM care_plan_drafts WHERE id IN (SELECT draft_id FROM review_jobs WHERE id IN (${q})) OR source_review_id IN (${q}) ORDER BY id`,[...ids,...ids]),
    events:store.all(`SELECT * FROM review_events WHERE review_id IN (${q}) ORDER BY id`,ids),decisions:store.all(`SELECT * FROM review_decisions WHERE review_id IN (${q}) ORDER BY id`,ids),links:store.all(`SELECT * FROM approval_links WHERE review_id IN (${q}) ORDER BY id`,ids),
    receipts:store.all(`SELECT * FROM idempotency_receipts WHERE resource_id IN (${q}) OR resource_id IN (SELECT draft_id FROM review_jobs WHERE id IN (${q})) ORDER BY principal_id,method,resource_key,idempotency_key`,[...ids,...ids]),
    canonicalAudit:canonical.query(`SELECT rowid,* FROM audit_log WHERE CASE WHEN json_valid(payload) THEN json_extract(payload,'$.session_id') END IN (${sq}) ORDER BY rowid`).all(...sessions),
    canonicalPlans:canonical.query(`SELECT rowid,* FROM approved_plans WHERE approved_at IN (SELECT timestamp FROM audit_log WHERE action='Approve' AND CASE WHEN json_valid(payload) THEN json_extract(payload,'$.session_id') END IN (${sq})) ORDER BY rowid`).all(...sessions)}
  const sha256=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
  if(prior&&prior.sha256!==sha256)throw Error('selected_review_snapshot_changed')
  writeFileSync(file,JSON.stringify({...(prior??{ids,preparedAt:new Date().toISOString()}),sha256,verifiedAt:new Date().toISOString()},null,2))
  console.log(JSON.stringify({result:'PASS',mode,reviews:reviews.length,drafts:snapshot.drafts.length,events:snapshot.events.length,decisions:snapshot.decisions.length,links:snapshot.links.length,receipts:snapshot.receipts.length,canonicalAudit:snapshot.canonicalAudit.length,canonicalPlans:snapshot.canonicalPlans.length,sha256}))
}finally{store.close();canonical.close()}
