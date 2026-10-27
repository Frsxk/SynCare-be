import {test,expect} from 'bun:test'
import {mkdtempSync,readFileSync,rmSync,rmdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomBytes} from 'node:crypto'
import {protectText,unprotectText,readPrivateJson,writePrivateJson,unprotectEnvironment} from '../src/security/private-files.cjs'

test('Windows CurrentUser protection round-trips credentials without a plaintext file or console argument',()=>{
 const parent=mkdtempSync(join(tmpdir(),'syncare-private-')),file=join(parent,'credentials.json'),password=randomBytes(32).toString('base64url')
 try{
  writePrivateJson(file,{password,identifier:'synthetic@synthetic.invalid'})
  const stored=readFileSync(file,'utf8')
  expect(stored.startsWith('dpapi:v1:')).toBe(true);expect(stored).not.toContain(password)
  expect(readPrivateJson(file).password).toBe(password)
  const env={SYNCARE_API_KEY:protectText(password),SYNCARE_HOST:'127.0.0.1'}
  expect(unprotectEnvironment(env)).toEqual({SYNCARE_API_KEY:password,SYNCARE_HOST:'127.0.0.1'})
 }finally{rmSync(file,{force:true});rmdirSync(parent)}
},20000)

test('invalid or corrupted private material fails closed with sanitized errors',()=>{
 expect(()=>unprotectText('not-an-envelope')).toThrow('invalid_private_envelope')
 expect(()=>unprotectText('dpapi:v1:'+Buffer.from('corrupted synthetic payload').toString('base64'))).toThrow('private_material_unavailable')
 expect(()=>unprotectEnvironment({SYNCARE_API_KEY:'dpapi:v1:!invalid!'})).toThrow('invalid_private_envelope')
 expect(()=>unprotectEnvironment({SYNCARE_SESSION_SECRET:'dpapi:v2:'+Buffer.from('unsupported synthetic secret').toString('base64')})).toThrow('invalid_private_envelope')
},20000)
