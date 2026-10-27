import {readPrivateJson} from '../src/security/private-files.cjs'
import {createHash} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {loadConfig} from '../src/config.ts'
import {Store} from '../src/storage/database.ts'
const mode=process.argv[2],file=new URL('../data/m10-identity-restart-evidence.json',import.meta.url)
if(!['prepare','verify'].includes(mode??''))throw Error('choose_prepare_or_verify')
const fixture=readPrivateJson(new URL('../data/m10-fixtures-private.json',import.meta.url)),ids:string[]=fixture.patients.map((p:any)=>p.patientId),store=Store.open({path:loadConfig().consoleStateDbPath}),prior=mode==='verify'?readPrivateJson(file):null,q=ids.map(()=>'?').join(',')
try{
 const snapshot={patients:store.all(`SELECT * FROM patients WHERE id IN (${q}) ORDER BY id`,ids),assignments:store.all(`SELECT * FROM patient_assignments WHERE patient_id IN (${q}) ORDER BY id`,ids),links:store.all(`SELECT * FROM patient_account_links WHERE patient_id IN (${q}) ORDER BY patient_id`,ids),discharges:store.all(`SELECT * FROM discharge_versions WHERE patient_id IN (${q}) ORDER BY id`,ids),assessments:store.all(`SELECT * FROM assessments WHERE patient_id IN (${q}) ORDER BY id`,ids),confirmations:store.all(`SELECT * FROM risk_confirmations WHERE patient_id IN (${q}) ORDER BY id`,ids),reports:store.all(`SELECT * FROM checkins WHERE patient_id IN (${q}) ORDER BY id`,ids),processing:store.all(`SELECT * FROM processing_attempts WHERE checkin_id IN (SELECT id FROM checkins WHERE patient_id IN (${q})) ORDER BY id`,ids)}
 const sha256=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');if(prior&&prior.sha256!==sha256)throw Error('selected_snapshot_changed')
 const counts=Object.fromEntries(Object.entries(snapshot).map(([key,value])=>[key,value.length]));writeFileSync(file,JSON.stringify({...(prior??{preparedAt:new Date().toISOString()}),sha256,counts,...(mode==='verify'?{verifiedAt:new Date().toISOString()}:{} )},null,2));console.log(JSON.stringify({result:'PASS',mode,counts,sha256}));
}finally{store.close()}
