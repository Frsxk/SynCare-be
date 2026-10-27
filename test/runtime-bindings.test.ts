import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FLOW_KEYS,
  F5_ROLES,
  RuntimeBindingError,
  assertCandidateLocation,
  buildCandidateBundle,
  hashFlowEdges,
  hashNodeCode,
  inspectRuntimeBindings,
  loadReviewedReference,
  privateEnvironmentKnownSecrets,
  reviewedContentContext,
  reviewedFlowContent,
  reviewedFlowContentDigest,
  scanFlowForSecrets,
  selectEngineFlows,
  stageCandidateBundle,
  topologyFingerprint,
  validateOfflineBundle,
  verifyCandidate,
  type FlowDefinition,
  type FlowKey,
  type LoadedReference,
} from '../scripts/lib/runtime-bindings.ts'
import { runRuntimeBindingsCli } from '../scripts/runtime-bindings.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SHIPPED = join(ROOT, 'flows')
const CONFIG = join(ROOT, 'config')
const FLOWS_JSON = join(ROOT, 'flows.json')
const FIXED_NOW = new Date('2026-10-27T12:00:00.000Z')
const FIXED_ISO = FIXED_NOW.toISOString()
const TEST_FOLDER = '11111111-1111-4111-8111-111111111111'
const TEST_PROJECT = '22222222-2222-4222-8222-222222222222'
const TEST_FLOW_IDS = [
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
]
const SHIPPED_FILES: Record<FlowKey, string> = {
  f1_register_discharge_summary: 'register_discharge_summary.json',
  f2_record_patient_checkin: 'record_patient_checkin.json',
  f3_draft_followup_plan: 'draft_followup_plan.json',
  f4_review_care_plan: 'review_care_plan.json',
  f5_answer_care_questions: 'answer_care_questions.json',
}
const ROLE_HASHES = {
  scorer: '6c81adf2420034150ac3afbab2278f118fa87835090b5abd565712273b00c22b',
  guard: '7649d5609416c0ac659993e6ec8e205e4a598bbec55d4bd208a4b643e37eb43a',
  retriever: 'c85e69533771000cf910c83fb41e77df9d8d4d8b80a695a314d5506258d02c61',
  verifier: '52bad0f112d1876268eb9cede4c3c55e38539c237f000a0f40e8a8c6cbd54ea5',
} as const

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const readJson = (path: string): any => JSON.parse(readFileSync(path, 'utf8'))
const jsonText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function temp(prefix = 'syncare-runtime-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function nodeTemplate(node: any): Record<string, any> {
  return node?.data?.node?.template ?? {}
}

function nodeCodeHash(node: any): string | null {
  const code = nodeTemplate(node).code?.value
  return typeof code === 'string' ? sha256(code) : null
}

function nodeByCode(flow: FlowDefinition, codeSha256: string): any {
  const node = (flow.data?.nodes ?? []).find((candidate: any) => nodeCodeHash(candidate) === codeSha256)
  if (!node) throw new Error(`missing synthetic role node ${codeSha256}`)
  return node
}

function remapFlow(source: any, prefix: string, flowId: string, canonicalPath: string): FlowDefinition {
  const flow = clone(source)
  const idMap = new Map<string, string>()
  for (const [index, node] of flow.data.nodes.entries()) idMap.set(node.id, `TestNode-${prefix}-${index}`)
  flow.id = flowId
  flow.folder_id = TEST_FOLDER
  flow.project_id = TEST_PROJECT
  for (const node of flow.data.nodes) {
    node.id = idMap.get(node.id)!
    if (typeof node.data?.id === 'string') node.data.id = node.id
    const template = nodeTemplate(node)
    if (template._frontend_node_flow_id && typeof template._frontend_node_flow_id.value === 'string') {
      template._frontend_node_flow_id.value = flowId
    }
    if (template.db_path && typeof template.db_path.value === 'string') template.db_path.value = canonicalPath
    if (template.gate_id && typeof template.gate_id.value === 'string' && idMap.has(template.gate_id.value)) {
      template.gate_id.value = idMap.get(template.gate_id.value)!
    }
  }
  for (const [index, edge] of flow.data.edges.entries()) {
    edge.source = idMap.get(edge.source)!
    edge.target = idMap.get(edge.target)!
    if (typeof edge.id === 'string') edge.id = `TestEdge-${prefix}-${index}`
    if (typeof edge.data?.sourceHandle?.id === 'string') edge.data.sourceHandle.id = idMap.get(edge.data.sourceHandle.id)!
    if (typeof edge.data?.targetHandle?.id === 'string') edge.data.targetHandle.id = idMap.get(edge.data.targetHandle.id)!
    for (const [field, endpoint] of [['sourceHandle', 'source'], ['targetHandle', 'target']] as const) {
      if (typeof edge[field] === 'string') {
        const handle = JSON.parse(edge[field].replaceAll('œ', '"'))
        handle.id = edge[endpoint]
        edge[field] = JSON.stringify(handle).replaceAll('"', 'œ')
      }
    }
  }
  return flow
}

function syntheticReference(root: string, canonicalPath: string) {
  const referenceDir = join(root, 'reference')
  mkdirSync(referenceDir, { recursive: true })
  const flows = {} as Record<FlowKey, FlowDefinition>
  const files: Record<string, string> = {}
  const flowSpecs: Record<string, any> = {}
  for (const [index, key] of FLOW_KEYS.entries()) {
    const source = readJson(join(SHIPPED, SHIPPED_FILES[key]))
    const flow = remapFlow(source, `Ref-${index}`, TEST_FLOW_IDS[index]!, canonicalPath)
    for (const node of flow.data!.nodes ?? []) {
      const selected = nodeTemplate(node).flow_id_selected
      if (selected) selected.value = TEST_FLOW_IDS[2]!
    }
    for (const edge of flow.data!.edges ?? []) {
      edge.data = {...(edge.data ?? {}), condition: 'reviewed-condition'}
    }
    const text = jsonText(flow)
    const file = SHIPPED_FILES[key]
    writeFileSync(join(referenceDir, file), text)
    flows[key] = flow
    files[file] = text
    flowSpecs[key] = { file, sha256: sha256(text) }
  }
  flowSpecs.f2_record_patient_checkin.roles = {
    scorer: { nodeType: 'CustomComponent', codeSha256: ROLE_HASHES.scorer, requiredInputs: ['baseline_score', 'patient_id'] },
  }
  flowSpecs.f5_answer_care_questions.roles = {
    guard: { nodeType: 'CustomComponent', codeSha256: ROLE_HASHES.guard, requiredInputs: ['input_value'] },
    retriever: { nodeType: 'CustomComponent', codeSha256: ROLE_HASHES.retriever, requiredInputs: ['db_path', 'input_value'] },
    verifier: { nodeType: 'CustomComponent', codeSha256: ROLE_HASHES.verifier, requiredInputs: ['retrieved'] },
  }
  const manifest = {
    schemaVersion: 1,
    kind: 'syncare-runtime-reference',
    review: {
      approved: true,
      reviewer: 'Synthetic test reviewer',
      reviewedAt: FIXED_ISO,
      note: 'Test-only reviewed bundle; not production approval.',
    },
    target: { folderId: TEST_FOLDER, projectId: TEST_PROJECT, canonicalReviewDbPath: canonicalPath },
    flows: flowSpecs,
  }
  const manifestPath = join(referenceDir, 'runtime-binding-reference.json')
  writeFileSync(manifestPath, jsonText(manifest))
  return { referenceDir, manifestPath, manifest, files, flows }
}

