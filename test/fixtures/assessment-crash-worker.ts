import { writeFileSync } from 'node:fs'
import { Store } from '../../src/storage/database.ts'
import { AssessmentService } from '../../src/modules/assessments/service.ts'
import { CursorCodec } from '../../src/modules/contracts/pagination.ts'

interface Input {
  statePath: string; signalPath: string; patientId: string; dischargeId: string
  actorId: string; requestId: string; idempotencyKey: string; now: string
}

const input = JSON.parse(await Bun.stdin.text()) as Input
const store = Store.open({ path: input.statePath })
const service = new AssessmentService(store, {
  codec: new CursorCodec('synthetic-crash-cursor-secret-at-least-32-bytes'),
  clock: () => new Date(input.now),
  runF1: async (_sourceText, sessionId) => {
    const row = store.get<{ id: string }>('SELECT id FROM assessments WHERE session_id=?', [sessionId])
    if (!row) throw new Error('assessment_row_missing')
    writeFileSync(input.signalPath, JSON.stringify({ assessmentId: row.id, sessionId, pid: process.pid }))
    await Bun.sleep(60_000)
    return { raw: {}, outputText: JSON.stringify({}), sessionId }
  },
})
await service.run({ principal: { id: input.actorId, role: 'nurse', capabilities: [] }, requestId: input.requestId,
  idempotencyKey: input.idempotencyKey }, input.dischargeId)
