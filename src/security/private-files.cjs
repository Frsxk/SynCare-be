'use strict';
const {execFileSync}=require('node:child_process');
const {constants,readFileSync,writeFileSync,renameSync,unlinkSync,openSync,closeSync,fstatSync,lstatSync,readSync}=require('node:fs');
const {randomUUID,randomBytes,createCipheriv,createDecipheriv}=require('node:crypto');
const {isAbsolute}=require('node:path');
const {fileURLToPath}=require('node:url');

const DPAPI_PREFIX='dpapi:v1:';
const AESGCM_PREFIX='aesgcm:v1:';
const DPAPI_ENTROPY='SynCare.local.private.v1';
const AESGCM_AAD='SynCare.local.private.v1:aesgcm:v1';
const IV_BYTES=12,TAG_BYTES=16,KEY_BYTES=32,MAX_TEXT_LENGTH=32*1024*1024;
const dpapiCache=new Map();

function failEnvelope(){throw Error('invalid_private_envelope');}
function failMaterial(){throw Error('private_material_unavailable');}

/* Windows DPAPI stays native: CurrentUser scope, fixed entropy, base64 over stdin/stdout. */
function dpapiTransform(value,operation){
  if(process.platform!=='win32')throw Error('windows_protection_required');
  const script=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $entropy=[Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}'); $result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  try {
    const output=execFileSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input:Buffer.from(value).toString('base64'),encoding:'utf8',windowsHide:true,timeout:15000,stdio:['pipe','pipe','pipe']});
    return Buffer.from(output.trim(),'base64');
  }catch{failMaterial();}
}

/* Explicit absolute key path in the supplied environment; never generated, never cached, never logged. */
function readAesKey(environment){
  let descriptor,key;
  try {
    const path=(environment??process.env).SYNCARE_PRIVATE_KEY_FILE;
    if(typeof path!=='string'||path.length===0||path.length>4096||!isAbsolute(path))throw Error();
    /* O_NOFOLLOW rejects symlink substitution; O_NONBLOCK lets fstat reject FIFO substitution without hanging. */
    const link=lstatSync(path);
    if(link.isSymbolicLink()||!link.isFile()||link.nlink!==1||link.size!==KEY_BYTES)throw Error();
    descriptor=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    const stat=fstatSync(descriptor);
    const uid=typeof process.getuid==='function'?process.getuid():undefined;
    if(!stat.isFile()||stat.nlink!==1||stat.size!==KEY_BYTES)throw Error();
    if(uid===undefined||stat.uid!==uid)throw Error();
    if((stat.mode&0o7777)!==0o600)throw Error();
    key=Buffer.alloc(KEY_BYTES);
    let offset=0;
    while(offset<KEY_BYTES){
      const count=readSync(descriptor,key,offset,KEY_BYTES-offset,offset);
      if(count<=0)throw Error();
      offset+=count;
    }
    return key;
  }catch{
    if(key)key.fill(0);
    throw Error('private_key_unavailable');
  }finally{
    if(descriptor!==undefined){try{closeSync(descriptor);}catch{}}
  }
}

function decodeAesPayload(text){
  const encoded=text.slice(AESGCM_PREFIX.length);
  if(!encoded||encoded.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))failEnvelope();
  const payload=Buffer.from(encoded,'base64');
  if(payload.toString('base64')!==encoded)failEnvelope();
  if(payload.length<IV_BYTES+TAG_BYTES)failEnvelope();
  return payload;
}

function aesProtect(text,environment){
  if(process.platform==='win32')throw Error('unsupported_private_envelope');
  const key=readAesKey(environment);
  try {
    const iv=randomBytes(IV_BYTES);
    const cipher=createCipheriv('aes-256-gcm',key,iv);
    cipher.setAAD(Buffer.from(AESGCM_AAD,'utf8'));
    const ciphertext=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);
    return AESGCM_PREFIX+Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64');
  }catch{failMaterial();}
  finally{key.fill(0);}
}

function aesUnprotect(text,environment){
  const payload=decodeAesPayload(text);
  if(process.platform==='win32')throw Error('unsupported_private_envelope');
  const key=readAesKey(environment);
  try {
    const decipher=createDecipheriv('aes-256-gcm',key,payload.subarray(0,IV_BYTES));
    decipher.setAAD(Buffer.from(AESGCM_AAD,'utf8'));
    decipher.setAuthTag(payload.subarray(IV_BYTES,IV_BYTES+TAG_BYTES));
    return Buffer.concat([decipher.update(payload.subarray(IV_BYTES+TAG_BYTES)),decipher.final()]).toString('utf8');
  }catch{failMaterial();}
  finally{key.fill(0);}
}

function protectText(text,environment=process.env){
  if(typeof text!=='string')throw Error('invalid_private_text');
  if(process.platform==='win32')return DPAPI_PREFIX+dpapiTransform(Buffer.from(text,'utf8'),'Protect').toString('base64');
  return aesProtect(text,environment);
}

function unprotectText(text,environment=process.env){
  if(typeof text!=='string'||text.length>MAX_TEXT_LENGTH)failEnvelope();
  if(text.startsWith(DPAPI_PREFIX)){
    const encoded=text.slice(DPAPI_PREFIX.length);
    if(!encoded||!/^[A-Za-z0-9+/]+=*$/.test(encoded))failEnvelope();
    if(process.platform!=='win32')throw Error('windows_protection_required');
    if(!dpapiCache.has(text))dpapiCache.set(text,dpapiTransform(Buffer.from(encoded,'base64'),'Unprotect').toString('utf8'));
    return dpapiCache.get(text);
  }
  if(text.startsWith(AESGCM_PREFIX))return aesUnprotect(text,environment);
  failEnvelope();
}

function readPrivateJson(file,environment=process.env){
  const text=readFileSync(file,'utf8');
  if(text.startsWith('dpapi:')||text.startsWith('aesgcm:'))return JSON.parse(unprotectText(text,environment));
  return JSON.parse(text);
}

function writePrivateJson(file,value,environment=process.env){
  const text=JSON.stringify(value,null,2),sealed=protectText(text,environment);
  if(unprotectText(sealed,environment)!==text)throw Error('private_roundtrip_failed');
  const target=file instanceof URL?fileURLToPath(file):file;
  const temporary=String(target)+'.'+randomUUID()+'.protected-tmp';
  let created=false;
  try {
    writeFileSync(temporary,sealed,{flag:'wx',mode:0o600});
    created=true;
    renameSync(temporary,target);
  }catch(error){
    if(created){try{unlinkSync(temporary);}catch{}}
    throw error;
  }
}

function unprotectEnvironment(environment=process.env){
  for(const [key,value] of Object.entries(environment)){
    if(typeof value==='string'&&(value.startsWith('dpapi:')||value.startsWith('aesgcm:')))environment[key]=unprotectText(value,environment);
  }
  return environment;
}

module.exports={protectText,unprotectText,readPrivateJson,writePrivateJson,unprotectEnvironment};
