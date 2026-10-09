/**
 * Rewrite F5's Python-level path constants to this container's writable paths.
 *
 * WHY a separate script: DEFAULT_PROTOCOL_DIR and DEFAULT_PERSIST_DIR are plain
 * module constants inside the component's code, NOT node template fields, so
 * they cannot be fixed through the node PATCH used by scripts/fix-f5-paths.ts.
 * Editing the code string is the only way to redirect them.
 *
 * The review-DB path is handled by fix-f5-paths.ts as a real field.
 *
 * These are synthetic demo protocol documents on a bind mount; nothing clinical
 * is modified. Run: bun scripts/patch-f5-constants.ts
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const BASE = (process.env.LANGFLOW_BASE_URL ?? 'http://127.0.0.1:7860').replace(/\/$/, '')
const API_KEY = process.env.LANGFLOW_API_KEY ?? ''
if (!API_KEY) {
  console.error('LANGFLOW_API_KEY is required.')
  process.exit(2)
}

const REPLACEMENTS: [RegExp, string][] = [
  [/DEFAULT_PROTOCOL_DIR\s*=\s*["'][^"']*["']/, 'DEFAULT_PROTOCOL_DIR = "/app/langflow/langflow/protocols"'],
  [/DEFAULT_PERSIST_DIR\s*=\s*["'][^"']*["']/, 'DEFAULT_PERSIST_DIR = "/app/langflow/langflow/syncare-f5-chroma"'],
  [/DEFAULT_DB_PATH\s*=\s*["'][^"']*["']/, 'DEFAULT_DB_PATH = "/app/langflow/langflow/syncare-review.sqlite3"'],
]

const flows = JSON.parse(await readFile(join(import.meta.dir, '..', 'flows.json'), 'utf8'))
const flowId = flows.f5_answer_care_questions

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
}

const res = await api(`/api/v1/flows/${flowId}`)
if (!res.ok) {
  console.error(`GET flow -> ${res.status}`)
  process.exit(1)
}
const flow = (await res.json()) as {
  data?: { nodes?: { id?: string; data?: { id?: string; node?: { template?: Record<string, unknown> } } }[] }
}

let patchedNodes = 0
for (const node of flow.data?.nodes ?? []) {
  const tpl = node.data?.node?.template
  if (!tpl) continue
  const codeSpec = tpl.code as Record<string, unknown> | undefined
  const code = codeSpec?.value
  if (typeof code !== 'string' || !code.includes('DEFAULT_PROTOCOL_DIR')) continue

  let updated = code
  for (const [pattern, replacement] of REPLACEMENTS) {
    if (pattern.test(updated)) updated = updated.replace(pattern, replacement)
  }

  if (updated === code) {
    console.log(`  node=${node.id ?? node.data?.id}: already remapped`)
    continue
  }

  console.log(`  node=${node.id ?? node.data?.id}: remapped path constants`)
  for (const line of updated.split('\n')) {
    if (line.startsWith('DEFAULT_')) console.log(`    ${line}`)
  }
  codeSpec!.value = updated
  patchedNodes++
}

if (patchedNodes === 0) {
  console.log('\nNothing to patch.')
  process.exit(0)
}

const put = await api(`/api/v1/flows/${flowId}`, { method: 'PATCH', body: JSON.stringify(flow) })
console.log(`\nPATCH -> ${put.status}`)
if (!put.ok) console.error((await put.text()).slice(0, 300))