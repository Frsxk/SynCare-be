const {execFileSync}=require('node:child_process');
const {readFileSync,writeFileSync,renameSync}=require('node:fs');
const {randomUUID}=require('node:crypto');
const prefix='dpapi:v1:';
const cache=new Map();
function transform(value,operation){
  if(process.platform!=='win32')throw Error('windows_protection_required');
  const script=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $entropy=[Text.Encoding]::UTF8.GetBytes('SynCare.local.private.v1'); $result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  try {
    const output=execFileSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input:Buffer.from(value).toString('base64'),encoding:'utf8',windowsHide:true,timeout:15000,stdio:['pipe','pipe','pipe']});
    return Buffer.from(output.trim(),'base64');
  }catch{throw Error('private_material_unavailable');}
}
function protectText(text){return prefix+transform(Buffer.from(text,'utf8'),'Protect').toString('base64');}
function unprotectText(text){
  if(typeof text!=='string'||!text.startsWith(prefix)||text.length>32*1024*1024||!/^[A-Za-z0-9+/]+=*$/.test(text.slice(prefix.length)))throw Error('invalid_private_envelope');
  if(!cache.has(text))cache.set(text,transform(Buffer.from(text.slice(prefix.length),'base64'),'Unprotect').toString('utf8'));
  return cache.get(text);
}
function readPrivateJson(file){const text=readFileSync(file,'utf8');return JSON.parse(text.startsWith('dpapi:')?unprotectText(text):text);}
function writePrivateJson(file,value){
  const text=JSON.stringify(value,null,2),sealed=protectText(text);
  if(unprotectText(sealed)!==text)throw Error('private_roundtrip_failed');
  const temporary=String(file instanceof URL?require('node:url').fileURLToPath(file):file)+'.'+randomUUID()+'.protected-tmp';
  writeFileSync(temporary,sealed,{flag:'wx',mode:0o600});renameSync(temporary,file);
}
function unprotectEnvironment(environment=process.env){for(const [key,value] of Object.entries(environment))if(typeof value==='string'&&value.startsWith('dpapi:'))environment[key]=unprotectText(value);return environment;}
module.exports={protectText,unprotectText,readPrivateJson,writePrivateJson,unprotectEnvironment};
