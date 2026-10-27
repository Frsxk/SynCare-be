import { readFileSync,writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Store } from '../src/storage/database.ts'
import { loadConfig } from '../src/config.ts'
const file=new URL('../data/m04-restart-evidence.json',import.meta.url)
const mode=process.argv[2]
if(!['prepare','verify'].includes(mode??''))throw Error('choose_prepare_or_verify')
const store=Store.open({path:loadConfig().consoleStateDbPath})
try{
  const prior=mode==='verify'?JSON.parse(readFileSync(file,'utf8')) as {ids:string[];sha256:string}:null
  const ids=prior?.ids??store.all<{id:string}>('SELECT id FROM checkins ORDER BY id').map(r=>r.id)
  if(!ids.length)throw Error('no_actual_reports')
  const placeholders=ids.map(()=>'?').join(',')
  const snapshot={
    reports:store.all(`SELECT * FROM checkins WHERE id IN (${placeholders}) ORDER BY id`,ids),
    attempts:store.all(`SELECT * FROM processing_attempts WHERE checkin_id IN (${placeholders}) ORDER BY id`,ids),
    work:store.all(`SELECT * FROM work_items WHERE kind IN ('CHECKIN_F2','ALERT_F2') AND source_key IN (${placeholders}) ORDER BY id`,ids),
  }
  const sha256=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
  if(prior&&sha256!==prior.sha256)throw Error('restart_snapshot_changed')
  if(mode==='prepare')writeFileSync(file,JSON.stringify({ids,sha256,preparedAt:new Date().toISOString()},null,2))
  else writeFileSync(file,JSON.stringify({...prior,verifiedAt:new Date().toISOString()},null,2))
  console.log(JSON.stringify({mode,result:'PASS',reports:snapshot.reports.length,attempts:snapshot.attempts.length,work:snapshot.work.length,sha256}))
}finally{store.close()}
