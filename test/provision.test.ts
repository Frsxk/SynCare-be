import { expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { AuthService } from '../src/modules/auth/service.ts'
import { ProvisionService, bootstrapOperator } from '../src/modules/auth/provision.ts'
import { patientFixture } from './patients.test.ts'
import { database, NOW } from './migrations/fixture.ts'

test('provision_duplicate_link_rejected: authorized assigned nurse activates one private account with no plaintext persistence', async () => {
  const { store, service, ctx } = await patientFixture()
  const fresh = (await service.create(ctx(), { profile: { displayName: 'Patient C' }, initialCondition: null })).resource
  await store.transaction(tx => tx.run('INSERT INTO patient_assignments VALUES (?,?,?,?,?,?,?)', [randomUUID(), fresh.id, 'nurse-a', 'operator', NOW, null, null]))
  const provision = new ProvisionService(store, () => new Date(NOW))
  const password = randomBytes(18).toString('base64url')
  const input = { patientId: fresh.id, identifier: 'patient-c@synthetic.invalid', activationInput: { password } }
  await expect(provision.provision(ctx('patient-a'), input)).rejects.toMatchObject({ status: 403 })
  await expect(provision.provision(ctx('nurse-b'), input)).rejects.toMatchObject({ status: 404 })
  const result = await provision.provision(ctx(), input)
  expect(result.active).toBe(true)
  await expect(provision.provision(ctx(), input)).rejects.toMatchObject({ status: 409 })
  await expect(provision.provision(ctx(), { ...input, identifier: 'another@synthetic.invalid' })).rejects.toMatchObject({ status: 409 })
  expect(store.all('SELECT * FROM patient_account_links WHERE patient_id=?', [fresh.id])).toHaveLength(1)
  const auth = new AuthService(store, { clock: () => new Date(NOW) })
  expect((await auth.login(input.identifier, password)).principal.patientId).toBe(fresh.id)
  for (const table of ['accounts', 'operational_audit', 'idempotency_receipts']) expect(JSON.stringify(store.all(`SELECT * FROM ${table}`))).not.toContain(password)
  expect(JSON.stringify(result)).not.toContain(password)
})

test('activation failure rolls back account, link and audit; existing patient remains usable', async () => {
  const { store, service, ctx } = await patientFixture()
  const fresh = (await service.create(ctx(), { profile: { displayName: 'Patient C' }, initialCondition: null })).resource
  await store.transaction(tx => {
    tx.run('INSERT INTO patient_assignments VALUES (?,?,?,?,?,?,?)', [randomUUID(), fresh.id, 'nurse-a', 'operator', NOW, null, null])
    tx.run("CREATE TRIGGER synthetic_activation_failure BEFORE UPDATE OF active ON accounts WHEN NEW.identifier='fail@synthetic.invalid' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
  })
  const provision = new ProvisionService(store, () => new Date(NOW))
  await expect(provision.provision(ctx(), { patientId: fresh.id, identifier: 'fail@synthetic.invalid', activationInput: { password: randomBytes(18).toString('base64url') } })).rejects.toThrow()
  expect(store.all("SELECT * FROM accounts WHERE identifier='fail@synthetic.invalid'")).toHaveLength(0)
  expect(store.all('SELECT * FROM patient_account_links WHERE patient_id=?', [fresh.id])).toHaveLength(0)
  expect((await service.read(ctx(), fresh.id)).id).toBe(fresh.id)
})

test('private bootstrap is single-use; generic nurse cannot provision nurses or grant own clinical capabilities', async () => {
  const { store } = await database()
  const password = randomBytes(18).toString('base64url')
  const operator = await bootstrapOperator(store, { identifier: 'operator@synthetic.invalid', password })
  await expect(bootstrapOperator(store, { identifier: 'second@synthetic.invalid', password })).rejects.toMatchObject({ status: 403 })
  const auth = new AuthService(store)
  const principal = (await auth.login('operator@synthetic.invalid', password)).principal
  expect(principal.id).toBe(operator.accountId)
  const provision = new ProvisionService(store)
  const input = { identifier: 'nurse@synthetic.invalid', password: randomBytes(18).toString('base64url'), capabilities: ['patient.manage', 'patient.provision'] }
  const nurse = await provision.provisionNurse({ principal, requestId: randomUUID() }, input)
  const nursePrincipal = (await auth.login(input.identifier, input.password)).principal
  expect(nursePrincipal.id).toBe(nurse.accountId)
  expect(nursePrincipal.capabilities).not.toContain('risk.confirm')
  await expect(provision.provisionNurse({ principal: nursePrincipal, requestId: randomUUID() }, input)).rejects.toMatchObject({ status: 403 })
  await expect(provision.provisionNurse({ principal, requestId: randomUUID() }, { ...input, identifier: 'new', capabilities: ['capability.manage'] })).rejects.toMatchObject({ status: 422 })
  const change = { accountId: nurse.accountId, capability: 'risk.confirm', operation: 'grant', expectedVersion: 1 }
  await expect(provision.setCapability({ principal: nursePrincipal, requestId: randomUUID() }, change)).rejects.toMatchObject({ status: 403 })
  const granted = await provision.setCapability({ principal, requestId: randomUUID() }, change)
  expect(granted.active).toBe(true)
  expect((await auth.getSession((await auth.login(input.identifier, input.password)).sessionToken)).capabilities).toContain('risk.confirm')
  await expect(provision.setCapability({ principal, requestId: randomUUID() }, { ...change, operation: 'revoke' })).rejects.toMatchObject({ status: 409 })
  const revoked = await provision.setCapability({ principal, requestId: randomUUID() }, { ...change, operation: 'revoke', expectedVersion: granted.version })
  expect(revoked.active).toBe(false)
  expect((await auth.login(input.identifier, input.password)).principal.capabilities).not.toContain('risk.confirm')
})
