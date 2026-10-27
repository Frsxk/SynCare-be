import { randomUUID } from 'node:crypto'
import { loadConfig } from '../src/config.ts'
import { Store } from '../src/storage/database.ts'
import { AuthService } from '../src/modules/auth/service.ts'
import { ProvisionService } from '../src/modules/auth/provision.ts'
import { exactObject,requireCapability } from '../src/modules/patients/service.ts'
import { DomainError } from '../src/modules/contracts/errors.ts'
let store:Store|undefined,auth:AuthService|undefined,token:string|undefined,newGrants=0
try{
  const raw=await Bun.stdin.text();if(Buffer.byteLength(raw)>8192)throw new DomainError('validation_failed')
  const input=exactObject(JSON.parse(raw),['credentials','nurseIdentifiers']),credentials=exactObject(input.credentials,['identifier','password'])
  if(!Array.isArray(input.nurseIdentifiers)||!input.nurseIdentifiers.length||input.nurseIdentifiers.length>20||input.nurseIdentifiers.some(id=>typeof id!=='string'))throw new DomainError('validation_failed')
  const config=loadConfig();if(config.readOnly)throw new DomainError('forbidden')
  store=Store.open({path:config.consoleStateDbPath,reviewPath:config.reviewDbPath})
  auth=new AuthService(store);const grant=await auth.login(credentials.identifier as string,credentials.password as string);token=grant.sessionToken
  const ctx={principal:grant.principal,requestId:randomUUID()}
  requireCapability(store,ctx.principal,'account.provision');requireCapability(store,ctx.principal,'capability.manage')
  const targets=input.nurseIdentifiers.map(identifier=>{
    const row=store!.get<{id:string;version:number}>("SELECT id,version FROM accounts WHERE identifier=? AND role='nurse' AND active=1",[identifier as string])
    if(!row||!store!.get("SELECT id FROM patient_assignments WHERE nurse_account_id=? AND revoked_at IS NULL AND julianday(effective_at)<=julianday(?)",[row.id,new Date().toISOString()]))throw new DomainError('not_found')
    return row
  })
  for(const nurse of targets){
    if(store.get("SELECT id FROM capability_grants WHERE account_id=? AND capability='alert.manage' AND revoked_at IS NULL",[nurse.id]))continue
    await new ProvisionService(store).setCapability(ctx,{accountId:nurse.id,expectedVersion:nurse.version,capability:'alert.manage',operation:'grant'});newGrants++
  }
  console.log(JSON.stringify({status:'saved',newGrants,assignmentsChanged:false,credentialsReturned:false}))
}catch(error){console.error(JSON.stringify({status:'not_saved',newGrants,code:error instanceof DomainError?error.code:'alert_access_setup_failed',credentialsReturned:false}));process.exitCode=1}
finally{if(auth&&token)await auth.revoke((await auth.inspect(token)).sessionId).catch(()=>{});store?.close()}
