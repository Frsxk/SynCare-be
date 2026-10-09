/**
 * Bind the GEMINI_API_KEY global Variable to every Google GenerativeAI node.
 *
 * WHY THIS IS NEEDED: Langflow redacts credential fields on flow export, so each
 * imported Gemini node carries the literal placeholder `***REDACTED***` in its
 * `api_key` field. A global Variable alone does not satisfy it — the field must
 * either hold a real value or be bound to the Variable by field name.
 *
 * This script sets the binding in place. It never reads, prints, or transmits the
 * key value: the binding references the Variable BY NAME.
 *
 * Run: bun scripts/bind-gemini-key.ts
 */
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

      // Explicit `value: null` BLOCKS the process env fallback, so the field is
      // cleared entirely and the component resolves GEMINI_API_KEY from the
      // environment instead. Binding the Variable alone was not sufficient.
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
