import { randomUUID } from 'node:crypto'
import type { Store } from '../../storage/database.ts'
import { DomainError, type RequestContext } from '../contracts/errors.ts'
import { strictTextObject } from '../contracts/validation.ts'
import { assertPatientScope, exactObject, requireCapability } from '../patients/service.ts'
import { hashPassword } from './service.ts'

export const NURSE_CAPABILITIES = ['patient.manage', 'patient.provision', 'risk.confirm', 'review.decide', 'booking.manage', 'alert.manage'] as const
const OPERATOR_CAPABILITIES = ['account.provision', 'capability.manage', 'assignment.manage', 'patient.manage'] as const
export interface AccountLink { accountId: string; patientId: string; active: true }

function identifier(input: unknown): string {
  return strictTextObject({ identifier: input }, { identifier: 320 }).identifier.trim().toLowerCase()
}

export class ProvisionService {
  constructor(private readonly store: Store, private readonly clock = () => new Date()) {}

  async provision(ctx: RequestContext, input: unknown): Promise<AccountLink> {
    const body = exactObject(input, ['patientId', 'identifier', 'activationInput'])
    const patientId = strictTextObject({ patientId: body.patientId }, { patientId: 128 }).patientId
    const login = identifier(body.identifier)
    const activation = strictTextObject(body.activationInput, { password: 128 })
    requireCapability(this.store, ctx.principal, 'patient.provision')
    assertPatientScope(this.store, ctx.principal, patientId)
    const verifier = await hashPassword(activation.password)
    return this.store.transaction(tx => {
      requireCapability(tx, ctx.principal, 'patient.provision')
      assertPatientScope(tx, ctx.principal, patientId)
      if (tx.get('SELECT id FROM accounts WHERE identifier=?', [login]) || tx.get('SELECT account_id FROM patient_account_links WHERE patient_id=?', [patientId])) {
        throw new DomainError('version_conflict', { resourceId: patientId })
      }
      const accountId = randomUUID(), now = this.clock().toISOString()
      tx.run('INSERT INTO accounts(id,identifier,password_hash,role,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        [accountId, login, verifier, 'patient', 0, now, now])
      tx.run('INSERT INTO patient_account_links VALUES (?,?,?,?)', [patientId, accountId, ctx.principal.id, now])
      tx.run('UPDATE accounts SET active=1 WHERE id=?', [accountId])
      tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)', [randomUUID(), ctx.principal.id, 'account.patient_activated', 'patient', patientId, now,
        JSON.stringify({ accountId })])
      return { accountId, patientId, active: true }
    })
  }

  async provisionNurse(ctx: RequestContext, input: { identifier: string; password: string; capabilities: string[] }): Promise<{ accountId: string }> {
    requireCapability(this.store, ctx.principal, 'account.provision')
    requireCapability(this.store, ctx.principal, 'capability.manage')
    const login = identifier(input.identifier)
    if (!Array.isArray(input.capabilities) || new Set(input.capabilities).size !== input.capabilities.length ||
        input.capabilities.some(value => !NURSE_CAPABILITIES.includes(value as typeof NURSE_CAPABILITIES[number]))) throw new DomainError('validation_failed')
    const verifier = await hashPassword(input.password)
    return this.store.transaction(tx => {
      requireCapability(tx, ctx.principal, 'account.provision')
      requireCapability(tx, ctx.principal, 'capability.manage')
      if (tx.get('SELECT id FROM accounts WHERE identifier=?', [login])) throw new DomainError('version_conflict')
      const accountId = randomUUID(), now = this.clock().toISOString()
      tx.run('INSERT INTO accounts(id,identifier,password_hash,role,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        [accountId, login, verifier, 'nurse', 1, now, now])
      for (const capability of input.capabilities) tx.run('INSERT INTO capability_grants VALUES (?,?,?,?,?,?,?)',
        [randomUUID(), accountId, capability, ctx.principal.id, now, null, null])
      tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)', [randomUUID(), ctx.principal.id, 'account.nurse_provisioned', 'account', accountId, now,
        JSON.stringify({ capabilities: input.capabilities })])
      return { accountId }
    })
  }

  async setCapability(ctx: RequestContext, input: unknown): Promise<{ accountId: string; capability: string; active: boolean; version: number }> {
    const body = exactObject(input, ['accountId', 'capability', 'operation', 'expectedVersion'])
    if (typeof body.accountId !== 'string' || !body.accountId || typeof body.capability !== 'string' ||
        !NURSE_CAPABILITIES.includes(body.capability as typeof NURSE_CAPABILITIES[number]) ||
        !['grant', 'revoke'].includes(body.operation as string) || !Number.isSafeInteger(body.expectedVersion) ||
        (body.expectedVersion as number) < 1) throw new DomainError('validation_failed')
    return this.store.transaction(tx => {
      requireCapability(tx, ctx.principal, 'capability.manage')
      const account = tx.get<{ version: number }>('SELECT version FROM accounts WHERE id=? AND role=? AND active=1', [body.accountId as string, 'nurse'])
      if (!account) throw new DomainError('not_found')
      if (account.version !== body.expectedVersion) throw new DomainError('version_conflict', { resourceId: body.accountId as string, currentVersion: account.version })
      const previous = tx.get<{ id: string }>('SELECT id FROM capability_grants WHERE account_id=? AND capability=? AND revoked_at IS NULL', [body.accountId as string, body.capability as string])
      if ((body.operation === 'grant') === Boolean(previous)) throw new DomainError('version_conflict')
      const now = this.clock().toISOString()
      if (body.operation === 'grant') tx.run('INSERT INTO capability_grants VALUES (?,?,?,?,?,?,?)', [randomUUID(), body.accountId as string, body.capability as string, ctx.principal.id, now, null, null])
      else tx.run('UPDATE capability_grants SET revoked_at=?,revoked_by=? WHERE id=?', [now, ctx.principal.id, previous!.id])
      tx.run('UPDATE accounts SET version=version+1,updated_at=? WHERE id=? AND version=?', [now, body.accountId as string, account.version])
      tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)', [randomUUID(), ctx.principal.id, `capability.${body.operation}`, 'account', body.accountId as string, now,
        JSON.stringify({ capability: body.capability, version: account.version + 1 })])
      return { accountId: body.accountId as string, capability: body.capability as string, active: body.operation === 'grant', version: account.version + 1 }
    })
  }
}

export async function bootstrapOperator(store: Store, input: { identifier: string; password: string }): Promise<{ accountId: string }> {
  const login = identifier(input.identifier)
  const verifier = await hashPassword(input.password)
  return store.transaction(tx => {
    if (tx.get('SELECT id FROM accounts LIMIT 1')) throw new DomainError('forbidden')
    const accountId = randomUUID(), now = new Date().toISOString()
    tx.run('INSERT INTO accounts(id,identifier,password_hash,role,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      [accountId, login, verifier, 'nurse', 1, now, now])
    for (const capability of OPERATOR_CAPABILITIES) tx.run('INSERT INTO capability_grants VALUES (?,?,?,?,?,?,?)',
      [randomUUID(), accountId, capability, accountId, now, null, null])
    tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)', [randomUUID(), accountId, 'operator.bootstrapped', 'account', accountId, now, '{}'])
    return { accountId }
  })
}
