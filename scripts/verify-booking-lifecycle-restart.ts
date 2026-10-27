import { readFileSync,writeFileSync,existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Store } from '../src/storage/database.ts'
import { loadConfig } from '../src/config.ts'
const file=new URL('../data/m06-restart-evidence.json',import.meta.url),mode=process.argv[2]
if(!['prepare','verify'].includes(mode??''))throw Error('choose_prepare_or_verify')
const store=Store.open({path:loadConfig().consoleStateDbPath})
try{
  const prior=mode==='verify'?JSON.parse(readFileSync(file,'utf8')) as {ids:string[];sha256:string}:null
  const live=JSON.parse(readFileSync(new URL('../data/m06-live-evidence.json',import.meta.url),'utf8')) as {ids:string[]}
  const productionFile=new URL('../data/m06-production-evidence.json',import.meta.url)
  const production=existsSync(productionFile)?JSON.parse(readFileSync(productionFile,'utf8')) as {id:string}:null
  const ids=prior?.ids??[...new Set([...live.ids,...(production?[production.id]:[])])].sort()
  if(!ids.length)throw Error('no_actual_lifecycle_records')
  const q=ids.map(()=>'?').join(',')
  const snapshot={bookings:store.all(`SELECT * FROM bookings WHERE id IN (${q}) ORDER BY id`,ids),history:store.all(`SELECT * FROM booking_history WHERE booking_id IN (${q}) ORDER BY id`,ids),
    receipts:store.all(`SELECT * FROM idempotency_receipts WHERE resource_id IN (${q}) ORDER BY principal_id,method,resource_key,idempotency_key`,ids),
    staff:store.all(`SELECT * FROM homecare_staff WHERE account_id IN (SELECT assigned_staff_id FROM bookings WHERE id IN (${q})) ORDER BY account_id`,ids)}
  if(snapshot.bookings.length!==ids.length)throw Error('missing_lifecycle_records')
  const sha256=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
  if(prior&&prior.sha256!==sha256)throw Error('lifecycle_snapshot_changed')
  writeFileSync(file,JSON.stringify(mode==='prepare'?{ids,sha256,preparedAt:new Date().toISOString()}:{...prior,verifiedAt:new Date().toISOString()},null,2))
  console.log(JSON.stringify({mode,result:'PASS',bookings:snapshot.bookings.length,history:snapshot.history.length,receipts:snapshot.receipts.length,staff:snapshot.staff.length,sha256}))
}finally{store.close()}