function loadSyntheticReference(root: string, canonicalPath: string): LoadedReference {
  const fixture = syntheticReference(root, canonicalPath)
  return loadReviewedReference(fixture.referenceDir)
}

function gateNodes(flow: FlowDefinition): any[] {
  return (flow.data?.nodes ?? []).filter((node: any) => nodeTemplate(node).action !== undefined)
}

function reviewedContext(flows: Record<FlowKey, FlowDefinition>, key: FlowKey) {
  const flowsById = new Map(FLOW_KEYS.map(item => [flows[item].id!, item]))
  return reviewedContentContext(flows[key], flowsById, {folderId: TEST_FOLDER, projectId: TEST_PROJECT})
}

function reviewedGateActions(flow: FlowDefinition): string[] {
  return gateNodes(flow).map(node => nodeTemplate(node).action.value).sort()
}

function liveFlows(reference: LoadedReference, canonicalPath: string): Record<FlowKey, FlowDefinition> {
  const flows = {} as Record<FlowKey, FlowDefinition>
  const liveIds = new Map<string, string>()
  for (const [index, key] of FLOW_KEYS.entries()) liveIds.set(key, `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${index + 1}`)
  const referenceToLive = new Map(FLOW_KEYS.map(key => [reference.flows[key].id!, liveIds.get(key)!]))
  for (const [index, key] of FLOW_KEYS.entries()) {
    const flow = remapFlow(reference.flows[key], `Live-${index}`, liveIds.get(key)!, canonicalPath)
    for (const node of flow.data!.nodes ?? []) {
      const selected = nodeTemplate(node).flow_id_selected
      if (selected && typeof selected.value === 'string' && referenceToLive.has(selected.value)) {
        selected.value = referenceToLive.get(selected.value)!
      }
    }
    flows[key] = flow
  }
  return flows
}

function makeCandidate(root: string) {
  mkdirSync(root, { recursive: true })
  const db = join(root, 'syncare-review.sqlite3')
  writeFileSync(db, 'synthetic sqlite placeholder')
  const reference = loadSyntheticReference(join(root, 'fixture'), db)
  const live = liveFlows(reference, db)
  const bundle = buildCandidateBundle({ reference, liveFlows: live, now: FIXED_NOW, expectedCanonicalReviewDbPath: db })
  const outputDir = join(root, 'candidate')
  const staged = stageCandidateBundle({ outputDir, bundle })
  return { db, reference, live, bundle, outputDir, staged }
}

function activeSnapshot(): Record<string, string> {
  return Object.fromEntries(
    [FLOWS_JSON, join(CONFIG, 'f2-context.demo.json'), join(CONFIG, 'f5-runtime.demo.json')]
      .map(path => [path, sha256(readFileSync(path, 'utf8'))]),
  )
}

function serveFlows(flows: Record<string, any>) {
  const requests: Array<{ method: string; path: string; apiKey: string | null }> = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push({ method: request.method, path: url.pathname, apiKey: request.headers.get('x-api-key') })
      if (request.method !== 'GET') return new Response('mutation forbidden', { status: 405 })
      if (url.pathname === '/api/v1/flows/') {
        return Response.json(Object.values(flows).map((flow: any) => ({
          id: flow.id,
          name: flow.name,
          folder_id: flow.folder_id,
          project_id: flow.project_id,
        })))
      }
      const match = /^\/api\/v1\/flows\/([^/]+)$/.exec(url.pathname)
      if (!match) return new Response('not found', { status: 404 })
      const flow = Object.values(flows).find((candidate: any) => candidate.id === decodeURIComponent(match[1]!))
      return flow ? Response.json(flow) : new Response('not found', { status: 404 })
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  }
}

async function captureError(action: () => unknown | Promise<unknown>): Promise<RuntimeBindingError> {
  try {
    await action()
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeBindingError)
    return error as RuntimeBindingError
  }
  throw new Error('expected RuntimeBindingError')
}

function thrownCode(action: () => unknown): string | null {
  try {
    action()
    return null
  } catch (error) {
    return (error as RuntimeBindingError).code
  }
}

describe('offline shipped-bundle validation', () => {
  test('runtime hash canonicalization is the exact runtime guard semantics', () => {
    const f2 = readJson(join(SHIPPED, SHIPPED_FILES.f2_record_patient_checkin))
    const f2Config = readJson(join(CONFIG, 'f2-context.demo.json'))
    const scorer = f2.data.nodes.find((node: any) => node.id === 'CustomComponent-uFKzq')
    expect(hashNodeCode(scorer)).toBe(f2Config.scorerCodeSha256)

    const f5 = readJson(join(SHIPPED, SHIPPED_FILES.f5_answer_care_questions))
    const f5Config = readJson(join(CONFIG, 'f5-runtime.demo.json'))
    expect(hashFlowEdges(f5)).toBe('3b5584d0f6c94178f58045d03593f2cd4f941c439eca21f538da7e89db76995a')
    expect(hashFlowEdges(f5)).toBe(f5Config.edgesSha256)
  })

  test('accepts the bundle rebound to the deployed engine generation', () => {
    const report = validateOfflineBundle()
    expect(report.findings).toEqual([])
    expect(report.status).toBe('match')

    const f2Config = readJson(join(CONFIG, 'f2-context.demo.json'))
    expect(f2Config.scorerId).toBe('CustomComponent-uFKzq')
    expect(f2Config.scorerCodeSha256).toBe(ROLE_HASHES.scorer)

    const f5Config = readJson(join(CONFIG, 'f5-runtime.demo.json'))
    expect(Object.keys(f5Config.components).sort()).toEqual([
      'SynCareAnswerVerifier-V1', 'SynCareRedFlagGuard-A1', 'SynCareRetriever-R1',
    ])
    expect(f5Config.components['SynCareRetriever-R1']).toBe('c85e69533771000cf910c83fb41e77df9d8d4d8b80a695a314d5506258d02c61')
    expect(f5Config.folderId).toBe('d042a6d9-7a43-4a59-b44d-73859cb0d39c')
  })

  test('still reports a manifest flow-id mismatch against a foreign map', () => {
    const root = temp()
    const flowsJsonPath = join(root, 'flows.json')
    const manifest = readJson(FLOWS_JSON)
    manifest.f2_record_patient_checkin = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
    writeFileSync(flowsJsonPath, jsonText(manifest))
    const report = validateOfflineBundle({ flowsJsonPath })
    expect(report.status).toBe('mismatch')
    expect(report.findings.map(finding => finding.code)).toContain('flow_id_mismatch')
  })

  test('reports the removed legacy-drift findings no longer apply to the shipped bundle', () => {
    const report = validateOfflineBundle()
    const codes = report.findings.map(finding => finding.code)
    expect(codes).not.toContain('f2_scorer_id_absent')
    expect(codes).not.toContain('f5_component_id_absent')
    expect(codes).not.toContain('f5_edges_hash_mismatch')
    expect(codes).not.toContain('f5_folder_identity_absent')
    expect(codes.filter(code => code === 'flow_id_mismatch')).toHaveLength(0)
  })

  test('requires exactly the three reviewed F5 component pins offline', () => {
    const before = activeSnapshot()
    const root = temp()
    const configDir = join(root, 'config')
    mkdirSync(configDir)
    writeFileSync(join(configDir, 'f2-context.demo.json'), readFileSync(join(CONFIG, 'f2-context.demo.json')))
    const f5 = readJson(join(CONFIG, 'f5-runtime.demo.json'))
    const componentIds = Object.keys(f5.components)
    expect(componentIds).toHaveLength(3)

    const two = clone(f5)
    delete two.components[componentIds[0]!]
    writeFileSync(join(configDir, 'f5-runtime.demo.json'), jsonText(two))
    const twoReport = validateOfflineBundle({ bundleDir: SHIPPED, configDir, flowsJsonPath: FLOWS_JSON })
    expect(twoReport.status).toBe('mismatch')
    expect(twoReport.findings).toContainEqual(expect.objectContaining({
      code: 'f5_component_count_mismatch',
      details: expect.objectContaining({ expected: 3, actual: 2 }),
    }))

    const four = clone(f5)
    four.components['CustomComponent-extra'] = 'a'.repeat(64)
    writeFileSync(join(configDir, 'f5-runtime.demo.json'), jsonText(four))
    const fourReport = validateOfflineBundle({ bundleDir: SHIPPED, configDir, flowsJsonPath: FLOWS_JSON })
    expect(fourReport.status).toBe('mismatch')
    expect(fourReport.findings).toContainEqual(expect.objectContaining({
      code: 'f5_component_count_mismatch',
      details: expect.objectContaining({ expected: 3, actual: 4 }),
    }))

    writeFileSync(join(configDir, 'f5-runtime.demo.json'), jsonText(f5))
    const threeReport = validateOfflineBundle({ bundleDir: SHIPPED, configDir, flowsJsonPath: FLOWS_JSON })
    expect(threeReport.findings.map(finding => finding.code)).not.toContain('f5_component_count_mismatch')
    expect(activeSnapshot()).toEqual(before)
  })
})

