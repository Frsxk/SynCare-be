import { readFileSync,writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Store } from '../src/storage/database.ts'
import { loadConfig } from '../src/config.ts'
const file=new URL('../data/m07-restart-evidence.json',import.meta.url),mode=process.argv[2]
if(!['prepare','verify'].includes(mode??''))throw Error('choose_prepare_or_verify')
const store=Store.open({path:loadConfig().consoleStateDbPath})
try{
  const prior=mode==='verify'?JSON.parse(readFileSync(file,'utf8')) as {ids:string[];sha256:string}:null
  const ids=prior?.ids??(JSON.parse(readFileSync(new URL('../data/m07-live-evidence.json',import.meta.url),'utf8')) as {ids:string[]}).ids.sort()
  if(!ids.length)throw Error('no_actual_alerts')
  const q=ids.map(()=>'?').join(',')
  const snapshot={alerts:store.all(`SELECT * FROM alerts WHERE id IN (${q}) ORDER BY id`,ids),actions:store.all(`SELECT * FROM alert_actions WHERE alert_id IN (${q}) ORDER BY id`,ids),
    receipts:store.all(`SELECT * FROM idempotency_receipts WHERE resource_id IN (${q}) ORDER BY principal_id,method,resource_key,idempotency_key`,ids),
    reports:store.all(`SELECT * FROM checkins WHERE id IN (SELECT checkin_id FROM alerts WHERE id IN (${q})) ORDER BY id`,ids),
    attempts:store.all(`SELECT * FROM processing_attempts WHERE id IN (SELECT attempt_id FROM alerts WHERE id IN (${q})) ORDER BY id`,ids),
    work:store.all(`SELECT * FROM work_items WHERE kind IN ('CHECKIN_F2','ALERT_F2') AND source_key IN (SELECT checkin_id FROM alerts WHERE id IN (${q})) ORDER BY id`,ids)}
  if(snapshot.alerts.length!==ids.length||snapshot.reports.length!==ids.length||snapshot.attempts.length!==ids.length)throw Error('missing_trusted_records')
  const sha256=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
  if(prior&&prior.sha256!==sha256)throw Error('alert_snapshot_changed')
  writeFileSync(file,JSON.stringify(mode==='prepare'?{ids,sha256,preparedAt:new Date().toISOString()}:{...prior,verifiedAt:new Date().toISOString()},null,2))
  console.log(JSON.stringify({result:'PASS',mode,alerts:snapshot.alerts.length,actions:snapshot.actions.length,receipts:snapshot.receipts.length,reports:snapshot.reports.length,attempts:snapshot.attempts.length,work:snapshot.work.length,sha256}))
}finally{store.close()}
