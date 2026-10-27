import {readPrivateJson} from '../src/security/private-files.cjs'
const input = readPrivateJson(new URL('../data/local-demo-accounts.json', import.meta.url)) as { patients: { identifier: string; password: string }[] }
const base = 'http://127.0.0.1:8080'
let token = ''
const data = async <T>(response: Response): Promise<T> => (await response.json() as { data: T }).data
try {
  const credentials = input.patients[0]!
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: credentials.identifier, password: credentials.password }) })
  if (login.status !== 200) throw new Error('login_failed')
  const session = await data<{ sessionToken: string; principal: { id: string; patientId: string }; expiresAt: string }>(login)
  token = session.sessionToken
  const headers = { Authorization: `Bearer ${token}` }
  const before = await data<unknown>(await fetch(`${base}/api/v1/patients/${session.principal.patientId}`, { headers }))
  console.log(JSON.stringify({ status: 'ready_for_backend_restart', credentialsPrinted: false }))
  await new Promise<void>(resolve => process.stdin.once('data', () => resolve()))
  process.stdin.pause()
  const restored = await fetch(`${base}/api/v1/auth/session`, { headers })
  const after = await data<unknown>(await fetch(`${base}/api/v1/patients/${session.principal.patientId}`, { headers }))
  const snapshot = await data<{ principal: { id: string }; expiresAt: string }>(restored)
  const passed = restored.status === 200 && snapshot?.principal.id === session.principal.id && snapshot?.expiresAt === session.expiresAt && JSON.stringify(before) === JSON.stringify(after)
  console.log(JSON.stringify({ status: passed ? 'pass' : 'fail', sameSession: passed, sameProfileVersion: passed, sameExpiry: passed, credentialsPrinted: false }))
  if (!passed) process.exitCode = 1
} catch {
  console.error(JSON.stringify({ status: 'fail', credentialsPrinted: false }))
  process.exitCode = 1
} finally {
  if (token) await fetch(`${base}/api/v1/auth/session`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
}