describe('reviewed reference bundle', () => {
  test('accepts an explicitly approved, digest-bound reference and resolves roles by code/inputs', () => {
    const root = temp()
    const db = join(root, 'syncare-review.sqlite3')
    writeFileSync(db, 'synthetic sqlite placeholder')
    const reference = loadSyntheticReference(root, db)
    expect(Object.keys(reference.flows).sort()).toEqual([...FLOW_KEYS].sort())
    expect(reference.manifest.review.reviewer).toBe('Synthetic test reviewer')
    expect(reference.target.folderId).toBe(TEST_FOLDER)
    expect(Object.keys(reference.roleNodes.f2_record_patient_checkin)).toEqual(['scorer'])
    expect(Object.keys(reference.roleNodes.f5_answer_care_questions).sort()).toEqual(['guard', 'retriever', 'verifier'])
  })

  test('rejects an unapproved reference before any candidate can be generated', async () => {
    const before = activeSnapshot()
    const root = temp()
    const fixture = syntheticReference(join(root, 'fixture'), join(root, 'db.sqlite3'))
    fixture.manifest.review.approved = false
    writeFileSync(fixture.manifestPath, jsonText(fixture.manifest))
    await expect(captureError(() => loadReviewedReference(fixture.referenceDir))).resolves.toMatchObject({ code: 'reference_not_approved' })
    expect(activeSnapshot()).toEqual(before)
  })

  test('rejects reference export digest mismatch', async () => {
    const before = activeSnapshot()
    const root = temp()
    const fixture = syntheticReference(join(root, 'fixture'), join(root, 'db.sqlite3'))
    writeFileSync(join(fixture.referenceDir, SHIPPED_FILES.f2_record_patient_checkin), '{}\n')
    await expect(captureError(() => loadReviewedReference(fixture.referenceDir))).resolves.toMatchObject({ code: 'reference_digest_mismatch' })
    expect(activeSnapshot()).toEqual(before)
  })

  test('rejects malformed reference JSON and missing role identities', async () => {
    const before = activeSnapshot()
    const root = temp()
    const fixture = syntheticReference(join(root, 'fixture'), join(root, 'db.sqlite3'))
    writeFileSync(fixture.manifestPath, '{not json')
    expect((await captureError(() => loadReviewedReference(fixture.referenceDir))).code).toBe('reference_invalid_json')

    const second = syntheticReference(join(root, 'second'), join(root, 'db.sqlite3'))
    delete second.manifest.flows.f5_answer_care_questions.roles.retriever
    writeFileSync(second.manifestPath, jsonText(second.manifest))
    expect((await captureError(() => loadReviewedReference(second.referenceDir))).code).toBe('reference_role_invalid')
    expect(activeSnapshot()).toEqual(before)
  })

  test('rejects unredacted secret template values and code-embedded secrets without printing them', async () => {
    const before = activeSnapshot()
    const root = temp()
    const fixture = syntheticReference(join(root, 'fixture'), join(root, 'db.sqlite3'))
    const f2 = clone(fixture.flows.f2_record_patient_checkin) as any
    const gemini = f2.data.nodes.find((node: any) => node.data?.type === 'ext:google:GoogleGenerativeAIComponent@official')
    const syntheticTemplateSecret = "sk-" + "syntheticSecretValue1234567890"
    gemini.data.node.template.api_key.value = syntheticTemplateSecret
    const text = jsonText(f2)
    writeFileSync(join(fixture.referenceDir, SHIPPED_FILES.f2_record_patient_checkin), text)
    fixture.manifest.flows.f2_record_patient_checkin.sha256 = sha256(text)
    writeFileSync(fixture.manifestPath, jsonText(fixture.manifest))
    const error = await captureError(() => loadReviewedReference(fixture.referenceDir))
    expect(error.code).toBe('reference_secret_detected')
    expect(error.message).not.toContain(syntheticTemplateSecret)

    const second = syntheticReference(join(root, 'second'), join(root, 'db.sqlite3'))
    const f5 = clone(second.flows.f5_answer_care_questions) as any
    const verifier = f5.data.nodes.find((node: any) => node.id === nodeByCode(f5, ROLE_HASHES.verifier).id)
    const syntheticEmbeddedSecret = "AIza" + "SySyntheticSecretValue123456789012345"
    verifier.data.node.template.code.value += '\nGEMINI_API_KEY = "' + syntheticEmbeddedSecret + '"'
    const f5Text = jsonText(f5)
    writeFileSync(join(second.referenceDir, SHIPPED_FILES.f5_answer_care_questions), f5Text)
    second.manifest.flows.f5_answer_care_questions.sha256 = sha256(f5Text)
    writeFileSync(second.manifestPath, jsonText(second.manifest))
    expect((await captureError(() => loadReviewedReference(second.referenceDir))).code).toBe('reference_secret_detected')
    expect(activeSnapshot()).toEqual(before)
  })

  test('collects secret-named environment values even when SECRET is not the key suffix', () => {
    const environment = {
      AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      SYNCARE_CURSOR_SECRET: 'synthetic-cursor-secret-value',
      GEMINI_API_KEY: 'synthetic-gemini-api-key',
      AWS_REGION: 'eu-west-1',
      LOG_LEVEL: 'debug',
    }
    const secrets = privateEnvironmentKnownSecrets(environment)
    expect(secrets).toContain(environment.AWS_SECRET_ACCESS_KEY)
    expect(secrets).toContain(environment.SYNCARE_CURSOR_SECRET)
    expect(secrets).toContain(environment.GEMINI_API_KEY)
    expect(secrets).not.toContain(environment.AWS_REGION)
    expect(scanFlowForSecrets({nested: {value: environment.AWS_SECRET_ACCESS_KEY}}, secrets))
      .toContainEqual({path: 'nested.value', reason: 'known_secret'})
  })
})

