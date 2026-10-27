import { randomUUID } from 'node:crypto'
import { loadConfig } from '../src/config.ts'
import { Store } from '../src/storage/database.ts'
import { AuthService } from '../src/modules/auth/service.ts'
import { ProvisionService } from '../src/modules/auth/provision.ts'
import { exactObject,requireCapability } from '../src/modules/patients/service.ts'
import { seedDemoCatalog } from '../src/modules/homecare/catalog.ts'
import { DomainError } from '../src/modules/contracts/errors.ts'

let store:Store|undefined,auth:AuthService|undefined,token:string|undefined
try{
  const input=exactObject(JSON.parse(await Bun.stdin.text()),['credentials','nurseIdentifiers'])
  const credentials=exactObject(input.credentials,['identifier','password'])
  if(!Array.isArray(input.nurseIdentifiers)||input.nurseIdentifiers.length>20||input.nurseIdentifiers.some(id=>typeof id!=='string'))throw new DomainError('validation_failed')
  const config=loadConfig()
  if(config.readOnly)throw new DomainError('forbidden')
  store=Store.open({path:config.consoleStateDbPath,reviewPath:config.reviewDbPath})
  await store.migrate()
  auth=new AuthService(store)
  const grant=await auth.login(credentials.identifier as string,credentials.password as string)
  token=grant.sessionToken
  const ctx={principal:grant.principal,requestId:randomUUID()}
  requireCapability(store,ctx.principal,'account.provision');requireCapability(store,ctx.principal,'capability.manage')
  await seedDemoCatalog(store)
  let grants=0
  for(const identifier of input.nurseIdentifiers){
    const nurse=store.get<{id:string;version:number}>("SELECT id,version FROM accounts WHERE identifier=? AND role='nurse' AND active=1",[identifier as string])
    if(!nurse)throw new DomainError('not_found')
    if(store.get("SELECT id FROM capability_grants WHERE account_id=? AND capability='booking.manage' AND revoked_at IS NULL",[nurse.id]))continue
    await new ProvisionService(store).setCapability(ctx,{accountId:nurse.id,expectedVersion:nurse.version,capability:'booking.manage',operation:'grant'})
    grants++
  }
  console.log(JSON.stringify({status:'saved',catalog:'post-discharge-nurse-demo',newGrants:grants,simulationOnly:true,credentialsReturned:false}))
}catch(error){console.error(JSON.stringify({status:'not_saved',code:error instanceof DomainError?error.code:'homecare_initialization_failed',credentialsReturned:false}));process.exitCode=1}
finally{if(auth&&token)await auth.revoke((await auth.inspect(token)).sessionId).catch(()=>{});store?.close()}
