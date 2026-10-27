import { expect, test } from 'bun:test'
import { account, database, NOW } from './fixture.ts'

async function patient(store: Awaited<ReturnType<typeof database>>['store'], id: string) {
  await store.transaction(tx => tx.run(
    'INSERT INTO patients(id,profile_json,recorded_condition,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    [id, '{"displayName":"Pasien sintetis"}', 'Recorded synthetic condition', 'nurse-a', 'nurse-a', NOW, NOW],
  ))
}
test('0003_patients_constraints: version/source survive repeat migration and normal restart', async () => {
  const { store, reopen } = await database()
  await account(store, 'nurse-a', 'nurse')
  await account(store, 'patient-a')
  await patient(store, 'p1')
  await store.transaction(tx => {
    tx.run('INSERT INTO patient_account_links(patient_id,account_id,linked_by,linked_at) VALUES (?,?,?,?)', ['p1', 'patient-a', 'nurse-a', NOW])
    tx.run('INSERT INTO patient_assignments(id,patient_id,nurse_account_id,granted_by,effective_at) VALUES (?,?,?,?,?)', ['a1', 'p1', 'nurse-a', 'nurse-a', NOW])
    tx.run('INSERT INTO discharge_versions(id,patient_id,episode_id,version,source_text,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
      ['d1', 'p1', 'e1', 1, '  Original synthetic discharge\nsource  ', 'nurse-a', NOW])
  })
  await store.migrate()
  store.close()
  const restored = reopen()
  await restored.migrate()
  expect(restored.get<{ source_text: string }>('SELECT source_text FROM discharge_versions')?.source_text).toBe('  Original synthetic discharge\nsource  ')
  expect(restored.get<{ version: number }>('SELECT version FROM patients')?.version).toBe(1)
  expect(restored.get<{ linked_at: string }>('SELECT linked_at FROM patient_account_links')?.linked_at).toBe(NOW)
})
test('patient links, active assignments and immutable discharge history enforce relational ownership', async () => {
  const { store } = await database()
  await account(store, 'nurse-a', 'nurse')
  await account(store, 'patient-a')
  await patient(store, 'p1')
  await patient(store, 'p2')
  const link = (patientId: string, accountId: string) => store.transaction(tx => tx.run(
    'INSERT INTO patient_account_links(patient_id,account_id,linked_by,linked_at) VALUES (?,?,?,?)', [patientId, accountId, 'nurse-a', NOW],
  ))
  await expect(link('missing', 'patient-a')).rejects.toThrow()
  await expect(link('p1', 'nurse-a')).rejects.toThrow()
  await link('p1', 'patient-a')
  await expect(link('p2', 'patient-a')).rejects.toThrow()
  const assign = (id: string, nurse = 'nurse-a') => store.transaction(tx => tx.run(
    'INSERT INTO patient_assignments(id,patient_id,nurse_account_id,granted_by,effective_at) VALUES (?,?,?,?,?)', [id, 'p1', nurse, 'nurse-a', NOW],
  ))
  await expect(assign('bad', 'patient-a')).rejects.toThrow()
  await assign('a1')
  await expect(assign('a2')).rejects.toThrow()
  await store.transaction(tx => tx.run('UPDATE patient_assignments SET revoked_at=?,revoked_by=? WHERE id=?', [NOW, 'nurse-a', 'a1']))
  await assign('a2')
  expect(store.all('SELECT * FROM patient_assignments')).toHaveLength(2)
  const discharge = (id: string, version: number) => store.transaction(tx => tx.run(
    'INSERT INTO discharge_versions(id,patient_id,episode_id,version,source_text,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
    [id, 'p1', 'e1', version, `Synthetic source ${version}`, 'nurse-a', NOW],
  ))
  await discharge('d1', 1)
  await expect(discharge('duplicate', 1)).rejects.toThrow()
  await discharge('d2', 2)
  await expect(store.transaction(tx => tx.run('INSERT INTO discharge_versions(id,patient_id,episode_id,version,source_text,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
    ['cross-patient', 'p2', 'e1', 3, 'Synthetic different patient', 'nurse-a', NOW]))).rejects.toThrow()
  await expect(store.transaction(tx => tx.run("UPDATE discharge_versions SET source_text='changed'"))).rejects.toThrow()
  await expect(store.transaction(tx => tx.run('DELETE FROM discharge_versions'))).rejects.toThrow()
  await expect(store.transaction(tx => tx.run('DELETE FROM patients WHERE id=?', ['p1']))).rejects.toThrow()
  await expect(store.transaction(tx => tx.run("UPDATE patients SET profile_json='[]'"))).rejects.toThrow()
  expect(store.all('SELECT * FROM discharge_versions')).toHaveLength(2)
})

test('upgrading an existing operations-only database preserves records through migrations 0002/0003', async () => {
  const { store, reopen } = await database(1)
  await store.transaction(tx => tx.run('INSERT INTO operational_audit VALUES (?,?,?,?,?,?,?)', ['before-upgrade', 'operator', 'fixture', 'test', 'test', NOW, '{}']))
  expect(store.get("SELECT name FROM sqlite_master WHERE name='accounts'")).toBeNull()
  await store.migrate()
  await account(store, 'nurse-a', 'nurse')
  await patient(store, 'preserved')
  store.close()
  const restored = reopen()
  await restored.migrate()
  expect(restored.get<{ id: string }>('SELECT id FROM patients')?.id).toBe('preserved')
  expect(restored.get<{ id: string }>('SELECT id FROM operational_audit')?.id).toBe('before-upgrade')
})