describe('candidate generation and staging', () => {
  test('resolves regenerated node IDs only when reviewed code, roles, inputs and topology match', () => {
    const root = temp()
    const { bundle, reference, live } = makeCandidate(root)
    for (const flow of Object.values(live)) {
      for (const edge of flow.data!.edges ?? []) {
        const record = edge as Record<string, unknown>
        for (const [field, endpoint] of [['sourceHandle', 'source'], ['targetHandle', 'target']] as const) {
          if (typeof record[field] === 'string') {
            expect(JSON.parse((record[field] as string).replaceAll('œ', '"')).id).toBe(record[endpoint])
          }
        }
      }
    }
    expect(bundle.manifest.status).toBe('staged')
    expect(bundle.manifest.applied).toBe(false)
    expect(bundle.manifest.runtime.f2.flowId).toBe(live.f2_record_patient_checkin.id!)
    expect(bundle.manifest.runtime.f2.scorerId).not.toBe(reference.roleNodes.f2_record_patient_checkin.scorer!.nodeId)
    expect(bundle.files['config/f2-context.demo.json']).toContain(bundle.manifest.runtime.f2.scorerId)
    expect(Object.keys(bundle.manifest.runtime.f5.components)).toHaveLength(3)
    expect(new Set(Object.keys(bundle.manifest.runtime.f5.components)).size).toBe(3)
    for (const component of Object.values(bundle.manifest.runtime.f5.components)) {
      expect(component.role === 'guard' || component.role === 'retriever' || component.role === 'verifier').toBe(true)
    }
    const stagedF2 = JSON.parse(bundle.files['config/f2-context.demo.json']!)
    expect(Object.keys(stagedF2).sort()).toEqual(['flowId', 'scorerCodeSha256', 'scorerId', 'verifiedAt'])
    expect(stagedF2.verifiedAt).toBe(FIXED_ISO)
    const stagedF5 = JSON.parse(bundle.files['config/f5-runtime.demo.json']!)
    expect(Object.keys(stagedF5).sort()).toEqual(['components', 'edgesSha256', 'folderId'])
    expect(stagedF5.edgesSha256).toBe(hashFlowEdges(live.f5_answer_care_questions))
    expect(stagedF5.folderId).toBe(TEST_FOLDER)
    expect(bundle.manifest.reference.flowContentDigests.f2_record_patient_checkin).toMatch(/^[a-f0-9]{64}$/)
    const observedModel = bundle.manifest.observed.f2_record_patient_checkin.nodes
      .flatMap(node => node.values.model_name === undefined ? [] : [node.values.model_name])
    expect(observedModel).toContain('gemini-3.5-flash-lite')
    expect(bundle.manifest.observed.f5_answer_care_questions.reviewedEdges[0]!.data).toMatchObject({
      condition: 'reviewed-condition',
    })
  })

  test('rejects code drift, topology drift and required-input drift', async () => {
    const root = temp()
    const db = join(root, 'syncare-review.sqlite3')
    writeFileSync(db, 'synthetic sqlite placeholder')
    const reference = loadSyntheticReference(join(root, 'fixture'), db)

    const codeDrift = liveFlows(reference, db)
    const scorer = nodeByCode(codeDrift.f2_record_patient_checkin, ROLE_HASHES.scorer)
    scorer.data.node.template.code.value = `${scorer.data.node.template.code.value}\n# unreviewed change`
    const codeError = await captureError(() => buildCandidateBundle({ reference, liveFlows: codeDrift, now: FIXED_NOW, expectedCanonicalReviewDbPath: db }))
    expect(['code_drift', 'topology_drift']).toContain(codeError.code)

    const topologyDrift = liveFlows(reference, db)
    const edge = topologyDrift.f5_answer_care_questions.data!.edges![0] as any
    edge.target = topologyDrift.f5_answer_care_questions.data!.nodes!.find((node: any) => node.id !== edge.target)!.id
    const topologyError = await captureError(() => buildCandidateBundle({ reference, liveFlows: topologyDrift, now: FIXED_NOW, expectedCanonicalReviewDbPath: db }))
    expect(topologyError.code).toBe('topology_drift')

    const inputDrift = liveFlows(reference, db)
    const scorer2 = nodeByCode(inputDrift.f2_record_patient_checkin, ROLE_HASHES.scorer) as any
    delete scorer2.data.node.template.baseline_score
    const inputError = await captureError(() => buildCandidateBundle({ reference, liveFlows: inputDrift, now: FIXED_NOW, expectedCanonicalReviewDbPath: db }))
    expect(inputError.code).toBe('input_drift')
  })

  test('rejects unreviewed template values and edge data even when the graph topology is unchanged', async () => {
    const root = temp()
    const db = join(root, 'syncare-review.sqlite3')
    writeFileSync(db, 'synthetic sqlite placeholder')
    const reference = loadSyntheticReference(join(root, 'fixture'), db)
    const before = activeSnapshot()

    const modelDrift = liveFlows(reference, db)
    const gemini = modelDrift.f2_record_patient_checkin.data!.nodes!.find((node: any) =>
      nodeTemplate(node).model_name !== undefined)
    expect(gemini).toBeDefined()
    nodeTemplate(gemini).model_name.value = 'gemini-0.1-unreviewed'
    expect((await captureError(() => buildCandidateBundle({ reference, liveFlows: modelDrift, now: FIXED_NOW, expectedCanonicalReviewDbPath: db }))).code)
      .toBe('reviewed_content_mismatch')

    const providerDrift = liveFlows(reference, db)
    const retriever = providerDrift.f5_answer_care_questions.data!.nodes!.find((node: any) =>
      nodeTemplate(node).vector_backend !== undefined)
    expect(retriever).toBeDefined()
    nodeTemplate(retriever).vector_backend.value = 'unreviewed-backend'
    expect((await captureError(() => buildCandidateBundle({ reference, liveFlows: providerDrift, now: FIXED_NOW, expectedCanonicalReviewDbPath: db }))).code)
      .toBe('reviewed_content_mismatch')

    const edgeDrift = liveFlows(reference, db)
    const edge = edgeDrift.f5_answer_care_questions.data!.edges![0] as any
    expect(edge.data.condition).toBe('reviewed-condition')
    edge.data.condition = 'unreviewed-condition'
    expect((await captureError(() => buildCandidateBundle({ reference, liveFlows: edgeDrift, now: FIXED_NOW, expectedCanonicalReviewDbPath: db }))).code)
      .toBe('reviewed_content_mismatch')

    const badId = liveFlows(reference, db)
    badId.f1_register_discharge_summary.id = 'not-a-uuid'
    expect((await captureError(() => buildCandidateBundle({ reference, liveFlows: badId, now: FIXED_NOW, expectedCanonicalReviewDbPath: db }))).code)
      .toBe('flow_id_invalid')

    expect(activeSnapshot()).toEqual(before)
  })

  test('binds reviewed values per node so duplicate-structure F4 gates cannot be swapped or rotated', async () => {
    const root = temp()
    const db = join(root, 'syncare-review.sqlite3')
    writeFileSync(db, 'synthetic sqlite placeholder')
    const reference = loadSyntheticReference(join(root, 'fixture'), db)
    const before = activeSnapshot()

    const reviewedGates = gateNodes(reference.flows.f4_review_care_plan)
    expect(reviewedGates).toHaveLength(4)
    expect(new Set(reviewedGates.map(node => nodeCodeHash(node))).size).toBe(1)
    expect(reviewedGateActions(reference.flows.f4_review_care_plan)).toEqual(['approve', 'escalate', 'escalate', 'request_changes'])

    // Positive: regenerated node IDs and rewritten gate_id references keep F4 content identical.
    const pristine = liveFlows(reference, db)
    expect(gateNodes(pristine.f4_review_care_plan)).toHaveLength(4)
    expect(reviewedFlowContentDigest(reviewedFlowContent(pristine.f4_review_care_plan, reviewedContext(pristine, 'f4_review_care_plan'))))
      .toBe(reviewedFlowContentDigest(reviewedFlowContent(reference.flows.f4_review_care_plan, reviewedContext(reference.flows, 'f4_review_care_plan'))))
    expect(buildCandidateBundle({ reference, liveFlows: pristine, now: FIXED_NOW, expectedCanonicalReviewDbPath: db }).manifest.status)
      .toBe('staged')

    // Pair swap: approve gate <-> escalate gate.
    const swapped = liveFlows(reference, db)
    const swappedGates = gateNodes(swapped.f4_review_care_plan)
    const approve = swappedGates.find(node => nodeTemplate(node).action.value === 'approve')!
    const escalate = swappedGates.find(node => nodeTemplate(node).action.value === 'escalate')!
    expect(approve).toBeDefined()
    expect(escalate).toBeDefined()
    expect(approve.id).not.toBe(escalate.id)
    nodeTemplate(approve).action.value = 'escalate'
    nodeTemplate(escalate).action.value = 'approve'
    expect((await captureError(() => buildCandidateBundle({ reference, liveFlows: swapped, now: FIXED_NOW, expectedCanonicalReviewDbPath: db }))).code)
      .toBe('reviewed_content_mismatch')

    // Three-way rotation: approve -> escalate -> request_changes -> approve.
    const rotated = liveFlows(reference, db)
    const rotatedGates = gateNodes(rotated.f4_review_care_plan)
    const rotateApprove = rotatedGates.find(node => nodeTemplate(node).action.value === 'approve')!
    const rotateEscalate = rotatedGates.find(node => nodeTemplate(node).action.value === 'escalate')!
    const rotateRequest = rotatedGates.find(node => nodeTemplate(node).action.value === 'request_changes')!
    expect(rotateRequest).toBeDefined()
    nodeTemplate(rotateApprove).action.value = 'escalate'
    nodeTemplate(rotateEscalate).action.value = 'request_changes'
    nodeTemplate(rotateRequest).action.value = 'approve'
    expect((await captureError(() => buildCandidateBundle({ reference, liveFlows: rotated, now: FIXED_NOW, expectedCanonicalReviewDbPath: db }))).code)
      .toBe('reviewed_content_mismatch')

    expect(activeSnapshot()).toEqual(before)
  })

  test('rejects foreign folder, project mismatch and canonical path drift', async () => {
    const before = activeSnapshot()
    const root = temp()
    const db = join(root, 'syncare-review.sqlite3')
    writeFileSync(db, 'synthetic sqlite placeholder')
    const reference = loadSyntheticReference(join(root, 'fixture'), db)

    const foreign = liveFlows(reference, db)
    foreign.f5_answer_care_questions.folder_id = '33333333-3333-4333-8333-333333333333'
    expect((await captureError(() => buildCandidateBundle({ reference, liveFlows: foreign, now: FIXED_NOW, expectedCanonicalReviewDbPath: db }))).code).toBe('foreign_folder')

    const project = liveFlows(reference, db)
    project.f2_record_patient_checkin.project_id = '44444444-4444-4444-8444-444444444444'
    expect((await captureError(() => buildCandidateBundle({ reference, liveFlows: project, now: FIXED_NOW, expectedCanonicalReviewDbPath: db }))).code).toBe('project_mismatch')

    const path = liveFlows(reference, join(root, 'different.sqlite3'))
    expect((await captureError(() => buildCandidateBundle({ reference, liveFlows: path, now: FIXED_NOW, expectedCanonicalReviewDbPath: db }))).code).toBe('canonical_path_mismatch')
    expect(activeSnapshot()).toEqual(before)
  })

  test('duplicate and case-ambiguous engine flow names are rejected rather than first-picked', async () => {
    const root = temp()
    const db = join(root, 'syncare-review.sqlite3')
    writeFileSync(db, 'synthetic sqlite placeholder')
    const reference = loadSyntheticReference(join(root, 'fixture'), db)
    const live = liveFlows(reference, db)
    const summaries = FLOW_KEYS.map(key => ({
      id: live[key].id!,
      name: live[key].name!,
      folder_id: live[key].folder_id!,
      project_id: live[key].project_id!,
    }))
    expect(selectEngineFlows(summaries, reference).f5_answer_care_questions.id).toBe(live.f5_answer_care_questions.id!)
    const duplicate = [...summaries, { ...summaries[1]!, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }]
    expect((await captureError(() => selectEngineFlows(duplicate, reference))).code).toBe('duplicate_flow_name')
    const caseVariant = summaries.map((summary, index) => index === 1 ? { ...summary, name: 'Record_Patient_Checkin' } : summary)
    expect((await captureError(() => selectEngineFlows(caseVariant, reference))).code).toBe('flow_name_mismatch')
  })

  test('stages the three outputs and digest manifest atomically; refusals leave no partial candidate', () => {
    const root = temp()
    const { outputDir, staged, db } = makeCandidate(root)
    for (const relative of ['flows.json', 'config/f2-context.demo.json', 'config/f5-runtime.demo.json', 'runtime-bindings-manifest.json']) {
      expect(existsSync(join(outputDir, relative))).toBe(true)
    }
    const manifest = readJson(join(outputDir, 'runtime-bindings-manifest.json'))
    expect(staged.manifestSha256).toBe(sha256(readFileSync(join(outputDir, 'runtime-bindings-manifest.json'), 'utf8')))
    for (const [relative, record] of Object.entries(manifest.stagedFiles) as Array<[string, any]>) {
      expect(record.sha256).toBe(sha256(readFileSync(join(outputDir, relative), 'utf8')))
    }
    expect(manifest.target.canonicalReviewDbPath).toBe(db)

    const occupied = join(root, 'occupied')
    mkdirSync(occupied)
    writeFileSync(join(occupied, 'keep.txt'), 'keep')
    const reference = loadSyntheticReference(join(root, 'second-fixture'), db)
    const bundle = buildCandidateBundle({ reference, liveFlows: liveFlows(reference, db), now: FIXED_NOW, expectedCanonicalReviewDbPath: db })
    expect(() => stageCandidateBundle({ outputDir: occupied, bundle })).toThrow(RuntimeBindingError)
    expect(readFileSync(join(occupied, 'keep.txt'), 'utf8')).toBe('keep')
    expect(existsSync(join(occupied, 'flows.json'))).toBe(false)
  })

  test('inspect uses only GET against the synthetic engine and writes no active configuration', async () => {
    const root = temp()
    const db = join(root, 'syncare-review.sqlite3')
    writeFileSync(db, 'synthetic sqlite placeholder')
    const reference = loadSyntheticReference(join(root, 'fixture'), db)
    const live = liveFlows(reference, db)
    const server = serveFlows(live)
    const before = activeSnapshot()
    try {
      const result = await inspectRuntimeBindings({
        reference: join(root, 'fixture', 'reference'),
        outputDir: join(root, 'inspected'),
        baseUrl: server.baseUrl,
        apiKey: 'synthetic-engine-key',
        expectedCanonicalReviewDbPath: db,
        now: FIXED_NOW,
      })
      expect(result.status).toBe('staged')
      expect(server.requests.length).toBeGreaterThan(0)
      expect(server.requests.every(request => request.method === 'GET')).toBe(true)
      expect(server.requests.every(request => request.apiKey === 'synthetic-engine-key')).toBe(true)
      expect(existsSync(join(root, 'inspected', 'config/f5-runtime.demo.json'))).toBe(true)
      expect(activeSnapshot()).toEqual(before)
    } finally {
      server.stop()
    }
  })

  test('blocked inspection leaves no candidate and never invents a pin', async () => {
    const root = temp()
    const db = join(root, 'syncare-review.sqlite3')
    writeFileSync(db, 'synthetic sqlite placeholder')
    const reference = loadSyntheticReference(join(root, 'fixture'), db)
    const live = liveFlows(reference, db)
    const duplicate = { ...live, f5_answer_care_questions: clone(live.f5_answer_care_questions) }
    duplicate.f5_answer_care_questions.id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const server = serveFlows({ ...live, duplicateF5: duplicate.f5_answer_care_questions } as Record<string, any>)
    const output = join(root, 'blocked')
    try {
      const duplicateError = await captureError(() => inspectRuntimeBindings({
        reference: join(root, 'fixture', 'reference'), outputDir: output, baseUrl: server.baseUrl,
        apiKey: 'synthetic-engine-key', expectedCanonicalReviewDbPath: db, now: FIXED_NOW,
      }))
      expect(duplicateError.code).toBe('duplicate_flow_name')
      expect(existsSync(output)).toBe(false)
    } finally {
      server.stop()
    }

    const fetcher = (async () => { throw new Error('synthetic unreachable engine') }) as unknown as typeof fetch
    const unreachable = await captureError(() => inspectRuntimeBindings({
      reference: join(root, 'fixture', 'reference'), outputDir: output, baseUrl: 'http://127.0.0.1:9',
      apiKey: 'synthetic-engine-key', fetchImpl: fetcher, expectedCanonicalReviewDbPath: db, now: FIXED_NOW,
    }))
    expect(unreachable.code).toBe('engine_unreachable')
    expect(existsSync(output)).toBe(false)
  })
})

