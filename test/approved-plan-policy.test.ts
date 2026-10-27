import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { ApprovedPlans } from '../src/modules/plans/approved.ts'
import { ApprovalEvidenceReader } from '../src/modules/reviews/approval-evidence.ts'
import { patientFixture } from './patients.test.ts'
import { NOW } from './migrations/fixture.ts'

// Characterization only: changing this policy requires an owner decision.
async function policyFixture() {
  const f = await patientFixture()
  const path = `${f.store.path}.policy-canonical`
  const canonical = new Database(path, { create: true })
  canonical.exec('CREATE TABLE approved_plans(plan_json TEXT,approved_at TEXT,reviewer_note TEXT);CREATE TABLE audit_log(action TEXT,actor TEXT,timestamp TEXT,payload TEXT)')
  canonical.close()
  const approved = new ApprovedPlans(f.store, new ApprovalEvidenceReader(path), f.codec)
  const grant = async (id: string) => {
    await f.store.transaction(tx => tx.run('INSERT INTO capability_grants VALUES (?,?,?,?,?,?,?)',
      [randomUUID(), id, 'review.decide', 'operator', NOW, null, null]))
  }
  return { ...f, approved, grant }
}

test('approved-read policy: an assigned nurse without decision capability has legacy access but C7 rejects', async () => {
  const f = await policyFixture()
  expect(f.approved.legacy(f.ctx(), f.first.id)).toEqual({ plans: [], audit: [] })
  expect(() => f.approved.list(f.ctx(), f.first.id, { limit: 20 })).toThrow(expect.objectContaining({ code: 'forbidden' }))
})

test('approved-read policy: current assigned decision-capable nurse and own patient can read both empty projections', async () => {
  const f = await policyFixture()
  await f.grant('nurse-a')
  for (const id of ['nurse-a', 'patient-a']) {
    expect(f.approved.legacy(f.ctx(id), f.first.id)).toEqual({ plans: [], audit: [] })
    expect(f.approved.list(f.ctx(id), f.first.id, { limit: 20 })).toEqual({ items: [], nextCursor: null })
  }
})

test('approved-read policy: a foreign nurse with decision capability and a foreign patient cannot read either projection', async () => {
  const f = await policyFixture()
  await f.grant('nurse-b')
  for (const id of ['nurse-b', 'patient-b']) {
    expect(() => f.approved.legacy(f.ctx(id), f.first.id)).toThrow(expect.objectContaining({ code: 'not_found' }))
    expect(() => f.approved.list(f.ctx(id), f.first.id, { limit: 20 })).toThrow(expect.objectContaining({ code: 'not_found' }))
  }
})

test('approved-read policy: current account revocation rejects both projections', async () => {
  const f = await policyFixture()
  await f.grant('nurse-a')
  await f.store.transaction(tx => tx.run('UPDATE accounts SET active=0 WHERE id=?', ['nurse-a']))
  expect(() => f.approved.legacy(f.ctx(), f.first.id)).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
  expect(() => f.approved.list(f.ctx(), f.first.id, { limit: 20 })).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
})

test('approved-read policy: assignment revocation rejects a decision-capable nurse on both projections', async () => {
  const f = await policyFixture()
  await f.grant('nurse-a')
  await f.store.transaction(tx => tx.run('UPDATE patient_assignments SET revoked_at=?,revoked_by=? WHERE patient_id=? AND nurse_account_id=?',
    [NOW, 'operator', f.first.id, 'nurse-a']))
  expect(() => f.approved.legacy(f.ctx(), f.first.id)).toThrow(expect.objectContaining({ code: 'not_found' }))
  expect(() => f.approved.list(f.ctx(), f.first.id, { limit: 20 })).toThrow(expect.objectContaining({ code: 'not_found' }))
})

test('approved-read policy: decision-capability revocation changes C7 but does not change legacy scope policy', async () => {
  const f = await policyFixture()
  await f.grant('nurse-a')
  expect(f.approved.list(f.ctx(), f.first.id, { limit: 20 }).items).toEqual([])
  await f.store.transaction(tx => tx.run('UPDATE capability_grants SET revoked_at=?,revoked_by=? WHERE account_id=? AND capability=?',
    [NOW, 'operator', 'nurse-a', 'review.decide']))
  expect(f.approved.legacy(f.ctx(), f.first.id)).toEqual({ plans: [], audit: [] })
  expect(() => f.approved.list(f.ctx(), f.first.id, { limit: 20 })).toThrow(expect.objectContaining({ code: 'forbidden' }))
})
