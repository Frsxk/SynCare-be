import { expect, test } from 'bun:test'
import { loadSecurityConfig } from '../src/config.ts'

test('security_config_fails_open_origin: wildcard, nonlocal HTTP, credentials and origin paths fail closed', () => {
  const environment = { SYNCARE_BACKEND_ORIGIN: 'http://127.0.0.1:8080', SYNCARE_WEB_ORIGIN: 'http://127.0.0.1:3000', SYNCARE_ALLOW_LOCAL_HTTP: 'true' }
  expect(loadSecurityConfig(environment).allowLocalHttp).toBe(true)
  for (const value of ['*', 'http://192.168.1.2:3000', 'http://localhost.evil.test', 'https://user:pass@example.test', 'https://example.test/path', 'https://example.test?q=1']) {
    expect(() => loadSecurityConfig({ ...environment, SYNCARE_WEB_ORIGIN: value })).toThrow()
  }
  expect(() => loadSecurityConfig({ ...environment, SYNCARE_ALLOW_LOCAL_HTTP: 'false' })).toThrow()
  expect(() => loadSecurityConfig({})).toThrow()
  expect(loadSecurityConfig({ SYNCARE_BACKEND_ORIGIN: 'https://api.synthetic.invalid', SYNCARE_WEB_ORIGIN: 'https://web.synthetic.invalid' }).allowLocalHttp).toBe(false)
})