describe('candidate verification', () => {
  test('verifies a staged candidate and all three outputs', () => {
    const root = temp()
    const { outputDir, db, reference } = makeCandidate(root)
    const result = verifyCandidate({ candidateDir: outputDir, reference: reference.directory, expectedCanonicalReviewDbPath: db })
    expect(result.status).toBe('verified')
    expect(result.flows).toBe(5)
    expect(result.components).toBe(3)
  })

  test('requires an explicit approved reference instead of trusting candidate self-evidence', () => {
    const root = temp()
    const { outputDir, db } = makeCandidate(root)
    expect((() => {
      try {
        verifyCandidate({ candidateDir: outputDir, expectedCanonicalReviewDbPath: db } as any)
        return null
      } catch (error) {
        return (error as RuntimeBindingError).code
      }
    })()).toBe('reference_required')
  })

  test('rejects candidate reference evidence that does not match the approved reference', () => {
    const root = temp()
    const { outputDir, db, reference } = makeCandidate(root)
    const manifestPath = join(outputDir, 'runtime-bindings-manifest.json')
    const original = readJson(manifestPath)

    const attempts: Array<{ mutate: (manifest: any) => void; code: string }> = [
      { mutate: manifest => { manifest.reference.manifestSha256 = 'f'.repeat(64) }, code: 'reference_manifest_mismatch' },
      { mutate: manifest => { manifest.reference.flowDigests.f1_register_discharge_summary = 'a'.repeat(64) }, code: 'reference_flow_digest_mismatch' },
      { mutate: manifest => { manifest.reference.roles.f2_record_patient_checkin.scorer.requiredInputs = ['patient_id'] }, code: 'reference_roles_mismatch' },
      { mutate: manifest => { delete manifest.target.projectId }, code: 'project_identity_missing' },
    ]
    for (const attempt of attempts) {
      const manifest = clone(original)
      attempt.mutate(manifest)
      writeFileSync(manifestPath, jsonText(manifest))
      expect((() => {
        try {
          verifyCandidate({ candidateDir: outputDir, reference: reference.directory, expectedCanonicalReviewDbPath: db })
          return null
        } catch (error) {
          return (error as RuntimeBindingError).code
        }
      })()).toBe(attempt.code)
    }
    writeFileSync(manifestPath, jsonText(original))
  })

  test('rejects a consistently retargeted foreign candidate', () => {
    const root = temp()
    const { outputDir, db, reference } = makeCandidate(root)
    const foreignFolder = '99999999-9999-4999-8999-999999999999'
    const f5Path = join(outputDir, 'config/f5-runtime.demo.json')
    const f5 = readJson(f5Path)
    f5.folderId = foreignFolder
    const f5Text = jsonText(f5)
    writeFileSync(f5Path, f5Text)
    const manifestPath = join(outputDir, 'runtime-bindings-manifest.json')
    const manifest = readJson(manifestPath)
    manifest.target.folderId = foreignFolder
    manifest.runtime.f5.folderId = foreignFolder
    for (const flow of Object.values(manifest.observed) as any[]) flow.folderId = foreignFolder
    manifest.stagedFiles['config/f5-runtime.demo.json'] = { sha256: sha256(f5Text), bytes: Buffer.byteLength(f5Text) }
    writeFileSync(manifestPath, jsonText(manifest))
    expect((() => {
      try {
        verifyCandidate({ candidateDir: outputDir, reference: reference.directory, expectedCanonicalReviewDbPath: db })
        return null
      } catch (error) {
        return (error as RuntimeBindingError).code
      }
    })()).toBe('foreign_folder')
  })

  test('rejects a fabricated candidate that recomputes its own reviewed-content digest', () => {
    const root = temp()
    const { outputDir, db, reference } = makeCandidate(root)
    const manifestPath = join(outputDir, 'runtime-bindings-manifest.json')
    const original = readJson(manifestPath)
    const manifest = clone(original)
    const f2 = manifest.observed.f2_record_patient_checkin
    const gemini = f2.nodes.find((node: any) => node.values.model_name !== undefined)
    expect(gemini).toBeDefined()
    gemini.values.model_name = 'gemini-0.1-unreviewed'

    writeFileSync(manifestPath, jsonText(manifest))
    expect((() => {
      try {
        verifyCandidate({ candidateDir: outputDir, reference: reference.directory, expectedCanonicalReviewDbPath: db })
        return null
      } catch (error) {
        return (error as RuntimeBindingError).code
      }
    })()).toBe('reviewed_content_mismatch')

    manifest.reference.flowContentDigests.f2_record_patient_checkin = reviewedFlowContentDigest({
      name: f2.name,
      nodes: f2.nodes.map((node: any) => ({type: node.type, codeSha256: node.codeSha256, values: node.values})),
      edges: f2.reviewedEdges,
    })
    writeFileSync(manifestPath, jsonText(manifest))
    expect((() => {
      try {
        verifyCandidate({ candidateDir: outputDir, reference: reference.directory, expectedCanonicalReviewDbPath: db })
        return null
      } catch (error) {
        return (error as RuntimeBindingError).code
      }
    })()).toBe('reference_content_digest_mismatch')
    writeFileSync(manifestPath, jsonText(original))
  })

  test('refuses observed F4 gate-action permutations in a staged candidate', () => {
    const root = temp()
    const { outputDir, db, reference } = makeCandidate(root)
    const verify = () => thrownCode(() => verifyCandidate({ candidateDir: outputDir, reference: reference.directory, expectedCanonicalReviewDbPath: db }))
    const manifestPath = join(outputDir, 'runtime-bindings-manifest.json')
    const original = readJson(manifestPath)
    expect(verify()).toBeNull()

    const attempts: Array<(nodes: any[]) => void> = [
      nodes => {
        const approve = nodes.find((node: any) => node.values.action === 'approve')!
        const escalate = nodes.find((node: any) => node.values.action === 'escalate')!
        expect(approve).toBeDefined()
        expect(escalate).toBeDefined()
        const value = approve.values.action
        approve.values.action = escalate.values.action
        escalate.values.action = value
      },
      nodes => {
        const approve = nodes.find((node: any) => node.values.action === 'approve')!
        const escalate = nodes.find((node: any) => node.values.action === 'escalate')!
        const request = nodes.find((node: any) => node.values.action === 'request_changes')!
        expect(request).toBeDefined()
        approve.values.action = 'escalate'
        escalate.values.action = 'request_changes'
        request.values.action = 'approve'
      },
    ]
    for (const mutate of attempts) {
      const manifest = clone(original)
      mutate(manifest.observed.f4_review_care_plan.nodes.filter((node: any) => node.values.action !== undefined))
      writeFileSync(manifestPath, jsonText(manifest))
      expect(verify()).toBe('reviewed_content_mismatch')
    }
    writeFileSync(manifestPath, jsonText(original))
    expect(verify()).toBeNull()
  })

  test('reference and content refusals leave active configuration unchanged', () => {
    const root = temp()
    const { outputDir, db, reference } = makeCandidate(root)
    const before = activeSnapshot()
    const manifestPath = join(outputDir, 'runtime-bindings-manifest.json')
    const original = readJson(manifestPath)
    const mutations: Array<(manifest: any) => void> = [
      manifest => { manifest.reference.manifestSha256 = 'f'.repeat(64) },
      manifest => { manifest.target.folderId = '99999999-9999-4999-8999-999999999999' },
      manifest => {
        const node = manifest.observed.f2_record_patient_checkin.nodes.find((item: any) => item.values.model_name !== undefined)
        node.values.model_name = 'gemini-0.1-unreviewed'
      },
    ]
    for (const mutate of mutations) {
      const manifest = clone(original)
      mutate(manifest)
      writeFileSync(manifestPath, jsonText(manifest))
      expect(() => verifyCandidate({ candidateDir: outputDir, reference: reference.directory, expectedCanonicalReviewDbPath: db })).toThrow(RuntimeBindingError)
    }
    expect(activeSnapshot()).toEqual(before)
    writeFileSync(manifestPath, jsonText(original))
  })

  test('fails closed on corrupt manifest, digest drift, missing component, foreign folder, path mismatch and graph drift', () => {
    const before = activeSnapshot()
    const root = temp()
    const { outputDir, db, reference } = makeCandidate(root)

    const corrupt = join(root, 'corrupt')
    rmSync(corrupt, { recursive: true, force: true })
    mkdirSync(corrupt)
    writeFileSync(join(corrupt, 'runtime-bindings-manifest.json'), '{bad')
    expect(() => verifyCandidate({ candidateDir: corrupt, reference: reference.directory, expectedCanonicalReviewDbPath: db })).toThrow(RuntimeBindingError)

    const digestDir = join(root, 'digest')
    rmSync(digestDir, { recursive: true, force: true })
    mkdirSync(digestDir)
    mkdirSync(join(digestDir, 'config'), { recursive: true })
    for (const relative of ['flows.json', 'config/f2-context.demo.json', 'config/f5-runtime.demo.json', 'runtime-bindings-manifest.json']) {
      writeFileSync(join(digestDir, relative), readFileSync(join(outputDir, relative)))
    }
    writeFileSync(join(digestDir, 'flows.json'), readFileSync(join(digestDir, 'flows.json'), 'utf8').replace('"f1_register_discharge_summary"', '"f1_register_discharge_summary_extra"'))
    expect(() => verifyCandidate({ candidateDir: digestDir, reference: reference.directory, expectedCanonicalReviewDbPath: db })).toThrow(RuntimeBindingError)

    const missing = makeCandidate(join(root, 'missing'))
    const missingF5Path = join(missing.outputDir, 'config/f5-runtime.demo.json')
    const missingF5 = readJson(missingF5Path)
    delete missingF5.components[Object.keys(missingF5.components)[0]!]
    const missingText = jsonText(missingF5)
    writeFileSync(missingF5Path, missingText)
    const missingManifestPath = join(missing.outputDir, 'runtime-bindings-manifest.json')
    const missingManifest = readJson(missingManifestPath)
    missingManifest.stagedFiles['config/f5-runtime.demo.json'] = { sha256: sha256(missingText), bytes: Buffer.byteLength(missingText) }
    writeFileSync(missingManifestPath, jsonText(missingManifest))
    expect((() => { try { verifyCandidate({ candidateDir: missing.outputDir, reference: missing.reference.directory, expectedCanonicalReviewDbPath: missing.db }); return null } catch (error) { return (error as RuntimeBindingError).code } })()).toBe('component_missing')

    const folderRoot = join(root, 'folder')
    const folder = makeCandidate(folderRoot)
    const folderF5Path = join(folder.outputDir, 'config/f5-runtime.demo.json')
    const folderF5 = readJson(folderF5Path)
    folderF5.folderId = '99999999-9999-4999-8999-999999999999'
    const folderText = jsonText(folderF5)
    writeFileSync(folderF5Path, folderText)
    const folderManifest = readJson(join(folder.outputDir, 'runtime-bindings-manifest.json'))
    folderManifest.stagedFiles['config/f5-runtime.demo.json'] = { sha256: sha256(folderText), bytes: Buffer.byteLength(folderText) }
    writeFileSync(join(folder.outputDir, 'runtime-bindings-manifest.json'), jsonText(folderManifest))
    expect((() => { try { verifyCandidate({ candidateDir: folder.outputDir, reference: folder.reference.directory, expectedCanonicalReviewDbPath: folder.db }); return null } catch (error) { return (error as RuntimeBindingError).code } })()).toBe('foreign_folder')

    const pathRoot = join(root, 'path')
    const pathCandidate = makeCandidate(pathRoot)
    expect((() => { try { verifyCandidate({ candidateDir: pathCandidate.outputDir, reference: pathCandidate.reference.directory, expectedCanonicalReviewDbPath: join(root, 'other.sqlite3') }); return null } catch (error) { return (error as RuntimeBindingError).code } })()).toBe('canonical_path_mismatch')

    const graphRoot = join(root, 'graph')
    const graphCandidate = makeCandidate(graphRoot)
    const graphManifestPath = join(graphCandidate.outputDir, 'runtime-bindings-manifest.json')
    const graphManifest = readJson(graphManifestPath)
    const edge = graphManifest.observed.f5_answer_care_questions.edges[0]
    edge.target = graphManifest.observed.f5_answer_care_questions.nodes.find((node: any) => node.id !== edge.target).id
    writeFileSync(graphManifestPath, jsonText(graphManifest))
    expect((() => { try { verifyCandidate({ candidateDir: graphCandidate.outputDir, reference: graphCandidate.reference.directory, expectedCanonicalReviewDbPath: graphCandidate.db }); return null } catch (error) { return (error as RuntimeBindingError).code } })()).toBe('graph_drift')
    expect(activeSnapshot()).toEqual(before)
  })

  test('verification never mutates active configuration', () => {
    const root = temp()
    const { outputDir, db, reference } = makeCandidate(root)
    const before = activeSnapshot()
    verifyCandidate({ candidateDir: outputDir, reference: reference.directory, expectedCanonicalReviewDbPath: db })
    expect(activeSnapshot()).toEqual(before)
  })
})

