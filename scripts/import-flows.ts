import {unprotectEnvironment} from '../src/security/private-files.cjs'
unprotectEnvironment()
/** Import the five verified flows and print the name -> id map. */
/** Secrets come from the environment only and are never printed. */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const BASE = (process.env.LANGFLOW_BASE_URL ?? 'http://127.0.0.1:7860').replace(/\/$/, '')
const API_KEY = process.env.LANGFLOW_API_KEY ?? ''

if (!API_KEY) {
  console.error('LANGFLOW_API_KEY is required. Mint one in the Langflow UI and put it in .env.')
  process.exit(2)
}

const FLOWS_DIR = join(import.meta.dir, '..', 'flows')

/** Node counts verified against the source repo; a mismatch means a truncated copy. */
const EXPECTED_NODES: Record<string, number> = {
  'register_discharge_summary.json': 4,
  'record_patient_checkin.json': 7,
  'draft_followup_plan.json': 6,
  'review_care_plan.json': 12,
  'answer_care_questions.json': 11,
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'x-api-key': API_KEY,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
}

async function main() {
  const files = (await readdir(FLOWS_DIR)).filter((f) => f.endsWith('.json')).sort()
  if (files.length === 0) {
    console.error(`No flow JSON files in ${FLOWS_DIR}`)
    process.exit(1)
  }

  let failed = 0
  for (const file of files) {
    const raw = await readFile(join(FLOWS_DIR, file), 'utf8')
    const flow = JSON.parse(raw)

    const name: string = flow?.name ?? '(unnamed)'
    const nodeCount: number = flow?.data?.nodes?.length ?? 0
    const expected = EXPECTED_NODES[file]

    if (expected !== undefined && nodeCount !== expected) {
      console.error(`  SKIP ${file}: node count ${nodeCount}, expected ${expected}; refusing to import a truncated flow`)
      failed++
      continue
    }

    const res = await api('/api/v1/flows/', { method: 'POST', body: JSON.stringify(flow) })
    if (!res.ok) {
      console.error(`  FAIL ${file} -> ${res.status} ${await res.text()}`)
      failed++
      continue
    }

    const created = (await res.json()) as { id?: string }
    console.log(`  OK   ${file}  "${name}"  nodes=${nodeCount}  id=${created.id}`)
  }

  if (failed > 0) {
    console.error(`\n${failed} flow(s) failed to import.`)
    process.exit(1)
  }
  console.log(`\nImported ${files.length} flow(s).`)
}

await main()
