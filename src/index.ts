/** Entrypoint: starts the HTTP listener; tests import app.ts without binding a port. */
import { createApp } from './app.ts'
import { ConfigError, loadConfig, loadSecurityConfig } from './config.ts'
import { Store } from './storage/database.ts'
import { readFileSync } from 'node:fs'
import { FlowGateway,type F2Binding } from './modules/workflows/flow-gateway.ts'
import { CheckinProcessor } from './modules/checkins/processor.ts'
import { AlertProducer } from './modules/alerts/producer.ts'
import { ReviewService } from './modules/reviews/service.ts'
import { LangflowReviewGateway } from './modules/reviews/gateway.ts'
import { CursorCodec } from './modules/contracts/pagination.ts'
import { runFlow } from './plugins/langflow.ts'

const config = loadConfig()
const security = loadSecurityConfig()
const cursorSecret = process.env.SYNCARE_CURSOR_SECRET ?? ''
if (Buffer.byteLength(cursorSecret) < 32) throw new ConfigError('SYNCARE_CURSOR_SECRET must be configured privately with at least 32 bytes.')
const store = Store.open({ path: config.consoleStateDbPath, reviewPath: config.reviewDbPath })
await store.migrate()
const configuredJson=(key:string):unknown=>{
  const path=process.env[key]
  if(!path)return undefined
  try{return JSON.parse(readFileSync(path,'utf8')) as unknown}catch{throw new ConfigError(`${key} must identify a readable JSON configuration.`)}
}
const guidance=configuredJson('SYNCARE_GUIDANCE_CONFIG')
const gateway=new FlowGateway({binding:configuredJson('SYNCARE_F2_CONTEXT_CONFIG') as F2Binding??null,baseUrl:config.langflowBaseUrl,apiKey:config.langflowApiKey})
const processor=new CheckinProcessor(store,{runF2:context=>gateway.runF2(context)})
const alertProducer=new AlertProducer(store)
const flowMap=JSON.parse(readFileSync(new URL('../flows.json',import.meta.url),'utf8')) as Record<string,string>
const reviews=new ReviewService(store,{codec:new CursorCodec(cursorSecret),reviewDbPath:config.reviewDbPath,
  gateway:new LangflowReviewGateway({baseUrl:config.langflowBaseUrl,apiKey:config.langflowApiKey,flowId:flowMap.f4_review_care_plan!,f5FlowId:flowMap.f5_answer_care_questions!,reviewDbPath:config.reviewDbPath}),
  runF3:(input,sessionId)=>runFlow(flowMap.f3_draft_followup_plan!,input,{sessionId})})
await reviews.reconciler.recover()
let reviewActive:Promise<unknown>|undefined
const reviewTimer=config.readOnly?undefined:setInterval(()=>{
  if(reviewActive)return
  reviewActive=reviews.reconciler.tick().catch(()=>{}).finally(()=>{reviewActive=undefined})
},1500)
let alertActive:Promise<unknown>|undefined
const alertTimer=config.readOnly?undefined:setInterval(()=>{
  if(alertActive)return
  alertActive=(async()=>{await alertProducer.reconcile();await alertProducer.processNext()})().catch(()=>{}).finally(()=>{alertActive=undefined})
},500)
let active:Promise<unknown>|undefined
const timer=config.readOnly?undefined:setInterval(()=>{
  if(active)return
  active=(async()=>{await processor.recoverExpired();await processor.processNext()})().catch(()=>{}).finally(()=>{active=undefined})
},500)
const app = createApp({ config, security, store, cursorSecret,guidance,checkinProcessor:processor,reviews }).onStop(async () => {
  if(timer)clearInterval(timer)
  if(alertTimer)clearInterval(alertTimer)
  if(reviewTimer)clearInterval(reviewTimer)
  await active
  await alertActive
  await reviewActive
  store.close()
})

// Bun's listen() takes (port, callback); use the object form to bind the host.
app.listen({ port: config.port, hostname: config.host })

console.log(`SynCare console listening on http://${config.host}:${config.port}`)
console.log(`  Langflow:   ${config.langflowBaseUrl}`)
console.log(`  Review DB:  ${config.reviewDbPath}`)
console.log(`  Read-only:  ${config.readOnly ? 'ON' : 'off'}`)