describe('candidate output containment', () => {
  test('resolves physical ancestors and rejects repo-internal or symlinked outputs', () => {
    const root = temp()
    const repo = join(root, 'repo')
    mkdirSync(join(repo, 'config'), { recursive: true })
    mkdirSync(join(repo, 'flows'), { recursive: true })
    const outside = join(root, 'outside')
    mkdirSync(outside)
    const roots = { repoRoot: repo, activeConfigDir: join(repo, 'config') }

    expect(assertCandidateLocation(join(outside, 'candidate'), roots)).toBe(join(outside, 'candidate'))
    expect(assertCandidateLocation(join(outside, 'missing', 'candidate'), roots)).toBe(join(outside, 'missing', 'candidate'))

    for (const path of [repo, root, join(repo, 'candidate'), join(repo, 'flows', 'candidate')]) {
      expect(thrownCode(() => assertCandidateLocation(path, roots))).toBe('output_active_path')
    }

    const configLink = join(root, 'config-link')
    symlinkSync(join(repo, 'config'), configLink, 'dir')
    expect(thrownCode(() => assertCandidateLocation(join(configLink, 'candidate'), roots))).toBe('output_active_path')

    const candidateLink = join(outside, 'candidate-link')
    symlinkSync(outside, candidateLink, 'dir')
    expect(thrownCode(() => assertCandidateLocation(candidateLink, roots))).toBe('output_invalid')

    const danglingLink = join(outside, 'dangling-link')
    symlinkSync(join(root, 'missing-target'), danglingLink, 'dir')
    expect(thrownCode(() => assertCandidateLocation(danglingLink, roots))).toBe('output_invalid')
  })
})

