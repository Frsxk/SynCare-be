import {unprotectEnvironment} from '../src/security/private-files.cjs'
unprotectEnvironment()
/** Repoint F5's hardcoded /home/frxskie paths at this container's writable bind mount. */
/** Without this the flow fails with Permission denied; F4 remains the only writer. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const BASE = (process.env.LANGFLOW_BASE_URL ?? 'http://127.0.0.1:7860').replace(/\/$/, '')
const API_KEY = process.env.LANGFLOW_API_KEY ?? ''
if (!API_KEY) {
  console.error('LANGFLOW_API_KEY is required.')
  process.exit(2)
}

const REMAP: Record<string, string> = {
  // Node template fields override the module-level DEFAULT_* constants, so
  // patching the constants alone is not enough. Names are protocol_directory / persist_directory / db_path.
  protocol_directory: '/app/langflow/langflow/protocols',
  persist_directory: '/app/langflow/langflow/syncare-f5-chroma',
  db_path: '/app/langflow/langflow/syncare-review.sqlite3',
}

const flows = JSON.parse(await readFile(join(import.meta.dir, '..', 'flows.json'), 'utf8'))
const flowId = flows.f5_answer_care_questions
if (!flowId) {
  console.error('flows.json has no f5_answer_care_questions entry.')
  process.exit(1)
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
}

const res = await api(`/api/v1/flows/${flowId}`)
if (!res.ok) {
  console.error(`GET flow -> ${res.status} ${await res.text()}`)
  process.exit(1)
}
const flow = (await res.json()) as {
  data?: {
    nodes?: {
      id?: string
      data?: { id?: string; node?: { template?: Record<string, Record<string, unknown>> } }
    }[]
  }
}

let patched = 0
for (const node of flow.data?.nodes ?? []) {
  const tpl = node.data?.node?.template
  if (!tpl) continue

  for (const [field, value] of Object.entries(REMAP)) {
    const spec = tpl[field]
    if (!spec || typeof spec !== 'object') continue
    const current = String((spec as Record<string, unknown>).value ?? '')
    if (!current.includes('/home/frxskie') && current !== value) continue

    console.log(`  node=${node.id ?? node.data?.id} field=${field}`)
    console.log(`    from: ${current || '(empty)'}`)
    console.log(`    to:   ${value}`)
    ;(tpl as Record<string, Record<string, unknown>>)[field] = { ...spec, value }
    patched++
  }
}

if (patched === 0) {
  console.log('\nNothing to patch (paths already remapped).')
  process.exit(0)
}

const put = await api(`/api/v1/flows/${flowId}`, { method: 'PATCH', body: JSON.stringify(flow) })
console.log(`\nPATCH -> ${put.status}`)
if (!put.ok) console.error((await put.text()).slice(0, 300))
else console.log('Restart Langflow so components re-read the patched defaults.')
