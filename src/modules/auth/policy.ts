import type { Store } from '../../storage/database.ts'
import type { Principal } from '../contracts/errors.ts'
import { assertPatientScope, currentIdentity, requireCapability } from '../patients/service.ts'

export class Policy {
  constructor(private readonly store: Store) {}
  async authorize(principal: Principal, capability: string, resource: { patientId: string }): Promise<void> {
    currentIdentity(this.store, principal)
    if (capability !== 'patient.read') requireCapability(this.store, principal, capability)
    assertPatientScope(this.store, principal, resource.patientId)
  }
}
