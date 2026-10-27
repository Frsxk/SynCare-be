import { randomUUID } from 'node:crypto'
import { loadConfig } from '../src/config.ts'
import { Store } from '../src/storage/database.ts'
import { AuthService } from '../src/modules/auth/service.ts'
import { ProvisionService } from '../src/modules/auth/provision.ts'
import { exactObject } from '../src/modules/patients/service.ts'
import { DomainError } from '../src/modules/contracts/errors.ts'

let store: Store | undefined
let auth: AuthService | undefined
let token: string | undefined
try {
  const text = await Bun.stdin.text()
  if (Buffer.byteLength(text) > 8192) throw new DomainError('validation_failed')
  const input = exactObject(JSON.parse(text), ['credentials', 'change'])
  const credentials = exactObject(input.credentials, ['identifier', 'password'])
  const config = loadConfig()
  store = Store.open({ path: config.consoleStateDbPath, reviewPath: config.reviewDbPath })
  auth = new AuthService(store)
  const grant = await auth.login(credentials.identifier as string, credentials.password as string)
  token = grant.sessionToken
  const result = await new ProvisionService(store).setCapability({ principal: grant.principal, requestId: randomUUID() }, input.change)
  console.log(JSON.stringify({ status: 'saved', ...result, credentialsReturned: false }))
} catch (error) {
  console.error(JSON.stringify({ status: 'not_saved', code: error instanceof DomainError ? error.code : 'operator_action_failed', credentialsReturned: false }))
  process.exitCode = 1
} finally {
  if (auth && token) await auth.revoke((await auth.inspect(token)).sessionId).catch(() => {})
  store?.close()
}
