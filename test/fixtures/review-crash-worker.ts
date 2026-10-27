import { Database } from 'bun:sqlite'
import { Store } from '../../src/storage/database.ts'
const input=JSON.parse(await Bun.stdin.text()) as {statePath:string;canonicalPath:string;reviewId:string}
const store=Store.open({path:input.statePath}),row=store.get<{draft_id:string;session_id:string}>('SELECT * FROM review_jobs WHERE id=?',[input.reviewId])!
const draft=store.get<{artifact_json:string}>('SELECT * FROM care_plan_drafts WHERE id=?',[row.draft_id])!,decision=store.get<{actor_id:string;request_id:string;reviewer_note:string}>('SELECT * FROM review_decisions WHERE review_id=?',[input.reviewId])!
const db=new Database(input.canonicalPath,{create:true}),now=new Date().toISOString()
db.exec('CREATE TABLE approved_plans(plan_json TEXT,approved_at TEXT,reviewer_note TEXT);CREATE TABLE audit_log(action TEXT,actor TEXT,timestamp TEXT,payload TEXT)')
db.transaction(()=>{
  db.query('INSERT INTO approved_plans VALUES (?,?,?)').run(draft.artifact_json,now,decision.reviewer_note)
  db.query('INSERT INTO audit_log VALUES (?,?,?,?)').run('Approve',decision.actor_id,now,JSON.stringify({request_id:decision.request_id,session_id:row.session_id,decision:{action_id:'approve',actor:decision.actor_id,reviewer_note:decision.reviewer_note},plan_json:JSON.parse(draft.artifact_json)}))
})()
console.log(JSON.stringify({approvedAt:now,writer:'isolated-F4-boundary-fixture'}))
process.exit(17)
