import { Database } from 'bun:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { loadConfig } from '../src/config.ts'

const mode = process.argv[2], evidencePath = new URL('../data/m03-live-evidence.json', import.meta.url)
const snapshotPath = new URL('../data/m03-restart-snapshot.json', import.meta.url)
let db: Database | undefined
try {
  if (!['prepare', 'verify'].includes(mode ?? '')) throw new Error()
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as { patientId: string; dischargeIds: string[]; assessmentIds: string[] }
  db = new Database(loadConfig().consoleStateDbPath, { readonly: true })
  const snapshot = {
    sources: db.query('SELECT * FROM discharge_versions WHERE id IN (?,?) ORDER BY id').all(...evidence.dischargeIds),
    assessments: db.query('SELECT * FROM assessments WHERE id IN (?,?) ORDER BY id').all(...evidence.assessmentIds),
    confirmations: db.query('SELECT * FROM risk_confirmations WHERE assessment_id IN (?,?) ORDER BY id').all(...evidence.assessmentIds),
    head: db.query('SELECT * FROM patient_episode_heads WHERE patient_id=?').get(evidence.patientId),
  }
  const hash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
  if (snapshot.sources.length!==2 || snapshot.assessments.length!==2 || snapshot.confirmations.length!==2 || !snapshot.head) throw new Error()
  if (mode==='prepare') writeFileSync(snapshotPath, JSON.stringify({ hash, preparedAt: new Date().toISOString() }))
  else if (JSON.parse(readFileSync(snapshotPath, 'utf8')).hash!==hash) throw new Error()
  console.log(JSON.stringify({ status: mode==='prepare' ? 'ready_for_backend_restart' : 'pass', sources: 2, assessments: 2, confirmations: 2,
    exactSnapshotRetained: mode==='verify', credentialsPrinted: false }))
} catch {
  console.error(JSON.stringify({ status: 'fail', check: 'risk_restart_snapshot', credentialsPrinted: false }))
  process.exitCode = 1
} finally { db?.close() }
