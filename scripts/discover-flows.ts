/**
 * Resolve SynCare flow IDs BY NAME and write flows.json.
 *
 * Run:  bun scripts/discover-flows.ts
 *
 * Design rules:
 *  - Never hardcode a flow ID. IDs are assigned by whichever Langflow instance
 *    imported the export, so they differ per install.
 *  - Exit non-zero if any expected flow is missing, so a partial map can never
 *    be mistaken for a complete one.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const BASE = (process.env.LANGFLOW_BASE_URL ?? 'http://127.0.0.1:7860').replace(/\/$/, '')
const API_KEY = process.env.LANGFLOW_API_KEY ?? ''

if (!API_KEY) {
  console.error('LANGFLOW_API_KEY is required.')
  process.exit(2)
}

/** Canonical key -> the flow `name` Langflow stores. Matched exactly, then case-insensitively. */
const EXPECTED: Record<string, string> = {
  f1_register_discharge_summary: 'register_discharge_summary',
  f2_record_patient_checkin: 'record_patient_checkin',
  f3_draft_followup_plan: 'draft_followup_plan',
  f4_review_care_plan: 'review_care_plan',
  f5_answer_care_questions: 'answer_care_questions',
}

type Flow = { id: string; name: string }

async function main() {
  const res = await fetch(`${BASE}/api/v1/flows/`, { headers: { 'x-api-key': API_KEY } })
  if (!res.ok) {
    console.error(`GET /api/v1/flows/ -> ${res.status} ${await res.text()}`)
    process.exit(1)
  }

  const flows = (await res.json()) as Flow[]
  console.log(`Server reports ${flows.length} flow(s).`)

  const mapping: Record<string, string> = {}
  const missing: string[] = []

  for (const [key, name] of Object.entries(EXPECTED)) {
    const exact = flows.find((f) => f.name === name)
    const loose = exact ?? flows.find((f) => f.name?.toLowerCase() === name.toLowerCase())
    if (loose) {
      mapping[key] = loose.id
      console.log(`  OK   ${key} -> ${loose.name} (${loose.id})`)
    } else {
      missing.push(key)
      console.error(`  MISS ${key}: no flow named "${name}"`)
    }
  }

  // Surface anything unexpected so a polluted instance is visible, not silent.
  const known = new Set(Object.values(EXPECTED))
  const extras = flows.filter((f) => !known.has(f.name) && !Object.values(mapping).includes(f.id))
  if (extras.length > 0) {
    console.log(`\nOther flows present on this instance (ignored):`)
    for (const f of extras) console.log(`  - ${f.name} (${f.id})`)
  }

  if (missing.length > 0) {
    console.error(`\nIncomplete manifest: ${missing.length} flow(s) unresolved. flows.json NOT written.`)
    process.exit(1)
  }

  const out = join(import.meta.dir, '..', 'flows.json')
  await writeFile(out, `${JSON.stringify(mapping, null, 2)}\n`)
  console.log(`\nWrote ${out} with ${Object.keys(mapping).length} entries.`)
}

await main()