/** Clear redacted Gemini api_key fields so the component reads GEMINI_API_KEY from the environment. */
/** The key value is never read, printed, or transmitted; only the field is changed. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const BASE = (process.env.LANGFLOW_BASE_URL ?? 'http://127.0.0.1:7860').replace(/\/$/, '')
const API_KEY = process.env.LANGFLOW_API_KEY ?? ''
if (!API_KEY) {
  console.error('LANGFLOW_API_KEY (console -> Langflow) is required.')
  process.exit(2)
}

const flows = JSON.parse(await readFile(join(import.meta.dir, '..', 'flows.json'), 'utf8'))

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
}

let patched = 0

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

  const nodes = flow.data?.nodes ?? []
  let touched = false

  for (const node of nodes) {
    const tpl = node.data?.node?.template
    if (!tpl) continue

    for (const [field, spec] of Object.entries(tpl as Record<string, Record<string, unknown>>)) {
      // Only the Gemini/LLM credential fields, never other inputs.
      if (!/^api_key$|credential/i.test(field)) continue
      const current = spec?.value
      const isPlaceholder =
        current === undefined ||
        current === null ||
        current === '' ||
        String(current).includes('REDACTED')
      // Also re-clear a field a previous run left as an explicit null.
      const wasNulled = current === null && spec?.load_from_db === false

      if (!isPlaceholder && !wasNulled) continue

      // Clear the field entirely: an explicit null blocks the env fallback, and
      // a Variable binding alone was not sufficient.
      ;(tpl as Record<string, Record<string, unknown>>)[field] = {
        ...spec,
        load_from_db: false,
        value: undefined,
      }
      touched = true
      patched++
      console.log(`  bound ${key} node=${node.id ?? '(unnamed)'} field=${field}`)
    }
  }

  if (!touched) {
    console.log(`  OK   ${key}: every Gemini node already has a usable api_key`)
    continue
  }

  const put = await api(`/api/v1/flows/${flowId}`, {
    method: 'PATCH',
    body: JSON.stringify(flow),
  })
  console.log(`  ${put.ok ? 'PATCHED' : 'FAILED'} ${key} -> ${put.status}`)
  if (!put.ok) console.error(`    ${(await put.text()).slice(0, 200)}`)
}

console.log(`\n${patched} field binding(s) set.`)
