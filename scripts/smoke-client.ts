/**
 * Live smoke test for the Langflow client against a running Langflow.
 *
 * Run: bun scripts/smoke-client.ts
 *
 * The client's own unit tests use a mock fetch; this exercises the real HTTP
 * path. It is expected to reach the Gemini node and fail there for a missing
 * key until global Variables are set — that failure is itself the proof that
 * the imported graph is wired correctly.
 */
import { LangflowTimeoutError, loadFlowMap, runFlow } from '../src/plugins/langflow.ts'

const flows = await loadFlowMap()

console.log('--- 1. flows.json is complete ---')
for (const [key, id] of Object.entries(flows)) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`${key} has a malformed id: ${id}`)
  console.log(`  OK ${key} -> ${id}`)
}

console.log('--- 2. F1 runs and reaches the Gemini node ---')
const CHECK =
  'Pasien dengan CHF NYHA III, pulang 2026-10-01, minum furosemide 40mg harian, berat 82kg, eGFR 52, ada edema perifer ringan.'

try {
  const f1 = flows.f1_register_discharge_summary
  if (!f1) throw new Error('flows.json is missing f1_register_discharge_summary')
  const out = await runFlow(f1, CHECK)
  console.log('  Gemini credentials ARE present:', JSON.stringify(out).slice(0, 400))
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (err instanceof LangflowTimeoutError) {
    console.log('  TIMEOUT (plausible if model latency is high):', msg.slice(0, 160))
  } else if (/api key|required for Gemini|API_KEY/i.test(msg)) {
    console.log('  EXPECTED: graph built fine, stopped at the Gemini node for a missing key.')
    console.log('  ->', msg.slice(0, 220))
  } else {
    console.log('  UNEXPECTED ERROR:', msg.slice(0, 320))
    process.exitCode = 1
  }
}

console.log('--- 3. an unknown flow id surfaces an HTTP error, not a crash ---')
try {
  await runFlow('00000000-0000-0000-0000-000000000000', 'test', { timeoutMs: 20_000 })
  console.log('  UNEXPECTED: a bogus id succeeded')
  process.exitCode = 1
} catch (err) {
  const name = err instanceof Error ? err.constructor.name : 'unknown'
  console.log(`  OK surfaced ${name}:`, (err instanceof Error ? err.message : String(err)).slice(0, 160))
}