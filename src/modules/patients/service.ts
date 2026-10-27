import { randomUUID } from 'node:crypto'
import type { Store, Transaction } from '../../storage/database.ts'
import { DomainError, type Principal, type RequestContext } from '../contracts/errors.ts'
import { withIdempotency } from '../contracts/idempotency.ts'
import { CursorCodec, seekBoundary, type Page, type PageInput } from '../contracts/pagination.ts'
import { strictTextObject } from '../contracts/validation.ts'
import type { PatientOverview } from './overview.ts'

type Reader = Pick<Store, 'get' | 'all'> | Transaction
interface PatientRow {
  id: string; profile_json: string; recorded_condition: string | null; version: number
  created_at: string; updated_at: string; updated_by: string
}
export interface Patient {
  id: string; profile: { displayName: string }; recordedCondition: string | null; version: number
  createdAt: string; updatedAt: string; source: { actorId: string; recordedAt: string }
}

export function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) ||
      keys.some(key => !Object.hasOwn(value, key))) throw new DomainError('validation_failed')
  return value as Record<string, unknown>
}

export function currentIdentity(reader: Reader, principal: Principal): { id: string; role: 'patient' | 'nurse' } {
  const account = reader.get<{ id: string; role: 'patient' | 'nurse'; active: number }>('SELECT id,role,active FROM accounts WHERE id=?', [principal.id])
  if (!account?.active || account.role !== principal.role) throw new DomainError('unauthenticated')
  return account
}

export function requireCapability(reader: Reader, principal: Principal, capability: string): void {
  const identity = currentIdentity(reader, principal)
  if (identity.role !== 'nurse' || !reader.get('SELECT id FROM capability_grants WHERE account_id=? AND capability=? AND revoked_at IS NULL',
    [identity.id, capability])) throw new DomainError('forbidden')
}

export function patientScope(reader: Reader, principal: Principal) {
  const identity = currentIdentity(reader, principal)
  return identity.role === 'patient'
    ? { sql: 'id IN (SELECT patient_id FROM patient_account_links WHERE account_id=?)', bindings: [identity.id] }
    : { sql: 'id IN (SELECT patient_id FROM patient_assignments WHERE nurse_account_id=? AND revoked_at IS NULL AND julianday(effective_at)<=julianday(?))',
      bindings: [identity.id, new Date().toISOString()] }
}

export function assertPatientScope(reader: Reader, principal: Principal, patientId: string): void {
  const scope = patientScope(reader, principal)
  if (!reader.get(`SELECT id FROM patients WHERE id=? AND ${scope.sql}`, [patientId, ...scope.bindings])) throw new DomainError('not_found')
}

function project(row: PatientRow): Patient {
  const stored = JSON.parse(row.profile_json) as Record<string, unknown>
  if (typeof stored.displayName !== 'string' || !stored.displayName.trim()) throw new DomainError('processing_failed')
  return { id: row.id, profile: { displayName: stored.displayName }, recordedCondition: row.recorded_condition,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
    source: { actorId: row.updated_by, recordedAt: row.updated_at } }
}

function profile(value: unknown): { displayName: string } {
  const result = strictTextObject(value, { displayName: 160 })
  return { displayName: result.displayName.trim() }
}

function condition(value: unknown): string | null {
  if (value === null) return null
  return strictTextObject({ value }, { value: 4000 }).value
}

export class PatientService {
  private readonly clock: () => Date
  constructor(private readonly store: Store, private readonly options: { codec: CursorCodec; clock?: () => Date; overview?: (ctx: RequestContext, profile: Patient) => PatientOverview }) {
    this.clock = options.clock ?? (() => new Date())
  }

