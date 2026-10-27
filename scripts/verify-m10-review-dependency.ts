import {readPrivateJson} from '../src/security/private-files.cjs'
import {Database} from 'bun:sqlite'
import {randomUUID} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {loadConfig} from '../src/config.ts'
import {Store} from '../src/storage/database.ts'
import {createApp} from '../src/app.ts'
import {ReviewService} from '../src/modules/reviews/service.ts'
import {LangflowReviewGateway} from '../src/modules/reviews/gateway.ts'
import {CursorCodec} from '../src/modules/contracts/pagination.ts'
import type {ReviewRow} from '../src/modules/reviews/contracts.ts'
const config=loadConfig(),cases=readPrivateJson(new URL('../data/m10-cross-client-private.json',import.meta.url)),id=cases.cases.plan_recovery_probe.reviewId as string,clone=fileURLToPath(new URL(`../data/m10-review-isolated-${randomUUID()}.sqlite3`,import.meta.url)),source=new Database(config.consoleStateDbPath,{readonly:true})
writeFileSync(clone,source.serialize());source.close()
const store=Store.open({path:clone,reviewPath:config.reviewDbPath}),flows=readPrivateJson(new URL('../flows.json',import.meta.url)),origin='http://127.0.0.1:8082',reviews=new ReviewService(store,{codec:new CursorCodec(process.env.SYNCARE_CURSOR_SECRET!),reviewDbPath:config.reviewDbPath,gateway:new LangflowReviewGateway({baseUrl:'http://127.0.0.1:59999',apiKey:config.langflowApiKey,flowId:flows.f4_review_care_plan,f5FlowId:flows.f5_answer_care_questions,reviewDbPath:config.reviewDbPath}),runF3:async()=>{throw Error('not_called_in_recovery_test')}})
let app:ReturnType<typeof createApp>|undefined,token:string|undefined
try{
 const before=store.get<ReviewRow>('SELECT * FROM review_jobs WHERE id=?',[id])!;if(before.state!=='WAITING_FOR_HUMAN'||!before.upstream_id)throw Error('actual_pending_probe_required')
 await reviews.reconciler.recover();await reviews.reconciler.reconcile(id);const after=store.get<ReviewRow>('SELECT * FROM review_jobs WHERE id=?',[id])!
 if(after.state!=='UNKNOWN'||after.failure_code!=='dependency_unavailable'||after.session_id!==before.session_id||after.upstream_id!==before.upstream_id||store.get('SELECT id FROM review_decisions WHERE review_id=?',[id])||store.get('SELECT id FROM approval_links WHERE review_id=?',[id]))throw Error('unknown_recovery_not_proven')
 await reviews.reconciler.reconcile(id);if(store.get<ReviewRow>('SELECT * FROM review_jobs WHERE id=?',[id])!.version!==after.version)throw Error('duplicate_unknown_event')
 app=createApp({config:{...config,consoleStateDbPath:clone,port:8082,langflowBaseUrl:'http://127.0.0.1:59999'},security:{backendOrigin:origin,webOrigin:'http://127.0.0.1:3000',allowLocalHttp:true},store,cursorSecret:process.env.SYNCARE_CURSOR_SECRET!,reviews}).listen({hostname:'127.0.0.1',port:8082})
 const nurse=readPrivateJson(new URL('../data/local-demo-accounts.json',import.meta.url)).nurses[0],login=await fetch(`${origin}/api/v1/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identifier:nurse.identifier,password:nurse.password})});if(!login.ok)throw Error('clone_auth_failed');token=(await login.json() as any).data.sessionToken
 const response=await fetch(`${origin}/api/v1/reviews/${id}`,{headers:{authorization:`Bearer ${token}`}}),body=await response.json() as any;if(response.status!==200||body.data.state!=='UNKNOWN'||body.data.decision!==null)throw Error('honest_unknown_projection_missing')
 writeFileSync(new URL('../data/m10-review-dependency-evidence.json',import.meta.url),JSON.stringify({result:'PASS',verifiedAt:new Date().toISOString(),reviewId:id,actualSavedUpstreamHandle:true,actualUnreachableHTTP:true,isolatedOperationalClone:true,noDecisionOrApproval:true,noAutomaticStartOrResume:true,unknownPreservesIdentity:true,mainEngineStopped:false,before,after,projection:body.data},null,2));console.log(JSON.stringify({result:'PASS',actualUnreachableHTTP:true,unknownPreservesIdentity:true,noAutomaticStartOrResume:true,credentialsPrinted:false}))
}finally{if(app){if(token)await fetch(`${origin}/api/v1/auth/session`,{method:'DELETE',headers:{authorization:`Bearer ${token}`}}).catch(()=>{});await app.stop()}store.close()}
