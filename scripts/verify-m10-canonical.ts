import {readPrivateJson} from '../src/security/private-files.cjs'
import {Database} from 'bun:sqlite'
import {existsSync,writeFileSync} from 'node:fs'
import {loadConfig} from '../src/config.ts'
import {Store} from '../src/storage/database.ts'
import {ApprovalEvidenceReader} from '../src/modules/reviews/approval-evidence.ts'
import type {ReviewRow,DecisionRow} from '../src/modules/reviews/contracts.ts'
import type {DraftRow} from '../src/modules/plans/contracts.ts'
const id=process.argv[2];if(!id||!/^[a-zA-Z0-9_-]+$/.test(id))throw Error('owned_review_id_required')
const config=loadConfig(),store=Store.open({path:config.consoleStateDbPath}),db=new Database(config.reviewDbPath,{readonly:true}),file=new URL('../data/m10-canonical-evidence.json',import.meta.url)
try{
 const review=store.get<ReviewRow>('SELECT * FROM review_jobs WHERE id=?',[id]);if(!review||review.state!=='APPROVED')throw Error('not_approved')
 const fixture=readPrivateJson(new URL('../data/m10-fixtures-private.json',import.meta.url));if(!fixture.patients.some((p:{patientId:string})=>p.patientId===review.patient_id))throw Error('not_owned_m10_patient')
 const draft=store.get<DraftRow>('SELECT * FROM care_plan_drafts WHERE id=?',[review.draft_id])!,decision=store.get<DecisionRow>('SELECT * FROM review_decisions WHERE review_id=?',[id])!,proof=new ApprovalEvidenceReader(config.reviewDbPath).match(review,draft,decision),links=store.all<{fingerprint:string}>('SELECT * FROM approval_links WHERE review_id=?',[id])
 if(!proof||links.length!==1||links[0]!.fingerprint!==proof.fingerprint)throw Error('exact_proof_missing')
 const audits=db.query(`SELECT rowid,* FROM audit_log WHERE CASE WHEN json_valid(payload) THEN json_extract(payload,'$.session_id') END=?`).all(review.session_id),plans=db.query('SELECT rowid,* FROM approved_plans WHERE approved_at=?').all(proof.approvedAt)
 if(audits.length!==1||plans.length!==1)throw Error('canonical_not_single_effect')
 const evidence=existsSync(file)?readPrivateJson(file):{};evidence[id]={verifiedAt:new Date().toISOString(),review,decision,draft,proof,links,audits,plans};writeFileSync(file,JSON.stringify(evidence,null,2));console.log(JSON.stringify({result:'PASS',canonicalAudit:1,canonicalFullRow:1,registeredLink:1,fullPlanAndActorMatched:true,credentialsPrinted:false}))
}finally{db.close();store.close()}
