import { readFileSync,writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Store } from '../src/storage/database.ts'
import { loadConfig } from '../src/config.ts'
const file=new URL('../data/m05-restart-evidence.json',import.meta.url),mode=process.argv[2]
if(!['prepare','verify'].includes(mode??''))throw Error('choose_prepare_or_verify')
const store=Store.open({path:loadConfig().consoleStateDbPath})
try{
  const prior=mode==='verify'?JSON.parse(readFileSync(file,'utf8')) as {ids:string[];sha256:string}:null
  const ids=prior?.ids??store.all<{id:string}>('SELECT id FROM bookings ORDER BY id').map(r=>r.id)
  if(!ids.length)throw Error('no_actual_bookings')
  const placeholders=ids.map(()=>'?').join(',')
  const snapshot={bookings:store.all(`SELECT * FROM bookings WHERE id IN (${placeholders}) ORDER BY id`,ids),
    history:store.all(`SELECT * FROM booking_history WHERE booking_id IN (${placeholders}) ORDER BY id`,ids),
    services:store.all(`SELECT * FROM homecare_services WHERE id IN (SELECT service_id FROM bookings WHERE id IN (${placeholders})) ORDER BY id`,ids)}
  const sha256=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
  if(prior&&sha256!==prior.sha256)throw Error('restart_snapshot_changed')
  writeFileSync(file,JSON.stringify(mode==='prepare'?{ids,sha256,preparedAt:new Date().toISOString()}:{...prior,verifiedAt:new Date().toISOString()},null,2))
  console.log(JSON.stringify({mode,result:'PASS',bookings:snapshot.bookings.length,history:snapshot.history.length,services:snapshot.services.length,sha256}))
}finally{store.close()}
