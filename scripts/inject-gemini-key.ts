/** Write the Gemini key into every Google GenerativeAI node's api_key field. */
/** Langflow redacts exports; a global Variable alone is not enough. Never printed or committed. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const BASE = (process.env.LANGFLOW_BASE_URL ?? 'http://127.0.0.1:7860').replace(/\/$/, '')
const CONSOLE_KEY = process.env.LANGFLOW_API_KEY ?? ''
const GEMINI_KEY = process.env.GEMINI_API_KEY ?? ''

if (!CONSOLE_KEY) {
  console.error('LANGFLOW_API_KEY (console -> Langflow) is required.')
  process.exit(2)
}
if (!GEMINI_KEY) {
  console.error(
    'GEMINI_API_KEY is required. Export it from ~/.env.langflow, e.g.\n' +
      '  set -a; . ~/.env.langflow; set +a; bun scripts/inject-gemini-key.ts',
  )
  process.exit(2)
}

const flows = JSON.parse(await readFile(join(import.meta.dir, '..', 'flows.json'), 'utf8'))

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'x-api-key': CONSOLE_KEY, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
}

let injected = 0

for (const [key, flowId] of Object.entries(flows)) {
  const res = await api(`/api/v1/flows/${flowId}`)
  if (!res.ok) {
    console.error(`  FAIL ${key}: GET -> ${res.status}`)
    continue
  }
  const flow = (await res.json()) as {
    data?: {
      nodes?: {
        id?: string
        data?: { id?: string; node?: { template?: Record<string, unknown> } }
      }[]
    }
  }

  let touched = false
  for (const node of flow.data?.nodes ?? []) {
    const tpl = node.data?.node?.template
    if (!tpl) continue
    const spec = (tpl as Record<string, Record<string, unknown>>).api_key
    if (!spec) continue

    const current = spec.value
    const needsKey =
      current === undefined ||
      current === null ||
      current === '' ||
      String(current).includes('REDACTED')

    if (!needsKey) continue

    ;(tpl as Record<string, Record<string, unknown>>).api_key = {
      ...spec,
      load_from_db: false,
      value: GEMINI_KEY,
    }
    touched = true
    injected++
    console.log(`  injected ${key} node=${node.id ?? node.data?.id ?? '(unnamed)'}`)
  }

  if (!touched) {
    console.log(`  OK   ${key}: no redacted api_key fields`)
    continue
  }

  const put = await api(`/api/v1/flows/${flowId}`, { method: 'PATCH', body: JSON.stringify(flow) })
  console.log(`  ${put.ok ? 'PATCHED' : 'FAILED'} ${key} -> ${put.status}`)
  if (!put.ok) console.error(`    ${(await put.text()).slice(0, 200)}`)
}

console.log(`\n${injected} field(s) populated.`)
