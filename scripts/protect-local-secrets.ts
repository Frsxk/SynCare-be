import {readFileSync,writeFileSync,readdirSync,renameSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseEnv} from 'node:util'
import {randomUUID,createHash} from 'node:crypto'
import {protectText,unprotectText,readPrivateJson,writePrivateJson} from '../src/security/private-files.cjs'

const workspace=fileURLToPath(new URL('../../',import.meta.url))
const hasPassword=(value:unknown):boolean=>value!==null&&typeof value==='object'&&Object.entries(value).some(([key,child])=>(key==='password'&&typeof child==='string')||hasPassword(child))
let envValues=0,credentialFiles=0
try{
 if(!process.argv.includes('--protect')||process.platform!=='win32')throw Error('explicit_windows_protection_required')
 for(const relative of ['SynCare-be/.env','SynCare-nurse-dashboard/.env.local']){
  const file=resolve(workspace,relative),original=readFileSync(file,'utf8');let updated=original
  for(const [key,value] of Object.entries(parseEnv(original))){
   if(!/(KEY|TOKEN|SECRET)$/.test(key)||!value)continue
   if(value.startsWith('dpapi:')){unprotectText(value);continue}
   const sealed=protectText(value)
   if(unprotectText(sealed)!==value)throw Error('private_roundtrip_failed')
   const pattern=new RegExp('^(\\s*(?:export\\s+)?'+key+'\\s*=\\s*).*$','gm')
   updated=updated.replace(pattern,(_,head:string)=>head+sealed)
   if(unprotectText(parseEnv(updated)[key]!)!==value)throw Error('private_env_replacement_failed')
   envValues++
  }
  if(updated!==original){const temporary=file+'.'+randomUUID()+'.protected-tmp';writeFileSync(temporary,updated,{flag:'wx',mode:0o600});renameSync(temporary,file)}
 }
 const directories=[join(workspace,'SynCare-be/data'),...readdirSync(join(workspace,'.tools/m11-demo-runs'),{withFileTypes:true}).filter(entry=>entry.isDirectory()&&!entry.isSymbolicLink()).map(entry=>join(workspace,'.tools/m11-demo-runs',entry.name))]
 for(const directory of directories)for(const entry of readdirSync(directory,{withFileTypes:true})){
  if(!entry.isFile()||!entry.name.endsWith('.json'))continue
  const file=join(directory,entry.name),text=readFileSync(file,'utf8')
  if(text.startsWith('dpapi:')){readPrivateJson(file);continue}
  let value:unknown;try{value=JSON.parse(text)}catch{continue}
  if(hasPassword(value)){
   writePrivateJson(file,value)
   if(JSON.stringify(readPrivateJson(file))!==JSON.stringify(value))throw Error('private_roundtrip_failed')
   if(entry.name==='credentials-private.json'){
    const markerFile=join(directory,'manifest.json'),marker=JSON.parse(readFileSync(markerFile,'utf8'))
    marker.credentialHash=createHash('sha256').update(readFileSync(file,'utf8')).digest('hex')
    writeFileSync(markerFile,JSON.stringify(marker,null,2))
   }
   credentialFiles++
  }
 }
 console.log(JSON.stringify({result:'PASS',envValuesProtected:envValues,credentialFilesProtected:credentialFiles,credentialValuesChanged:false,credentialsPrinted:false,scope:'Windows CurrentUser local demo'}))
}catch{console.error(JSON.stringify({result:'FAIL',code:'private_protection_incomplete',credentialsPrinted:false}));process.exitCode=1}
