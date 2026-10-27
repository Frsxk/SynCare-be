import { randomUUID } from 'node:crypto'
import { loadConfig } from '../src/config.ts'
import { Store } from '../src/storage/database.ts'
import { AuthService } from '../src/modules/auth/service.ts'
import { exactObject,requireCapability } from '../src/modules/patients/service.ts'
import { strictTextObject } from '../src/modules/contracts/validation.ts'
import { DomainError } from '../src/modules/contracts/errors.ts'

let store:Store|undefined,auth:AuthService|undefined,token:string|undefined
try{
  const raw=await Bun.stdin.text();if(Buffer.byteLength(raw)>16000)throw new DomainError('validation_failed')
  const input=exactObject(JSON.parse(raw),['credentials','staff']),credentials=exactObject(input.credentials,['identifier','password'])
  if(!Array.isArray(input.staff)||input.staff.length<1||input.staff.length>20)throw new DomainError('validation_failed')
  const staff=input.staff.map(value=>strictTextObject(value,{identifier:320,displayName:160}))
  if(new Set(staff.map(s=>s.identifier.toLowerCase())).size!==staff.length)throw new DomainError('validation_failed')
  const config=loadConfig();if(config.readOnly)throw new DomainError('forbidden')
  store=Store.open({path:config.consoleStateDbPath,reviewPath:config.reviewDbPath});await store.migrate();auth=new AuthService(store)
  const grant=await auth.login(credentials.identifier as string,credentials.password as string);token=grant.sessionToken
  const principal=grant.principal,now=new Date().toISOString()
  const created=await store.transaction(tx=>{
    requireCapability(tx,principal,'account.provision');requireCapability(tx,principal,'capability.manage')
    let count=0
    for(const person of staff){
      const nurse=tx.get<{id:string}>("SELECT id FROM accounts WHERE identifier=? AND role='nurse' AND active=1",[person.identifier])
      if(!nurse)throw new DomainError('not_found')
      if(!tx.get("SELECT id FROM capability_grants WHERE account_id=? AND capability='booking.manage' AND revoked_at IS NULL",[nurse.id]))throw new DomainError('forbidden')
      if(tx.get('SELECT account_id FROM homecare_staff WHERE account_id=?',[nurse.id]))continue
      tx.run('INSERT INTO homecare_staff VALUES (?,?,1,1)',[nurse.id,person.displayName.trim()])
      tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)',[randomUUID(),principal.id,'homecare.staff.registered','account',nurse.id,now,JSON.stringify({synthetic:true,displayName:person.displayName.trim()})])
      count++
    }
    return count
  })
  console.log(JSON.stringify({status:'saved',registered:created,simulationOnly:true,assignmentsChanged:false,credentialsReturned:false}))
}catch(error){console.error(JSON.stringify({status:'not_saved',code:error instanceof DomainError?error.code:'staff_initialization_failed',credentialsReturned:false}));process.exitCode=1}
finally{if(auth&&token)await auth.revoke((await auth.inspect(token)).sessionId).catch(()=>{});store?.close()}
