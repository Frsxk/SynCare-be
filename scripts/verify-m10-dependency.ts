import {readPrivateJson} from '../src/security/private-files.cjs'
import {Database} from 'bun:sqlite'
import {randomUUID,createHash} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {createApp} from '../src/app.ts'
import {loadConfig} from '../src/config.ts'
import {Store} from '../src/storage/database.ts'
const config=loadConfig(),fixture=readPrivateJson(new URL('../data/m10-fixtures-private.json',import.meta.url)),p=fixture.patients[0],clone=fileURLToPath(new URL(`../data/m10-isolated-${randomUUID()}.sqlite3`,import.meta.url)),source=new Database(config.consoleStateDbPath,{readonly:true})
writeFileSync(clone,source.serialize());source.close()
const store=Store.open({path:clone,reviewPath:config.reviewDbPath}),origin='http://127.0.0.1:8082',security={backendOrigin:origin,webOrigin:'http://127.0.0.1:3000',allowLocalHttp:true},checks:string[]=[],tokens:string[]=[]
const check=(value:unknown,name:string)=>{if(!value)throw Error(name);checks.push(name)},count=()=>store.get<{count:number}>('SELECT count(*) AS count FROM checkins')!.count
let app:ReturnType<typeof createApp>|undefined,stage='start_readonly'
const request=(path:string,token?:string,method='GET',body?:unknown)=>fetch(`${origin}/api/v1/${path}`,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})})
try{
 app=createApp({config:{...config,consoleStateDbPath:clone,port:8082,readOnly:true},security,store,cursorSecret:process.env.SYNCARE_CURSOR_SECRET!}).listen({port:8082,hostname:'127.0.0.1'})
 const login=await request('auth/login',undefined,'POST',{identifier:p.identifier,password:p.password});check(login.status===200,'actual_clone_login');const grant=(await login.json() as any).data;tokens.push(grant.sessionToken)
 const before=count();check((await request(`patients/${p.patientId}/checkins`,grant.sessionToken)).status===200,'readonly_history_available');
 check((await request(`patients/${p.patientId}/checkins`,grant.sessionToken,'POST',{message:'DATA SINTETIS M10 read-only mutation must fail'})).status===403,'readonly_mutation_denied');check(count()===before,'readonly_no_report_created')
 await app.stop();app=undefined;stage='unreachable_owned_dependency'
 app=createApp({config:{...config,consoleStateDbPath:clone,port:8082,readOnly:false,langflowBaseUrl:'http://127.0.0.1:59999'},security,store,cursorSecret:process.env.SYNCARE_CURSOR_SECRET!}).listen({port:8082,hostname:'127.0.0.1'})
 const response=await request(`patients/${p.patientId}/questions`,grant.sessionToken,'POST',{query:'DATA SINTETIS M10. Apa instruksi pada rencana saya?'}),body=await response.json() as any
 check(response.status===503,'real_unreachable_dependency_503');check(body.error?.code==='dependency_unavailable'&&body.data===undefined,'no_fabricated_answer');check(count()===before,'failure_preserves_reports')
 const backend=await fetch('http://127.0.0.1:8080/api/v1/auth/session');check(backend.status===401,'main_backend_still_available');
 writeFileSync(new URL('../data/m10-dependency-evidence.json',import.meta.url),JSON.stringify({verifiedAt:new Date().toISOString(),checks,actualHTTP:true,isolatedOperationalClone:true,cloneFingerprint:createHash('sha256').update(clone).digest('hex'),upstream:'owned_unreachable_loopback',mainLangflowStopped:false,fixtureDataNotClinicalSuccess:true},null,2));console.log(JSON.stringify({result:'PASS',checks:checks.length,actualHTTP:true,isolatedClone:true,credentialsPrinted:false}))
}catch(error){console.error(JSON.stringify({result:'FAIL',stage,errorClass:error instanceof Error?error.name:'unknown',check:error instanceof Error&&/^[a-zA-Z0-9_]+$/.test(error.message)?error.message:undefined,credentialsPrinted:false}));process.exitCode=1}
finally{if(app){for(const token of tokens)await request('auth/session',token,'DELETE').catch(()=>{});await app.stop()}store.close()}