describe('CLI contract', () => {
  test('requires a reference, forbids credential arguments and leaves no output on refusal', async () => {
    const before = activeSnapshot()
    const root = temp()
    const output = join(root, 'cli-out')
    const missingReference = await runRuntimeBindingsCli(['inspect', '--output', output], { env: {}, cwd: root })
    expect(missingReference.exitCode).not.toBe(0)
    expect(JSON.parse(missingReference.stdout).status).toBe('blocked')
    expect(existsSync(output)).toBe(false)

    const forbidden = await runRuntimeBindingsCli(['inspect', '--output', output, '--reference', join(root, 'ref'), '--api-key', 'synthetic-secret-value'], { env: {}, cwd: root })
    expect(forbidden.exitCode).not.toBe(0)
    expect(forbidden.stdout).not.toContain('synthetic-secret-value')
    expect(existsSync(output)).toBe(false)
    expect(activeSnapshot()).toEqual(before)
  })

  test('rejects flags that do not apply to the selected command instead of ignoring them', async () => {
    const before = activeSnapshot()
    const root = temp()
    const output = join(root, 'cli-flags')
    const reference = join(root, 'reference')
    const inspect = await runRuntimeBindingsCli(
      ['inspect', '--output', output, '--reference', reference, '--candidate', output],
      { env: {}, cwd: root },
    )
    expect(inspect.exitCode).toBe(2)
    expect(JSON.parse(inspect.stdout)).toMatchObject({ status: 'usage', code: 'flag_not_applicable' })
    expect(existsSync(output)).toBe(false)

    const verify = await runRuntimeBindingsCli(
      ['verify', '--candidate', output, '--reference', reference, '--output', output],
      { env: {}, cwd: root },
    )
    expect(verify.exitCode).toBe(2)
    expect(JSON.parse(verify.stdout)).toMatchObject({ status: 'usage', code: 'flag_not_applicable' })
    expect(activeSnapshot()).toEqual(before)
  })

  test('verify refuses to run without an approved reference', async () => {
    const before = activeSnapshot()
    const root = temp()
    const { outputDir, db } = makeCandidate(root)
    const verified = await runRuntimeBindingsCli(['verify', '--candidate', outputDir], {
      env: { SYNCARE_REVIEW_DB: db },
    })
    expect(verified.exitCode).toBe(1)
    expect(JSON.parse(verified.stdout)).toMatchObject({ status: 'blocked', code: 'reference_required' })
    expect(activeSnapshot()).toEqual(before)
  })

  test('inspect rejects private-environment secrets beyond the two original keys', async () => {
    const before = activeSnapshot()
    const root = temp()
    const db = join(root, 'syncare-review.sqlite3')
    writeFileSync(db, 'synthetic sqlite placeholder')
    const reference = loadSyntheticReference(join(root, 'fixture'), db)
    const live = liveFlows(reference, db)
    const secret = 'cursor-secret-value-123'
    const node = live.f2_record_patient_checkin.data!.nodes!.find((candidate: any) =>
      nodeTemplate(candidate).system_message !== undefined)
    expect(node).toBeDefined()
    nodeTemplate(node).system_message.value = `prefix ${secret} suffix`
    const server = serveFlows(live)
    const output = join(root, 'secret-candidate')
    try {
      const outcome = await runRuntimeBindingsCli(
        ['inspect', '--output', output, '--reference', join(root, 'fixture', 'reference')],
        {
          env: {
            LANGFLOW_BASE_URL: server.baseUrl,
            LANGFLOW_API_KEY: 'synthetic-engine-key',
            SYNCARE_REVIEW_DB: db,
            SYNCARE_CURSOR_SECRET: secret,
          },
          now: FIXED_NOW,
        },
      )
      expect(outcome.exitCode).toBe(1)
      expect(JSON.parse(outcome.stdout)).toMatchObject({ status: 'blocked', code: 'secret_in_flow' })
      expect(outcome.stdout).not.toContain(secret)
      expect(existsSync(output)).toBe(false)
      expect(activeSnapshot()).toEqual(before)
    } finally {
      server.stop()
    }
  })

  test('inspect stages through the CLI with private environment and verify accepts the result', async () => {
    const root = temp()
    const db = join(root, 'syncare-review.sqlite3')
    writeFileSync(db, 'synthetic sqlite placeholder')
    const reference = loadSyntheticReference(join(root, 'fixture'), db)
    const live = liveFlows(reference, db)
    const server = serveFlows(live)
    const output = join(root, 'cli-candidate')
    try {
      const inspected = await runRuntimeBindingsCli(
        ['inspect', '--output', output, '--reference', join(root, 'fixture', 'reference')],
        {
          env: {
            LANGFLOW_BASE_URL: server.baseUrl,
            LANGFLOW_API_KEY: 'synthetic-engine-key',
            SYNCARE_REVIEW_DB: db,
          },
          now: FIXED_NOW,
        },
      )
      expect(inspected.exitCode).toBe(0)
      expect(JSON.parse(inspected.stdout).status).toBe('staged')
      const verified = await runRuntimeBindingsCli(['verify', '--candidate', output, '--reference', join(root, 'fixture', 'reference')], {
        env: { SYNCARE_REVIEW_DB: db },
      })
      expect(verified.exitCode).toBe(0)
      expect(JSON.parse(verified.stdout).status).toBe('verified')
    } finally {
      server.stop()
    }
  })
})
