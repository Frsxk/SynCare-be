import { expect, test } from 'bun:test'
import { account, database, NOW } from './fixture.ts'

test('0002_identity_constraints: repeat migration and reopen retain hashed identity/session data', async () => {
  const { store, reopen } = await database()
  await account(store, 'patient-a')
  await account(store, 'nurse-a', 'nurse')
  await store.transaction(tx => {
    tx.run('INSERT INTO sessions(id,account_id,token_hash,issued_at,expires_at) VALUES (?,?,?,?,?)',
      ['session-a', 'patient-a', 'a'.repeat(64), NOW, '2026-10-25T00:00:00.000Z'])
    tx.run('INSERT INTO capability_grants(id,account_id,capability,granted_by,granted_at) VALUES (?,?,?,?,?)',
      ['grant-a', 'nurse-a', 'patient.read', 'nurse-a', NOW])
  })
  await store.migrate()
  store.close()
  const restored = reopen()
  await restored.migrate()
  expect(restored.get<{ token_hash: string }>('SELECT token_hash FROM sessions')?.token_hash).toBe('a'.repeat(64))
  expect(restored.get<{ version: number }>('SELECT version FROM accounts WHERE id=?', ['patient-a'])?.version).toBe(1)
  expect(restored.all('SELECT * FROM capability_grants')).toHaveLength(1)
  const columns = restored.all<{ name: string }>('PRAGMA table_info(accounts)').map(row => row.name)
  expect(columns).not.toContain('password')
  expect(restored.all<{ name: string }>('PRAGMA table_info(sessions)').map(row => row.name)).not.toContain('token')
})

test('identity FK, identifier, token hash, role, expiry and explicit capability constraints fail closed', async () => {
  const { store } = await database()
  await account(store, 'patient-a')
  await account(store, 'nurse-a', 'nurse')
  await expect(account(store, 'bad-role', 'admin')).rejects.toThrow()
  await expect(store.transaction(tx => tx.run(
    'UPDATE accounts SET identifier=? WHERE id=?', ['NURSE-A@SYNTHETIC.INVALID', 'patient-a'],
  ))).rejects.toThrow()
  for (const [accountId, hash, expiry] of [
    ['missing', 'b'.repeat(64), '2026-10-25T00:00:00Z'],
    ['patient-a', 'plaintext', '2026-10-25T00:00:00Z'],
    ['patient-a', 'b'.repeat(64), '2026-10-23T00:00:00Z'],
    ['patient-a', 'b'.repeat(64), 'not-a-date'],
  ]) {
    await expect(store.transaction(tx => tx.run(
      'INSERT INTO sessions(id,account_id,token_hash,issued_at,expires_at) VALUES (?,?,?,?,?)',
      ['invalid-session', accountId!, hash!, NOW, expiry!],
    ))).rejects.toThrow()
  }
  expect(store.all('SELECT * FROM sessions')).toHaveLength(0)
  expect(store.all('SELECT * FROM capability_grants')).toHaveLength(0)
  expect(store.get<{ active: number }>('SELECT active FROM accounts WHERE id=?', ['patient-a'])?.active).toBe(0)
  await expect(store.transaction(tx => tx.run("UPDATE accounts SET updated_at='not-a-date'"))).rejects.toThrow()
  await expect(store.transaction(tx => tx.run("UPDATE accounts SET role='nurse' WHERE id='patient-a'"))).rejects.toThrow()
  await store.transaction(tx => tx.run(
    'INSERT INTO sessions(id,account_id,token_hash,issued_at,expires_at) VALUES (?,?,?,?,?)',
    ['s1', 'patient-a', 'c'.repeat(64), NOW, '2026-10-25T00:00:00Z'],
  ))
  await expect(store.transaction(tx => tx.run(
    'INSERT INTO sessions(id,account_id,token_hash,issued_at,expires_at) VALUES (?,?,?,?,?)',
    ['s2', 'nurse-a', 'c'.repeat(64), NOW, '2026-10-25T00:00:00Z'],
  ))).rejects.toThrow()
  await expect(store.transaction(tx => tx.run('DELETE FROM accounts WHERE id=?', ['patient-a']))).rejects.toThrow()
  await store.transaction(tx => tx.run('UPDATE sessions SET revoked_at=? WHERE id=?', [NOW, 's1']))
  expect(store.get<{ revoked_at: string }>('SELECT revoked_at FROM sessions')?.revoked_at).toBe(NOW)
})

test('capability grants are explicit, unique while active and retained after revocation', async () => {
  const { store } = await database()
  await account(store, 'nurse-a', 'nurse')
  await account(store, 'patient-a')
  const grant = (id: string, accountId = 'nurse-a') => store.transaction(tx => tx.run(
    'INSERT INTO capability_grants(id,account_id,capability,granted_by,granted_at) VALUES (?,?,?,?,?)',
    [id, accountId, 'patient.manage', 'nurse-a', NOW],
  ))
  await expect(grant('bad', 'missing')).rejects.toThrow()
  await expect(grant('bad', 'patient-a')).rejects.toThrow()
  await grant('g1')
  await expect(grant('g2')).rejects.toThrow()
  await expect(store.transaction(tx => tx.run("UPDATE capability_grants SET revoked_at='invalid',revoked_by='nurse-a'"))).rejects.toThrow()
  await store.transaction(tx => tx.run('UPDATE capability_grants SET revoked_at=?,revoked_by=? WHERE id=?', [NOW, 'nurse-a', 'g1']))
  await grant('g2')
  await expect(store.transaction(tx => tx.run('UPDATE capability_grants SET revoked_at=NULL,revoked_by=NULL WHERE id=?', ['g1']))).rejects.toThrow()
  await expect(store.transaction(tx => tx.run('DELETE FROM capability_grants'))).rejects.toThrow()
  expect(store.all('SELECT * FROM capability_grants')).toHaveLength(2)
})