  async create(ctx: RequestContext, input: unknown): Promise<{ resource: Patient; replayed: boolean }> {
    const body = exactObject(input, ['profile', 'initialCondition'])
    const parsed = { profile: profile(body.profile), initialCondition: condition(body.initialCondition) }
    requireCapability(this.store, ctx.principal, 'patient.manage')
    const saved = await withIdempotency(this.store, {
      principalId: ctx.principal.id, method: 'POST', resourceKey: '/patients', key: ctx.idempotencyKey ?? '', payload: parsed,
    }, tx => {
      requireCapability(tx, ctx.principal, 'patient.manage')
      const id = randomUUID(), now = this.clock().toISOString()
      tx.run('INSERT INTO patients(id,profile_json,recorded_condition,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        [id, JSON.stringify(parsed.profile), parsed.initialCondition, ctx.principal.id, ctx.principal.id, now, now])
      tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)', [randomUUID(), ctx.principal.id, 'patient.created', 'patient', id, now, '{}'])
      const row = tx.get<PatientRow>('SELECT * FROM patients WHERE id=?', [id])!
      return { resourceId: id, status: 201, data: project(row) }
    })
    return { resource: saved.data, replayed: saved.replayed }
  }

  async read(ctx: RequestContext, patientId: string): Promise<Patient> {
    assertPatientScope(this.store, ctx.principal, patientId)
    return project(this.store.get<PatientRow>('SELECT * FROM patients WHERE id=?', [patientId])!)
  }

  async overview(ctx: RequestContext, patientId: string): Promise<PatientOverview> {
    const patient = await this.read(ctx, patientId)
    if (!this.options.overview) throw new DomainError('dependency_unavailable')
    return this.options.overview(ctx, patient)
  }

  async list(ctx: RequestContext, input: PageInput): Promise<Page<Patient>> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new DomainError('validation_failed')
    const scope = patientScope(this.store, ctx.principal)
    const namespace = `${ctx.principal.id}:patients`
    const boundary = input.cursor ? seekBoundary(this.options.codec.decode(namespace, input.cursor)) : null
    const rows = this.store.all<PatientRow>(`SELECT * FROM patients WHERE ${scope.sql}${boundary ? ` AND ${boundary.sql}` : ''}
      ORDER BY julianday(created_at) DESC,id DESC LIMIT ?`, [...scope.bindings, ...(boundary?.bindings ?? []), input.limit + 1])
    const items = rows.slice(0, input.limit).map(project)
    const last = items.at(-1)
    return { items, nextCursor: rows.length > input.limit && last ? this.options.codec.encode(namespace, last) : null }
  }

  async update(ctx: RequestContext, patientId: string, input: unknown): Promise<{ resource: Patient; replayed: boolean }> {
    const body = exactObject(input, ['expectedVersion', 'profile', 'recordedCondition'])
    if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1) throw new DomainError('validation_failed')
    const parsed = { expectedVersion: body.expectedVersion as number, profile: profile(body.profile), recordedCondition: condition(body.recordedCondition) }
    requireCapability(this.store, ctx.principal, 'patient.manage')
    assertPatientScope(this.store, ctx.principal, patientId)
    const saved = await withIdempotency(this.store, {
      principalId: ctx.principal.id, method: 'PATCH', resourceKey: `/patients/${patientId}`, key: ctx.idempotencyKey ?? '', payload: parsed,
    }, tx => {
      requireCapability(tx, ctx.principal, 'patient.manage')
      assertPatientScope(tx, ctx.principal, patientId)
      const current = tx.get<PatientRow>('SELECT * FROM patients WHERE id=?', [patientId])!
      if (current.version !== parsed.expectedVersion) throw new DomainError('version_conflict', { resourceId: patientId, currentVersion: current.version })
      const now = this.clock().toISOString()
      tx.run('UPDATE patients SET profile_json=?,recorded_condition=?,version=version+1,updated_by=?,updated_at=? WHERE id=? AND version=?',
        [JSON.stringify(parsed.profile), parsed.recordedCondition, ctx.principal.id, now, patientId, parsed.expectedVersion])
      tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)', [randomUUID(), ctx.principal.id, 'patient.updated', 'patient', patientId, now,
        JSON.stringify({ previousVersion: current.version, version: current.version + 1 })])
      return { resourceId: patientId, status: 200, data: project(tx.get<PatientRow>('SELECT * FROM patients WHERE id=?', [patientId])!) }
    })
    return { resource: saved.data, replayed: saved.replayed }
  }
}
