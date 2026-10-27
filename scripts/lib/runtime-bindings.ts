/**
 * Offline/staged runtime-binding inspection for the SynCare flow bundle.
 *
 * The runtime guards in src/modules/workflows/flow-gateway.ts and
 * src/modules/questions/gateway.ts hash exact source strings and the exact
 * JSON.stringify(edges) graph. This module deliberately uses those same
 * primitives; it does not invent a second graph serialization.
 *
 * Trust model: a candidate is never generated from the live engine alone.
 * inspect() requires an externally reviewed reference bundle whose manifest
 * carries an explicit approval and code/template role identities. Regenerated
 * node IDs are accepted only when the reviewed role code, inputs and graph
 * topology are structurally preserved. The output is staged, never applied.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FLOW_KEYS = [
  'f1_register_discharge_summary',
  'f2_record_patient_checkin',
  'f3_draft_followup_plan',
  'f4_review_care_plan',
  'f5_answer_care_questions',
] as const

export type FlowKey = (typeof FLOW_KEYS)[number]

export const FLOW_NAMES: Record<FlowKey, string> = {
  f1_register_discharge_summary: 'register_discharge_summary',
  f2_record_patient_checkin: 'record_patient_checkin',
  f3_draft_followup_plan: 'draft_followup_plan',
  f4_review_care_plan: 'review_care_plan',
  f5_answer_care_questions: 'answer_care_questions',
}

export const FLOW_FILES: Record<FlowKey, string> = {
  f1_register_discharge_summary: 'register_discharge_summary.json',
  f2_record_patient_checkin: 'record_patient_checkin.json',
  f3_draft_followup_plan: 'draft_followup_plan.json',
  f4_review_care_plan: 'review_care_plan.json',
  f5_answer_care_questions: 'answer_care_questions.json',
}

export const F2_ROLE = 'scorer' as const
export const F5_ROLES = ['guard', 'retriever', 'verifier'] as const
export type F5Role = (typeof F5_ROLES)[number]

export const REFERENCE_MANIFEST_FILE = 'runtime-binding-reference.json'
export const CANDIDATE_MANIFEST_FILE = 'runtime-bindings-manifest.json'
export const CANDIDATE_FILE_KEYS = [
  'flows.json',
  'config/f2-context.demo.json',
  'config/f5-runtime.demo.json',
] as const

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ACTIVE_CONFIG_DIR = join(REPO_ROOT, 'config')
const DEFAULT_REVIEW_DB_PATH = join(REPO_ROOT, 'data', 'langflow', 'langflow', 'syncare-review.sqlite3')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256_RE = /^[a-f0-9]{64}$/
const SECRET_FIELD_RE = /(api[_-]?key|token|password|secret|credential|authorization)/i
const SECRET_VALUE_ALLOWLIST = /^(|\[REDACTED\]|\*\*\*REDACTED\*\*\*|REDACTED|<redacted>|\$\{[A-Z0-9_]+\}|[A-Z][A-Z0-9_]*)$/
const CODE_SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /AIza[0-9A-Za-z_-]{35}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /Bearer\s+[A-Za-z0-9._~+/-]{20,}/,
]
export const PRIVATE_SECRET_ENV_KEYS = [
  'LANGFLOW_API_KEY',
  'GEMINI_API_KEY',
  'LANGFLOW_SECRET_KEY',
  'SYNCARE_API_KEY',
  'SYNCARE_CURSOR_SECRET',
  'LANGFLOW_SUPERUSER_PASSWORD',
] as const
// Secret-named keys: SECRET anywhere (AWS_SECRET_ACCESS_KEY, CLIENT_SECRET) plus
// credential suffixes such as API_KEY, TOKEN, PASSWORD and CREDENTIAL.
const SECRET_ENV_KEY_RE = /SECRET|(?:^|_)(?:API_?KEY|TOKEN|PASSWORD|CREDENTIAL)$/i

type JsonRecord = Record<string, unknown>

export interface RuntimeBindingErrorDetails {
  [key: string]: unknown
}

export class RuntimeBindingError extends Error {
  readonly code: string
  readonly details: RuntimeBindingErrorDetails

  constructor(code: string, message: string, details: RuntimeBindingErrorDetails = {}) {
    super(message)
    this.name = 'RuntimeBindingError'
    this.code = code
    this.details = details
  }
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function defaultReviewDbPath(environment: Record<string, string | undefined> = process.env): string {
  const configured = environment.SYNCARE_REVIEW_DB
  return resolve(configured && configured.trim() !== '' ? configured : DEFAULT_REVIEW_DB_PATH)
}

export function privateEnvironmentKnownSecrets(environment: Record<string, string | undefined> = process.env): string[] {
  const values = new Set<string>()
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value !== 'string' || value.length < 8) continue
    if (!(PRIVATE_SECRET_ENV_KEYS as readonly string[]).includes(key) && !SECRET_ENV_KEY_RE.test(key)) continue
    values.add(value)
  }
  return [...values]
}

export function physicalPath(value: string): string {
  let resolved: string
  try {
    resolved = realpathSync.native(resolve(value))
  } catch {
    resolved = resolve(value)
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function fail(code: string, message: string, details: RuntimeBindingErrorDetails = {}): never {
  throw new RuntimeBindingError(code, message, details)
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

function record(value: unknown, code: string, message: string): JsonRecord {
  if (!isRecord(value)) return fail(code, message)
  return value as JsonRecord
}

function parseJson(raw: string, code: string, message: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return fail(code, message)
  }
}

function exactKeys(value: JsonRecord, expected: readonly string[], code: string, label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code, `${label} has an unexpected schema`)
  }
}

export interface TemplateField {
  value?: unknown
  [key: string]: unknown
}

export interface FlowNode {
  id: string
  type?: string
  data?: {
    type?: string
    id?: string
    node?: {
      template?: Record<string, TemplateField>
      [key: string]: unknown
    }
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface FlowEdge {
  source?: string
  target?: string
  data?: JsonRecord
  [key: string]: unknown
}

export interface FlowDefinition {
  id?: string
  name?: string
  folder_id?: string | null
  project_id?: string | null
  data?: {
    nodes?: FlowNode[]
    edges?: FlowEdge[]
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface ResolvedRole {
  role: string
  nodeId: string
  codeSha256: string
  requiredInputs: string[]
}

export interface RoleSpec {
  nodeType: string
  codeSha256: string
  requiredInputs: string[]
  approvedInputs?: string[]
}

export interface ReferenceFlowSpec {
  file: string
  sha256: string
  roles?: Record<string, RoleSpec>
}

export interface ReviewedReferenceManifest {
  schemaVersion: number
  kind: 'syncare-runtime-reference'
  review: {
    approved: boolean
    reviewer: string
    reviewedAt: string
    note?: string
  }
  target: {
    folderId: string
    projectId?: string
    canonicalReviewDbPath?: string
  }
  flows: Record<string, ReferenceFlowSpec>
}

export interface TopologyResult {
  sha256: string
  nodeCount: number
  edgeCount: number
  nodeColors: Record<string, string>
}

export interface LoadedReference {
  manifest: ReviewedReferenceManifest
  target: ReviewedReferenceManifest['target']
  manifestPath: string
  manifestSha256: string
  directory: string
  flows: Record<FlowKey, FlowDefinition>
  topologies: Record<FlowKey, TopologyResult>
  roleNodes: Record<FlowKey, Record<string, ResolvedRole>>
  flowDigests: Record<FlowKey, string>
  contentDigests: Record<FlowKey, string>
}

export function nodeType(node: FlowNode): string {
  const value = node.data?.type ?? node.type
  return typeof value === 'string' && value !== '' ? value : 'unknown'
}

export function nodeTemplate(node: FlowNode): Record<string, TemplateField> {
  const template = node.data?.node?.template
  return isRecord(template) ? (template as Record<string, TemplateField>) : {}
}

export function nodeCode(node: FlowNode): string | null {
  const value = nodeTemplate(node).code?.value
  return typeof value === 'string' ? value : null
}

export function hashNodeCode(node: FlowNode): string | null {
  const code = nodeCode(node)
  return code === null ? null : sha256Hex(code)
}

export function nodeInputNames(node: FlowNode): string[] {
  return Object.keys(nodeTemplate(node))
    .filter(key => key !== 'code' && key !== '_type' && !key.startsWith('_'))
    .sort()
}

export interface ReviewedNodeContent {
  type: string
  codeSha256: string | null
  values: Record<string, unknown>
}

export interface ReviewedFlowContent {
  name: string
  nodes: ReviewedNodeContent[]
  edges: JsonRecord[]
}

export interface ReviewedContentContext {
  /** Exact node id -> structural key. Used for node-ID strings inside template values. */
  nodeKeys: Map<string, string>
  /**
   * Exact node id -> value-aware key (structural key plus the node's canonical
   * normalized values). Used for edge endpoint/handle tokens and node labels so
   * template values stay bound to one node even when nodes share a structure.
   */
  valueKeys: Map<string, string>
  flowIds: Map<string, string>
  serializedHandles?: boolean
  folderId: string
  projectId?: string
}

function sortJsonValue(value: unknown): unknown {
  if (value === undefined) return null
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (isRecord(value)) {
    const result: JsonRecord = {}
    for (const key of Object.keys(value).sort()) result[key] = sortJsonValue(value[key])
    return result
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value))
}

export function nodeTemplateValues(node: FlowNode): Record<string, unknown> {
  const template = nodeTemplate(node)
  const values: Record<string, unknown> = {}
  for (const key of Object.keys(template)) {
    if (key === 'code' || key === '_type' || key.startsWith('_')) continue
    const field = template[key]
    values[key] = sortJsonValue(isRecord(field) && 'value' in field ? field.value : null)
  }
  return values
}

function structuralKeyForNode(node: FlowNode): string {
  return sha256Hex(JSON.stringify([nodeType(node), hashNodeCode(node) ?? '', nodeInputNames(node)])).slice(0, 16)
}

/**
 * Value-aware node identity for reviewed content: node type, code hash and the
 * canonical normalized values. Values stay exact; only exact target-ID strings
 * inside them were replaced by stable tokens. Two nodes that share type, code
 * and input names therefore still get distinct keys when any reviewed value
 * differs, so values cannot be permuted between them.
 */
export function reviewedNodeKey(node: ReviewedNodeContent): string {
  return sha256Hex(canonicalJson([node.type, node.codeSha256 ?? '', node.values])).slice(0, 16)
}

function reviewedNodeContent(node: FlowNode, context: ReviewedContentContext): ReviewedNodeContent {
  return {
    type: nodeType(node),
    codeSha256: hashNodeCode(node),
    values: normalizeReviewedValue(nodeTemplateValues(node), context, null) as Record<string, unknown>,
  }
}

export function reviewedContentContext(
  flow: FlowDefinition,
  flowsById: ReadonlyMap<string, FlowKey>,
  target: {folderId: string; projectId?: string},
): ReviewedContentContext {
  // Node-ID strings inside template values normalize against the structural key,
  // which keeps the value-derived key stable when Langflow regenerates IDs.
  // Edges then bind against the value-aware key (see reviewedFlowContent).
  const nodeKeys = new Map<string, string>()
  for (const node of flowNodes(flow)) nodeKeys.set(node.id, structuralKeyForNode(node))
  const context: ReviewedContentContext = {
    nodeKeys,
    valueKeys: new Map<string, string>(),
    flowIds: new Map(flowsById),
    folderId: target.folderId,
    ...(target.projectId ? {projectId: target.projectId} : {}),
  }
  for (const node of flowNodes(flow)) context.valueKeys.set(node.id, reviewedNodeKey(reviewedNodeContent(node, context)))
  return context
}

function normalizeReviewedValue(value: unknown, context: ReviewedContentContext, fieldName: string | null): unknown {
  if (typeof value === 'string') {
    if (context.serializedHandles && (fieldName === 'sourceHandle' || fieldName === 'targetHandle')) {
      // Langflow duplicates structured handles as JSON with œ-escaped quotes.
      // Parse only these known edge fields, never arbitrary clinical strings.
      let handle: unknown
      try { handle = JSON.parse(value.replaceAll('œ', '"')) }
      catch { return fail('flow_handle_invalid', 'serialized edge handle is not valid JSON') }
      if (!isRecord(handle)) return fail('flow_handle_invalid', 'serialized edge handle must be an object')
      return canonicalJson(normalizeReviewedValue(handle, context, null))
    }
    if (fieldName === '_frontend_node_flow_id') return '<flow-id>'
    if (fieldName === '_frontend_node_folder_id') return '<folder-id>'
    const nodeKey = context.nodeKeys.get(value)
    if (nodeKey !== undefined) return `<node:${nodeKey}>`
    const flowKey = context.flowIds.get(value)
    if (flowKey !== undefined) return `<flow:${flowKey}>`
    if (value === context.folderId) return '<folder-id>'
    if (context.projectId !== undefined && value === context.projectId) return '<project-id>'
    return value
  }
  if (value === undefined) return null
  if (Array.isArray(value)) return value.map(item => normalizeReviewedValue(item, context, fieldName))
  if (isRecord(value)) {
    const result: JsonRecord = {}
    for (const key of Object.keys(value).sort()) result[key] = normalizeReviewedValue(value[key], context, key)
    return result
  }
  return value
}

export function reviewedFlowContent(flow: FlowDefinition, context: ReviewedContentContext): ReviewedFlowContent {
  const nodes = flowNodes(flow).map(node => reviewedNodeContent(node, context))
  // Edges carry node IDs in endpoints and handle metadata; tokenize them with the
  // value-aware key so each reviewed value stays bound to its own node.
  const edgeContext: ReviewedContentContext = {...context, nodeKeys: context.valueKeys, serializedHandles: true}
  const edges = flowEdges(flow).map(edge => {
    const normalized = normalizeReviewedValue(edge, edgeContext, null) as JsonRecord
    normalized.id = '<edge-id>'
    return normalized
  })
  return {name: flow.name!, nodes, edges}
}

interface ContentDigestEntry {
  node: ReviewedNodeContent
  key: string
  label: string
  incoming: Array<{index: number; label: string}>
  outgoing: Array<{index: number; label: string}>
}

const byCanonicalJson = (left: unknown, right: unknown): number => {
  const a = canonicalJson(left)
  const b = canonicalJson(right)
  return a < b ? -1 : a > b ? 1 : 0
}

// Edge endpoints and handle metadata carry node IDs normalized to `<node:key>`
// tokens. Strip the token wrapper so an edge attaches to the node whose
// value-aware key produced it.
const NODE_TOKEN_RE = /^<node:([^<>]+)>$/

function nodeKeyFromToken(value: unknown): string {
  if (typeof value !== 'string') return ''
  const match = NODE_TOKEN_RE.exec(value)
  return match ? match[1]! : value
}

export function reviewedFlowContentDigest(content: ReviewedFlowContent): string {
  const entries: ContentDigestEntry[] = content.nodes.map(node => ({
    node,
    key: reviewedNodeKey(node),
    label: sha256Hex(canonicalJson(node)),
    incoming: [],
    outgoing: [],
  }))
  const byKey = new Map<string, number[]>()
  entries.forEach((entry, index) => {
    const matches = byKey.get(entry.key) ?? []
    matches.push(index)
    byKey.set(entry.key, matches)
  })
  for (const edge of content.edges) {
    const source = nodeKeyFromToken(edge.source)
    const target = nodeKeyFromToken(edge.target)
    const core: JsonRecord = {...edge}
    delete core.source
    delete core.target
    const edgeLabel = sha256Hex(canonicalJson(core))
    const sources = byKey.get(source) ?? []
    const targets = byKey.get(target) ?? []
    for (const sourceIndex of sources) {
      for (const targetIndex of targets) {
        entries[sourceIndex]!.outgoing.push({index: targetIndex, label: edgeLabel})
        entries[targetIndex]!.incoming.push({index: sourceIndex, label: edgeLabel})
      }
    }
  }
  let labels = entries.map(entry => entry.label)
  const rounds = Math.min(6, Math.max(2, entries.length))
  for (let round = 0; round < rounds; round++) {
    labels = entries.map((entry, index) => sha256Hex(canonicalJson([
      labels[index],
      entry.incoming.map(item => `${item.label}@${labels[item.index]}`).sort(),
      entry.outgoing.map(item => `${item.label}@${labels[item.index]}`).sort(),
    ])))
  }
  const payload = {
    name: content.name,
    nodes: entries.map((entry, index) => ({label: labels[index], node: entry.node})).sort(byCanonicalJson),
    edges: [...content.edges].sort(byCanonicalJson),
  }
  return sha256Hex(canonicalJson(payload))
}

export function flowNodes(flow: FlowDefinition): FlowNode[] {
  const nodes = flow.data?.nodes
  if (!Array.isArray(nodes)) return fail('flow_invalid', 'flow has no node array')
  return nodes as FlowNode[]
}

export function flowEdges(flow: FlowDefinition): FlowEdge[] {
  const edges = flow.data?.edges
  if (!Array.isArray(edges)) return fail('flow_invalid', 'flow has no edge array')
  return edges as FlowEdge[]
}

export function hashFlowEdges(flow: FlowDefinition): string {
  return sha256Hex(JSON.stringify(flowEdges(flow)))
}

export function parseFlowDefinition(value: unknown, source = 'flow'): FlowDefinition {
  const flow = record(value, 'flow_invalid', `${source} is not an object`)
  if (!text(flow.name)) fail('flow_invalid', `${source} has no flow name`)
  const data = record(flow.data, 'flow_invalid', `${source} has no data object`)
  if (!Array.isArray(data.nodes) || data.nodes.length === 0) fail('flow_invalid', `${source} has no nodes`)
  if (!Array.isArray(data.edges)) fail('flow_invalid', `${source} has no edges`)
  const rawNodes = data.nodes as unknown[]
  const rawEdges = data.edges as unknown[]
  const ids = new Set<string>()
  for (const raw of rawNodes) {
    const node = record(raw, 'flow_invalid', `${source} has a malformed node`)
    const nodeId = node.id
    if (!text(nodeId)) fail('flow_invalid', `${source} has a node without an id`)
    if (ids.has(nodeId)) fail('flow_invalid', `${source} has duplicate node ids`, {nodeId})
    ids.add(nodeId)
    const type = node.data && isRecord(node.data) ? node.data.type : node.type
    if (!text(type)) fail('flow_invalid', `${source} has a node without a type`, {nodeId})
  }
  const edgeIds = new Set<string>()
  for (const raw of rawEdges) {
    const edge = record(raw, 'flow_invalid', `${source} has a malformed edge`)
    const edgeSource = edge.source
    const edgeTarget = edge.target
    if (!text(edgeSource) || !text(edgeTarget)) fail('flow_invalid', `${source} has an edge without endpoints`)
    if (!ids.has(edgeSource) || !ids.has(edgeTarget)) {
      fail('flow_invalid', `${source} has an edge pointing outside the graph`)
    }
    if (typeof edge.id === 'string') {
      if (edgeIds.has(edge.id)) fail('flow_invalid', `${source} has duplicate edge ids`)
      edgeIds.add(edge.id)
    }
  }
  return flow as unknown as FlowDefinition
}

function edgeHandleLabel(edge: FlowEdge, side: 'source' | 'target'): string {
  const data = isRecord(edge.data) ? edge.data : {}
  const fromData = data[`${side}Handle`]
  const direct = edge[`${side}Handle`]
  const handle = isRecord(fromData) ? fromData : isRecord(direct) ? direct : {}
  const name = typeof handle.name === 'string' ? handle.name : typeof handle.fieldName === 'string' ? handle.fieldName : ''
  const kind = typeof handle.dataType === 'string' ? handle.dataType : typeof handle.type === 'string' ? handle.type : ''
  return `${name}:${kind}`
}

interface NodeIdentity {
  id: string
  type: string
  codeSha256: string | null
  inputs: string[]
}

function topologyFromIdentities(nodes: NodeIdentity[], edges: FlowEdge[]): TopologyResult {
  const index = new Map(nodes.map((node, position) => [node.id, position]))
  const incoming = nodes.map(() => [] as string[])
  const outgoing = nodes.map(() => [] as string[])
  for (const edge of edges) {
    const source = index.get(edge.source ?? '')
    const target = index.get(edge.target ?? '')
    if (source === undefined || target === undefined) fail('flow_invalid', 'edge points outside the graph')
    const label = `${edgeHandleLabel(edge, 'source')}->${edgeHandleLabel(edge, 'target')}`
    outgoing[source!]!.push(`${label}@${target}`)
    incoming[target!]!.push(`${label}@${source}`)
  }
  const base = nodes.map(node => JSON.stringify([node.type, node.codeSha256 ?? '', node.inputs]))
  let colors = base.map(value => sha256Hex(value))
  const rounds = Math.min(6, Math.max(2, nodes.length))
  for (let round = 0; round < rounds; round++) {
    colors = nodes.map((node, position) => sha256Hex(JSON.stringify([
      base[position]!,
      [...incoming[position]!].sort(),
      [...outgoing[position]!].sort(),
    ])))
  }
  const nodeColors: Record<string, string> = {}
  nodes.forEach((node, position) => { nodeColors[node.id] = colors[position]! })
  return {
    sha256: sha256Hex(JSON.stringify({nodes: nodes.length, edges: edges.length, colors: [...colors].sort()})),
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodeColors,
  }
}

export function topologyFingerprint(flow: FlowDefinition): TopologyResult {
  const nodes = flowNodes(flow)
  const edges = flowEdges(flow)
  return topologyFromIdentities(nodes.map(node => ({
    id: node.id,
    type: nodeType(node),
    codeSha256: hashNodeCode(node),
    inputs: nodeInputNames(node),
  })), edges)
}

function topologyFromObserved(observed: ObservedFlow): TopologyResult {
  return topologyFromIdentities(
    observed.nodes.map(node => ({id: node.id, type: node.type, codeSha256: node.codeSha256, inputs: node.inputs})),
    observed.edges as FlowEdge[],
  )
}

export interface SecretFinding {
  path: string
  reason: 'secret_field' | 'code_pattern' | 'known_secret'
}

export function scanFlowForSecrets(value: unknown, knownSecrets: readonly string[] = []): SecretFinding[] {
  const findings: SecretFinding[] = []
  const known = knownSecrets.filter(secret => typeof secret === 'string' && secret.length >= 8)
  const visit = (item: unknown, path: string, fieldName: string | null) => {
    if (typeof item === 'string') {
      if (fieldName && SECRET_FIELD_RE.test(fieldName) && !SECRET_VALUE_ALLOWLIST.test(item)) {
        findings.push({path, reason: 'secret_field'})
      }
      if (CODE_SECRET_PATTERNS.some(pattern => pattern.test(item))) findings.push({path, reason: 'code_pattern'})
      if (known.some(secret => item.includes(secret))) findings.push({path, reason: 'known_secret'})
      return
    }
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${path}[${index}]`, fieldName))
      return
    }
    if (isRecord(item)) {
      for (const [key, child] of Object.entries(item)) {
        visit(child, path === '' ? key : `${path}.${key}`, key)
      }
    }
  }
  visit(value, '', null)
  return findings
}

function validateRoleSpec(key: FlowKey, role: string, value: unknown): RoleSpec {
  const spec = record(value, 'reference_role_invalid', `reference role ${role} is malformed`)
  const nodeType = spec.nodeType
  const codeSha256 = spec.codeSha256
  if (!text(nodeType)) fail('reference_role_invalid', `reference role ${role} has no node type`)
  if (!text(codeSha256) || !SHA256_RE.test(codeSha256)) {
    fail('reference_role_invalid', `reference role ${role} has no valid code hash`)
  }
  if (!Array.isArray(spec.requiredInputs) || !spec.requiredInputs.every(text)) {
    fail('reference_role_invalid', `reference role ${role} has no valid required inputs`)
  }
  const required = [...new Set(spec.requiredInputs as string[])].sort()
  const approved = spec.approvedInputs === undefined ? undefined : (() => {
    if (!Array.isArray(spec.approvedInputs) || !spec.approvedInputs.every(text)) {
      fail('reference_role_invalid', `reference role ${role} has invalid approved inputs`)
    }
    return [...new Set(spec.approvedInputs as string[])].sort()
  })()
  if (approved && required.some(input => !approved.includes(input))) {
    fail('reference_role_invalid', `reference role ${role} approved inputs omit a required input`)
  }
  const mandatory = key === 'f2_record_patient_checkin' && role === 'scorer'
    ? ['baseline_score', 'patient_id']
    : key === 'f5_answer_care_questions' && role === 'retriever'
      ? ['db_path']
      : []
  if (mandatory.some(input => !required.includes(input))) {
    fail('reference_role_invalid', `reference role ${role} is missing a mandatory runtime input`)
  }
  return {
    nodeType,
    codeSha256,
    requiredInputs: required,
    ...(approved ? {approvedInputs: approved} : {}),
  }
}

function validateReferenceShape(value: unknown): ReviewedReferenceManifest {
  const manifest = record(value, 'reference_invalid', 'reference manifest is not an object')
  if (manifest.kind !== 'syncare-runtime-reference' || manifest.schemaVersion !== 1) {
    fail('reference_invalid', 'reference manifest has an unsupported kind or version')
  }
  const review = record(manifest.review, 'reference_invalid', 'reference manifest has no review object')
  if (review.approved !== true) fail('reference_not_approved', 'reference bundle is not explicitly approved')
  if (!text(review.reviewer) || !text(review.reviewedAt) || !Number.isFinite(Date.parse(review.reviewedAt))) {
    fail('reference_invalid', 'reference review metadata is incomplete')
  }
  const target = record(manifest.target, 'reference_invalid', 'reference manifest has no target object')
  if (!text(target.folderId) || !UUID_RE.test(target.folderId)) fail('reference_invalid', 'reference target has no valid folder identity')
  if (target.projectId !== undefined && (!text(target.projectId) || !UUID_RE.test(target.projectId))) {
    fail('reference_invalid', 'reference target project identity is invalid')
  }
  if (target.canonicalReviewDbPath !== undefined && !text(target.canonicalReviewDbPath)) {
    fail('reference_invalid', 'reference target canonical path is invalid')
  }
  const flows = record(manifest.flows, 'reference_invalid', 'reference manifest has no flows object')
  const expected = new Set<string>(FLOW_KEYS)
  for (const key of Object.keys(flows)) {
    if (!expected.has(key)) fail('reference_flow_unknown', 'reference manifest contains an unknown flow key')
  }
  for (const key of FLOW_KEYS) {
    if (!isRecord(flows[key])) fail('reference_flow_missing', `reference manifest is missing ${key}`)
  }
  return manifest as unknown as ReviewedReferenceManifest
}

function resolveRoleNode(flow: FlowDefinition, role: string, spec: RoleSpec): ResolvedRole {
  const nodes = flowNodes(flow)
  const typed = nodes.filter(node => nodeType(node) === spec.nodeType)
  if (typed.length === 0) fail('role_missing', `approved role ${role} is absent from the flow`, {role})
  const coded = typed.filter(node => hashNodeCode(node) === spec.codeSha256)
  if (coded.length === 0) {
    fail('code_drift', `approved role ${role} has no node with the reviewed code`, {
      role,
      expectedCodeSha256: spec.codeSha256,
      observedCodeSha256: typed.map(node => hashNodeCode(node)),
    })
  }
  const withInputs = coded.filter(node => spec.requiredInputs.every(input => input in nodeTemplate(node)))
  if (withInputs.length === 0) {
    const missing = spec.requiredInputs.filter(input => !coded.some(node => input in nodeTemplate(node)))
    fail('input_drift', `approved role ${role} is missing a required input`, {role, missingInputs: missing})
  }
  if (spec.approvedInputs) {
    const exact = withInputs.filter(node => {
      const inputs = nodeInputNames(node)
      return inputs.length === spec.approvedInputs!.length && inputs.every((input, index) => input === spec.approvedInputs![index])
    })
    if (exact.length === 0) {
      fail('input_drift', `approved role ${role} input set has changed`, {role, expectedInputs: spec.approvedInputs})
    }
  }
  const matches = spec.approvedInputs
    ? withInputs.filter(node => {
        const inputs = nodeInputNames(node)
        return inputs.length === spec.approvedInputs!.length && inputs.every((input, index) => input === spec.approvedInputs![index])
      })
    : withInputs
  if (matches.length > 1) {
    fail('role_ambiguous', `approved role ${role} matches more than one node`, {role, nodeIds: matches.map(node => node.id)})
  }
  const node = matches[0]!
  return {
    role,
    nodeId: node.id,
    codeSha256: spec.codeSha256,
    requiredInputs: [...spec.requiredInputs],
  }
}

function safeReferencePath(directory: string, file: string): string {
  if (!text(file) || isAbsolute(file) || file.includes('\0')) fail('reference_invalid', 'reference flow file path is invalid')
  const resolved = resolve(directory, file)
  const inside = relative(directory, resolved)
  if (inside === '' || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) {
    fail('reference_invalid', 'reference flow file escapes the reference directory')
  }
  return resolved
}

export interface LoadReferenceOptions {
  knownSecrets?: readonly string[]
}

export function loadReviewedReference(referencePath: string, options: LoadReferenceOptions = {}): LoadedReference {
  const input = resolve(referencePath)
  let directory: string
  let manifestPath: string
  try {
    const stat = lstatSync(input)
    if (stat.isDirectory()) {
      directory = realpathSync.native(input)
      manifestPath = join(directory, REFERENCE_MANIFEST_FILE)
    } else {
      directory = realpathSync.native(resolve(input, '..'))
      manifestPath = input
    }
  } catch {
    fail('reference_unreadable', 'reference bundle cannot be read')
  }
  let manifestRaw: string
  try {
    manifestRaw = readFileSync(manifestPath, 'utf8')
  } catch {
    fail('reference_unreadable', 'reference manifest cannot be read')
  }
  const manifest = validateReferenceShape(parseJson(manifestRaw, 'reference_invalid_json', 'reference manifest is not valid JSON'))
  const flows = {} as Record<FlowKey, FlowDefinition>
  const topologies = {} as Record<FlowKey, TopologyResult>
  const roleNodes = {} as Record<FlowKey, Record<string, ResolvedRole>>
  const flowDigests = {} as Record<FlowKey, string>
  const contentDigests = {} as Record<FlowKey, string>

  for (const key of FLOW_KEYS) {
    const rawSpec = manifest.flows[key]
    if (!isRecord(rawSpec)) fail('reference_flow_missing', `reference manifest is missing ${key}`)
    const spec = record(rawSpec, 'reference_invalid', `reference flow ${key} is malformed`)
    if (!text(spec.file) || !text(spec.sha256) || !SHA256_RE.test(spec.sha256)) {
      fail('reference_invalid', `reference flow ${key} has an invalid file digest`)
    }
    const flowPath = safeReferencePath(directory, spec.file)
    let raw: string
    try {
      raw = readFileSync(flowPath, 'utf8')
    } catch {
      fail('reference_flow_missing', `reference flow file for ${key} cannot be read`)
    }
    const digest = sha256Hex(raw)
    if (digest !== spec.sha256) {
      fail('reference_digest_mismatch', `reference flow digest differs for ${key}`, {flow: key})
    }
    const flow = parseFlowDefinition(parseJson(raw, 'reference_invalid_json', `reference flow ${key} is not valid JSON`), key)
    if (flow.name !== FLOW_NAMES[key]) {
      fail('reference_name_mismatch', `reference flow name differs for ${key}`, {flow: key, expected: FLOW_NAMES[key]})
    }
    const secretFindings = scanFlowForSecrets(flow, options.knownSecrets)
    if (secretFindings.length > 0) {
      fail('reference_secret_detected', `reference flow ${key} contains unreviewed secret material`, {
        flow: key,
        paths: secretFindings.map(finding => finding.path),
      })
    }
    const roles = spec.roles === undefined ? {} : record(spec.roles, 'reference_role_invalid', `reference roles for ${key} are malformed`)
    const expectedRoles = key === 'f2_record_patient_checkin' ? [F2_ROLE] : key === 'f5_answer_care_questions' ? [...F5_ROLES] : []
    const actualRoles = Object.keys(roles)
    if (actualRoles.length !== expectedRoles.length || actualRoles.some(role => !expectedRoles.includes(role as never))) {
      fail('reference_role_invalid', `reference roles for ${key} do not match the required roles`, {flow: key})
    }
    const resolved = {} as Record<string, ResolvedRole>
    for (const role of expectedRoles) {
      const roleSpec = validateRoleSpec(key, role, roles[role])
      const resolvedRole = resolveRoleNode(flow, role, roleSpec)
      resolved[role] = resolvedRole
    }
    const ids = Object.values(resolved).map(role => role.nodeId)
    if (new Set(ids).size !== ids.length) fail('reference_role_ambiguous', `reference roles for ${key} resolve to the same node`)
    flows[key] = flow
    topologies[key] = topologyFingerprint(flow)
    roleNodes[key] = resolved
    flowDigests[key] = digest
  }

  const flowsById = new Map<string, FlowKey>()
  for (const key of FLOW_KEYS) {
    const flowId = flows[key].id
    if (text(flowId)) flowsById.set(flowId, key)
  }
  for (const key of FLOW_KEYS) {
    const context = reviewedContentContext(flows[key], flowsById, manifest.target)
    contentDigests[key] = reviewedFlowContentDigest(reviewedFlowContent(flows[key], context))
  }

  return {
    manifest,
    target: manifest.target,
    manifestPath,
    manifestSha256: sha256Hex(manifestRaw),
    directory,
    flows,
    topologies,
    roleNodes,
    flowDigests,
    contentDigests,
  }
}

export interface OfflineFinding {
  code: string
  message: string
  flow?: FlowKey
  details?: Record<string, unknown>
}

export interface OfflineFlowReport {
  key: FlowKey
  name: string
  exportId: string | null
  configId: string | null
  idsMatch: boolean
  folderId: string | null
  projectId: string | null
  nodeCount: number
  edgeCount: number
  edgesSha256: string
  topologySha256: string
  dbPaths: string[]
}

export interface OfflineComponentReport {
  configuredId: string
  present: boolean
  codeMatches: boolean
  codeHashMatchNodeIds: string[]
}

export interface OfflineF2Report {
  configuredScorerId: string
  configuredCodeSha256: string
  scorerPresent: boolean
  codeMatches: boolean
  codeHashMatchNodeIds: string[]
}

export interface OfflineF5Report {
  configuredFolderId: string
  exportFolderId: string | null
  configuredEdgesSha256: string
  actualEdgesSha256: string
  components: OfflineComponentReport[]
}

export interface OfflineValidationReport {
  status: 'match' | 'mismatch'
  bundleDir: string
  configDir: string
  flowsJsonPath: string
  findings: OfflineFinding[]
  flows: Partial<Record<FlowKey, OfflineFlowReport>>
  f2: OfflineF2Report | null
  f5: OfflineF5Report | null
}

export interface OfflineBundleOptions {
  bundleDir?: string
  configDir?: string
  flowsJsonPath?: string
  expectedCanonicalReviewDbPath?: string
  expectedProjectId?: string
}

function stringField(value: JsonRecord, key: string): string | null {
  const field = value[key]
  return typeof field === 'string' && field !== '' ? field : null
}

function configObject(value: unknown, code: string, findings: OfflineFinding[], label: string): JsonRecord | null {
  if (!isRecord(value)) {
    findings.push({code, message: `${label} is not an object`})
    return null
  }
  return value
}

function collectDbPaths(flow: FlowDefinition): string[] {
  return flowNodes(flow).flatMap(node => {
    const value = nodeTemplate(node).db_path?.value
    return typeof value === 'string' ? [value] : []
  })
}

export function validateOfflineBundle(options: OfflineBundleOptions = {}): OfflineValidationReport {
  const bundleDir = resolve(options.bundleDir ?? join(REPO_ROOT, 'flows'))
  const configDir = resolve(options.configDir ?? ACTIVE_CONFIG_DIR)
  const flowsJsonPath = resolve(options.flowsJsonPath ?? join(REPO_ROOT, 'flows.json'))
  const findings: OfflineFinding[] = []
  const flows: Partial<Record<FlowKey, OfflineFlowReport>> = {}

  const configMapValue = (() => {
    try {
      return parseJson(readFileSync(flowsJsonPath, 'utf8'), 'flows_json_invalid', 'flows.json is not valid JSON')
    } catch (error) {
      findings.push({code: (error as RuntimeBindingError).code ?? 'flows_json_invalid', message: 'flows.json cannot be read as JSON'})
      return null
    }
  })()
  const configMap = isRecord(configMapValue) ? configMapValue : null
  if (!configMap) findings.push({code: 'flows_json_invalid', message: 'flows.json is not an object'})

  let f2: OfflineF2Report | null = null
  let f5: OfflineF5Report | null = null
  let f2Config: JsonRecord | null = null
  let f5Config: JsonRecord | null = null

  const f2Value = (() => {
    try { return parseJson(readFileSync(join(configDir, 'f2-context.demo.json'), 'utf8'), 'f2_config_invalid', 'F2 config is not valid JSON') } catch { return null }
  })()
  f2Config = configObject(f2Value, 'f2_config_invalid', findings, 'F2 config')
  const f5Value = (() => {
    try { return parseJson(readFileSync(join(configDir, 'f5-runtime.demo.json'), 'utf8'), 'f5_config_invalid', 'F5 config is not valid JSON') } catch { return null }
  })()
  f5Config = configObject(f5Value, 'f5_config_invalid', findings, 'F5 config')

  for (const key of FLOW_KEYS) {
    const file = join(bundleDir, FLOW_FILES[key])
    let flow: FlowDefinition
    try {
      flow = parseFlowDefinition(parseJson(readFileSync(file, 'utf8'), 'flow_export_invalid', `${key} export is not valid JSON`), key)
    } catch (error) {
      findings.push({code: 'flow_export_invalid', flow: key, message: `${key} export is malformed`, details: {error: (error as RuntimeBindingError).code}})
      continue
    }
    const configId = configMap ? stringField(configMap, key) : null
    const exportId = typeof flow.id === 'string' ? flow.id : null
    const topology = topologyFingerprint(flow)
    const dbPaths = collectDbPaths(flow)
    flows[key] = {
      key,
      name: flow.name!,
      exportId,
      configId,
      idsMatch: configId !== null && exportId !== null && configId === exportId,
      folderId: typeof flow.folder_id === 'string' ? flow.folder_id : null,
      projectId: typeof flow.project_id === 'string' ? flow.project_id : null,
      nodeCount: topology.nodeCount,
      edgeCount: topology.edgeCount,
      edgesSha256: hashFlowEdges(flow),
      topologySha256: topology.sha256,
      dbPaths,
    }
    if (configId === null) {
      findings.push({code: 'flow_config_id_missing', flow: key, message: `flows.json has no id for ${key}`})
    } else if (exportId !== null && configId !== exportId) {
      findings.push({code: 'flow_id_mismatch', flow: key, message: `${key} manifest id differs from its export id`})
    }
    if (options.expectedProjectId) {
      const projectId = flows[key]!.projectId
      if (projectId === null) findings.push({code: 'project_identity_missing', flow: key, message: `${key} export has no project identity`})
      else if (projectId !== options.expectedProjectId) findings.push({code: 'project_identity_mismatch', flow: key, message: `${key} export belongs to a foreign project`})
    }
  }

  if (f2Config && flows.f2_record_patient_checkin) {
    const flow = parseFlowDefinition(parseJson(readFileSync(join(bundleDir, FLOW_FILES.f2_record_patient_checkin), 'utf8'), 'flow_export_invalid', 'F2 export is not valid JSON'), 'f2')
    const scorerId = stringField(f2Config, 'scorerId')
    const scorerCodeSha256 = stringField(f2Config, 'scorerCodeSha256')
    if (!scorerId || !scorerCodeSha256 || !SHA256_RE.test(scorerCodeSha256)) {
      findings.push({code: 'f2_config_invalid', flow: 'f2_record_patient_checkin', message: 'F2 config lacks a valid scorer id or code hash'})
    } else {
      const matches = flowNodes(flow).filter(node => node.id === scorerId)
      const codeMatches = flowNodes(flow).filter(node => hashNodeCode(node) === scorerCodeSha256)
      if (matches.length === 0) {
        findings.push({
          code: 'f2_scorer_id_absent',
          flow: 'f2_record_patient_checkin',
          message: 'configured F2 scorer node id is absent from the export',
          details: {configuredScorerId: scorerId, codeHashMatchNodeIds: codeMatches.map(node => node.id)},
        })
      } else if (matches.length > 1) {
        findings.push({code: 'f2_scorer_id_duplicate', flow: 'f2_record_patient_checkin', message: 'configured F2 scorer node id is duplicated'})
      } else {
        const node = matches[0]!
        if (hashNodeCode(node) !== scorerCodeSha256) {
          findings.push({code: 'f2_scorer_code_mismatch', flow: 'f2_record_patient_checkin', message: 'configured F2 scorer code hash differs'})
        }
        for (const input of ['baseline_score', 'patient_id']) {
          if (!(input in nodeTemplate(node))) findings.push({code: 'f2_scorer_input_missing', flow: 'f2_record_patient_checkin', message: `configured F2 scorer lacks ${input}`})
        }
      }
      f2 = {
        configuredScorerId: scorerId,
        configuredCodeSha256: scorerCodeSha256,
        scorerPresent: matches.length === 1,
        codeMatches: matches.length === 1 && hashNodeCode(matches[0]!) === scorerCodeSha256,
        codeHashMatchNodeIds: codeMatches.map(node => node.id),
      }
    }
  }

  if (f5Config && flows.f5_answer_care_questions) {
    const flow = parseFlowDefinition(parseJson(readFileSync(join(bundleDir, FLOW_FILES.f5_answer_care_questions), 'utf8'), 'flow_export_invalid', 'F5 export is not valid JSON'), 'f5')
    const folderId = stringField(f5Config, 'folderId')
    const edgesSha256 = stringField(f5Config, 'edgesSha256')
    const componentsValue = f5Config.components
    if (!folderId || !edgesSha256 || !SHA256_RE.test(edgesSha256) || !isRecord(componentsValue)) {
      findings.push({code: 'f5_config_invalid', flow: 'f5_answer_care_questions', message: 'F5 config lacks a valid folder, edge hash or components'})
    } else {
      const components: OfflineComponentReport[] = []
      const pinnedIds = Object.keys(componentsValue)
      if (pinnedIds.length !== F5_ROLES.length) {
        findings.push({
          code: 'f5_component_count_mismatch',
          flow: 'f5_answer_care_questions',
          message: `F5 config must pin exactly ${F5_ROLES.length} reviewed components`,
          details: {expected: F5_ROLES.length, actual: pinnedIds.length},
        })
      }
      for (const [configuredId, codeHash] of Object.entries(componentsValue)) {
        if (!text(codeHash) || !SHA256_RE.test(codeHash)) {
          findings.push({code: 'f5_config_invalid', flow: 'f5_answer_care_questions', message: 'F5 component hash is invalid'})
          continue
        }
        const matches = flowNodes(flow).filter(node => node.id === configuredId)
        const codeMatches = flowNodes(flow).filter(node => hashNodeCode(node) === codeHash)
        components.push({configuredId, present: matches.length === 1, codeMatches: matches.length === 1 && hashNodeCode(matches[0]!) === codeHash, codeHashMatchNodeIds: codeMatches.map(node => node.id)})
        if (matches.length === 0) {
          findings.push({
            code: 'f5_component_id_absent',
            flow: 'f5_answer_care_questions',
            message: 'configured F5 component id is absent from the export',
            details: {configuredId, codeHashMatchNodeIds: codeMatches.map(node => node.id)},
          })
        } else if (matches.length > 1) {
          findings.push({code: 'f5_component_id_duplicate', flow: 'f5_answer_care_questions', message: 'configured F5 component id is duplicated'})
        } else if (hashNodeCode(matches[0]!) !== codeHash) {
          findings.push({code: 'f5_component_code_mismatch', flow: 'f5_answer_care_questions', message: 'configured F5 component code hash differs'})
        }
      }
      const actualEdgesSha256 = hashFlowEdges(flow)
      if (actualEdgesSha256 !== edgesSha256) {
        findings.push({
          code: 'f5_edges_hash_mismatch',
          flow: 'f5_answer_care_questions',
          message: 'configured F5 graph hash differs from the export',
          details: {configured: edgesSha256, actual: actualEdgesSha256},
        })
      }
      const exportFolderId = typeof flow.folder_id === 'string' ? flow.folder_id : null
      if (exportFolderId === null) {
        findings.push({code: 'f5_folder_identity_absent', flow: 'f5_answer_care_questions', message: 'F5 export carries no folder identity'})
      } else if (exportFolderId !== folderId) {
        findings.push({code: 'f5_folder_identity_mismatch', flow: 'f5_answer_care_questions', message: 'F5 export belongs to a foreign folder'})
      }
      const dbPaths = collectDbPaths(flow)
      if (dbPaths.length === 0) findings.push({code: 'canonical_path_missing', flow: 'f5_answer_care_questions', message: 'F5 export has no canonical db_path'})
      if (dbPaths.length > 1) findings.push({code: 'canonical_path_ambiguous', flow: 'f5_answer_care_questions', message: 'F5 export has multiple canonical db_path values'})
      if (options.expectedCanonicalReviewDbPath && dbPaths.length === 1 && physicalPath(dbPaths[0]!) !== physicalPath(options.expectedCanonicalReviewDbPath)) {
        findings.push({code: 'canonical_path_mismatch', flow: 'f5_answer_care_questions', message: 'F5 export canonical path differs from the selected target'})
      }
      f5 = {configuredFolderId: folderId, exportFolderId, configuredEdgesSha256: edgesSha256, actualEdgesSha256, components}
    }
  }

  return {
    status: findings.length === 0 ? 'match' : 'mismatch',
    bundleDir,
    configDir,
    flowsJsonPath,
    findings,
    flows,
    f2,
    f5,
  }
}

export interface ObservedNode {
  id: string
  type: string
  codeSha256: string | null
  role: string | null
  inputs: string[]
  values: Record<string, unknown>
}

export interface ObservedFlow {
  id: string
  name: string
  folderId: string | null
  projectId: string | null
  nodeCount: number
  edgeCount: number
  topologySha256: string
  edges: unknown[]
  reviewedEdges: JsonRecord[]
  nodes: ObservedNode[]
  dbPaths: string[]
}

export interface CandidateManifest {
  schemaVersion: number
  kind: 'syncare-runtime-candidate'
  status: 'staged'
  generatedAt: string
  applied: false
  reviewRequired: true
  reference: {
    manifestSha256: string
    reviewer: string
    reviewedAt: string
    flowDigests: Record<FlowKey, string>
    flowContentDigests: Record<FlowKey, string>
    roles: Record<string, Record<string, RoleSpec>>
  }
  target: {
    folderId: string
    projectId?: string
    canonicalReviewDbPath: string
  }
  runtime: {
    f2: {
      flowId: string
      scorerId: string
      scorerCodeSha256: string
      verifiedAt: string
    }
    f5: {
      flowId: string
      folderId: string
      edgesSha256: string
      components: Record<string, {role: string; codeSha256: string}>
    }
  }
  observed: Record<FlowKey, ObservedFlow>
  stagedFiles: Record<string, {sha256: string; bytes: number}>
}

export interface CandidateBundle {
  files: Record<string, string>
  manifest: CandidateManifest
}

export interface BuildCandidateOptions {
  reference: LoadedReference
  liveFlows: Record<FlowKey, FlowDefinition>
  now?: Date
  expectedCanonicalReviewDbPath?: string
}

const jsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

function assertFolder(flow: FlowDefinition, target: ReviewedReferenceManifest['target'], key: FlowKey): void {
  if (typeof flow.folder_id !== 'string' || flow.folder_id === '') {
    fail('folder_identity_missing', `${key} has no folder identity`, {flow: key})
  }
  if (flow.folder_id !== target.folderId) {
    fail('foreign_folder', `${key} belongs to a foreign folder`, {flow: key, expectedFolderId: target.folderId})
  }
  if (target.projectId !== undefined) {
    if (typeof flow.project_id !== 'string' || flow.project_id === '') {
      fail('project_identity_missing', `${key} has no project identity`, {flow: key})
    }
    if (flow.project_id !== target.projectId) {
      fail('project_mismatch', `${key} belongs to a foreign project`, {flow: key, expectedProjectId: target.projectId})
    }
  }
}

function roleMap(reference: LoadedReference, key: FlowKey, flow: FlowDefinition): Record<string, ResolvedRole> {
  const specs = reference.manifest.flows[key]?.roles ?? {}
  const resolved: Record<string, ResolvedRole> = {}
  for (const [role, spec] of Object.entries(specs)) resolved[role] = resolveRoleNode(flow, role, spec)
  return resolved
}

export function buildCandidateBundle(options: BuildCandidateOptions): CandidateBundle {
  const {reference} = options
  const now = options.now ?? new Date()
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('candidate_invalid', 'candidate generation requires a valid clock')
  const generatedAt = now.toISOString()
  const expectedPath = resolve(options.expectedCanonicalReviewDbPath ?? reference.manifest.target.canonicalReviewDbPath ?? defaultReviewDbPath())
  if (reference.manifest.target.canonicalReviewDbPath !== undefined &&
      physicalPath(reference.manifest.target.canonicalReviewDbPath) !== physicalPath(expectedPath)) {
    fail('canonical_path_mismatch', 'reviewed reference canonical path differs from the selected target')
  }
  const observed = {} as Record<FlowKey, ObservedFlow>
  const ids: Record<FlowKey, string> = {} as Record<FlowKey, string>
  const resolvedByFlow = {} as Record<FlowKey, Record<string, ResolvedRole>>
  const roleToNode: Record<FlowKey, Record<string, string>> = {} as Record<FlowKey, Record<string, string>>
  const parsed = {} as Record<FlowKey, FlowDefinition>
  const flowsById = new Map<string, FlowKey>()

  for (const key of FLOW_KEYS) {
    const flow = parseFlowDefinition(options.liveFlows[key], key)
    if (flow.name !== FLOW_NAMES[key]) fail('flow_name_mismatch', `${key} live flow name differs`, {flow: key})
    if (!text(flow.id)) fail('flow_id_missing', `${key} live flow has no id`, {flow: key})
    if (!UUID_RE.test(flow.id)) fail('flow_id_invalid', `${key} live flow id is not a UUID`, {flow: key})
    assertFolder(flow, reference.manifest.target, key)
    parsed[key] = flow
    ids[key] = flow.id
    flowsById.set(flow.id, key)
  }

  const f5Flow = parsed.f5_answer_care_questions
  const dbPaths = collectDbPaths(f5Flow)
  if (dbPaths.length === 0) fail('canonical_path_missing', 'F5 live flow has no canonical db_path')
  if (dbPaths.length > 1) fail('canonical_path_ambiguous', 'F5 live flow has multiple canonical db_path values')
  if (physicalPath(dbPaths[0]!) !== physicalPath(expectedPath)) {
    fail('canonical_path_mismatch', 'F5 live flow canonical path differs from the selected target')
  }

  for (const key of FLOW_KEYS) {
    const flow = parsed[key]
    const resolved = roleMap(reference, key, flow)
    resolvedByFlow[key] = resolved
    roleToNode[key] = Object.fromEntries(Object.entries(resolved).map(([role, value]) => [role, value.nodeId]))
    const topology = topologyFingerprint(flow)
    if (topology.sha256 !== reference.topologies[key].sha256) {
      fail('topology_drift', `${key} live graph/code topology differs from the reviewed bundle`, {flow: key})
    }
    const content = reviewedFlowContent(flow, reviewedContentContext(flow, flowsById, reference.manifest.target))
    if (reviewedFlowContentDigest(content) !== reference.contentDigests[key]) {
      fail('reviewed_content_mismatch', `${key} template values or edge data differ from the reviewed bundle`, {flow: key})
    }
    const nodes = flowNodes(flow)
    observed[key] = {
      id: flow.id!,
      name: flow.name!,
      folderId: typeof flow.folder_id === 'string' ? flow.folder_id : null,
      projectId: typeof flow.project_id === 'string' ? flow.project_id : null,
      nodeCount: topology.nodeCount,
      edgeCount: topology.edgeCount,
      topologySha256: topology.sha256,
      edges: JSON.parse(JSON.stringify(flowEdges(flow))) as unknown[],
      reviewedEdges: content.edges,
      nodes: nodes.map((node, index) => {
        const role = Object.entries(roleToNode[key]!).find(([, nodeId]) => nodeId === node.id)?.[0] ?? null
        const reviewed = content.nodes[index]!
        return {
          id: node.id,
          type: reviewed.type,
          codeSha256: reviewed.codeSha256,
          role,
          inputs: nodeInputNames(node),
          values: reviewed.values,
        }
      }),
      dbPaths: collectDbPaths(flow),
    }
  }

  const f2Role = resolvedByFlow.f2_record_patient_checkin.scorer
  if (!f2Role) fail('role_missing', 'reviewed F2 scorer role did not resolve')
  const f5Roles = resolvedByFlow.f5_answer_care_questions
  for (const role of F5_ROLES) if (!f5Roles[role]) fail('role_missing', `reviewed F5 ${role} role did not resolve`)

  const edgesSha256 = hashFlowEdges(f5Flow)

  const f2Config = {
    flowId: ids.f2_record_patient_checkin,
    scorerId: f2Role.nodeId,
    scorerCodeSha256: f2Role.codeSha256,
    verifiedAt: generatedAt,
  }
  const components: Record<string, string> = {}
  const componentEvidence: Record<string, {role: string; codeSha256: string}> = {}
  for (const role of F5_ROLES) {
    const resolved = f5Roles[role]!
    components[resolved.nodeId] = resolved.codeSha256
    componentEvidence[resolved.nodeId] = {role, codeSha256: resolved.codeSha256}
  }
  const f5Config = {
    folderId: reference.manifest.target.folderId,
    edgesSha256,
    components,
  }

  const files: Record<string, string> = {
    'flows.json': jsonText(ids),
    'config/f2-context.demo.json': jsonText(f2Config),
    'config/f5-runtime.demo.json': jsonText(f5Config),
  }
  const stagedFiles: Record<string, {sha256: string; bytes: number}> = {}
  for (const fileKey of CANDIDATE_FILE_KEYS) {
    const textValue = files[fileKey]!
    stagedFiles[fileKey] = {sha256: sha256Hex(textValue), bytes: Buffer.byteLength(textValue)}
  }
  const roles: Record<string, Record<string, RoleSpec>> = {}
  for (const key of FLOW_KEYS) {
    const specs = reference.manifest.flows[key]?.roles
    if (specs) roles[key] = JSON.parse(JSON.stringify(specs)) as Record<string, RoleSpec>
  }
  const manifest: CandidateManifest = {
    schemaVersion: 2,
    kind: 'syncare-runtime-candidate',
    status: 'staged',
    generatedAt,
    applied: false,
    reviewRequired: true,
    reference: {
      manifestSha256: reference.manifestSha256,
      reviewer: reference.manifest.review.reviewer,
      reviewedAt: reference.manifest.review.reviewedAt,
      flowDigests: reference.flowDigests,
      flowContentDigests: reference.contentDigests,
      roles,
    },
    target: {
      folderId: reference.manifest.target.folderId,
      ...(reference.manifest.target.projectId ? {projectId: reference.manifest.target.projectId} : {}),
      canonicalReviewDbPath: expectedPath,
    },
    runtime: {
      f2: f2Config,
      f5: {
        flowId: ids.f5_answer_care_questions,
        folderId: f5Config.folderId,
        edgesSha256,
        components: componentEvidence,
      },
    },
    observed,
    stagedFiles,
  }
  return {files, manifest}
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function physicalPathAllowMissing(input: string): string {
  let current = resolve(input)
  const missing: string[] = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    missing.unshift(basename(current))
    current = parent
  }
  const physical = resolve(realpathSync.native(current), ...missing)
  return process.platform === 'win32' ? physical.toLowerCase() : physical
}

export interface CandidateLocationRoots {
  repoRoot?: string
  activeConfigDir?: string
}

export function assertCandidateLocation(candidateDir: string, roots: CandidateLocationRoots = {}): string {
  const resolved = resolve(candidateDir)
  let existing
  try {
    existing = lstatSync(resolved)
  } catch {
    existing = null
  }
  if (existing?.isSymbolicLink()) {
    fail('output_invalid', 'candidate directory must not be a symbolic link')
  }
  const physicalTarget = physicalPathAllowMissing(resolved)
  const repoRoot = physicalPath(roots.repoRoot ?? REPO_ROOT)
  const activeConfigDir = physicalPath(roots.activeConfigDir ?? ACTIVE_CONFIG_DIR)
  if (physicalTarget === repoRoot || isInside(physicalTarget, repoRoot) || isInside(repoRoot, physicalTarget)) {
    fail('output_active_path', 'candidate directory must be outside the application repository')
  }
  if (physicalTarget === activeConfigDir || isInside(physicalTarget, activeConfigDir) || isInside(activeConfigDir, physicalTarget)) {
    fail('output_active_path', 'candidate directory must be outside the active application configuration')
  }
  return resolved
}

export interface StageCandidateOptions {
  outputDir: string
  bundle: CandidateBundle
}

export interface StageCandidateResult {
  outputDir: string
  manifestSha256: string
}

export function stageCandidateBundle(options: StageCandidateOptions): StageCandidateResult {
  const outputDir = assertCandidateLocation(options.outputDir)
  const parent = resolve(outputDir, '..')
  if (!existsSync(parent) || !lstatSync(parent).isDirectory()) fail('output_parent_missing', 'candidate parent directory must already exist')
  if (existsSync(outputDir)) {
    const stat = lstatSync(outputDir)
    if (!stat.isDirectory()) fail('output_invalid', 'candidate output path is not a directory')
    if (readdirSync(outputDir).length > 0) fail('output_not_empty', 'candidate output directory is not empty')
  }
  for (const fileKey of CANDIDATE_FILE_KEYS) {
    if (typeof options.bundle.files[fileKey] !== 'string') fail('candidate_invalid', `candidate is missing ${fileKey}`)
  }
  const manifestText = jsonText(options.bundle.manifest)
  const manifestSha256 = sha256Hex(manifestText)
  const tempDir = `${outputDir}.tmp-${randomUUID()}`
  try {
    mkdirSync(tempDir)
    for (const fileKey of CANDIDATE_FILE_KEYS) {
      const content = options.bundle.files[fileKey]!
      const path = join(tempDir, fileKey)
      mkdirSync(resolve(path, '..'), {recursive: true})
      writeFileSync(path, content, {flag: 'wx'})
      const record = options.bundle.manifest.stagedFiles[fileKey]
      if (!record || sha256Hex(content) !== record.sha256 || Buffer.byteLength(content) !== record.bytes) {
        fail('candidate_invalid', `candidate digest is inconsistent for ${fileKey}`)
      }
    }
    writeFileSync(join(tempDir, CANDIDATE_MANIFEST_FILE), manifestText, {flag: 'wx'})
    for (const fileKey of CANDIDATE_FILE_KEYS) {
      const expected = options.bundle.manifest.stagedFiles[fileKey]!
      const actual = sha256Hex(readFileSync(join(tempDir, fileKey), 'utf8'))
      if (actual !== expected.sha256) fail('candidate_invalid', `candidate read-back digest failed for ${fileKey}`)
    }
    if (existsSync(outputDir)) rmdirSync(outputDir)
    renameSync(tempDir, outputDir)
    return {outputDir, manifestSha256}
  } catch (error) {
    rmSync(tempDir, {recursive: true, force: true})
    throw error
  }
}

export interface FlowSummary {
  id: string
  name: string
  folder_id?: string | null
  project_id?: string | null
  [key: string]: unknown
}

function asFlowSummary(value: unknown): FlowSummary {
  const summary = record(value, 'engine_response_invalid', 'engine flow summary is malformed')
  if (!text(summary.id) || !text(summary.name)) fail('engine_response_invalid', 'engine flow summary lacks id or name')
  if (summary.folder_id !== undefined && summary.folder_id !== null && typeof summary.folder_id !== 'string') {
    fail('engine_response_invalid', 'engine flow summary has an invalid folder identity')
  }
  if (summary.project_id !== undefined && summary.project_id !== null && typeof summary.project_id !== 'string') {
    fail('engine_response_invalid', 'engine flow summary has an invalid project identity')
  }
  return summary as unknown as FlowSummary
}

export function selectEngineFlows(summaries: readonly unknown[], reference: LoadedReference): Record<FlowKey, FlowSummary> {
  const flows = summaries.map(asFlowSummary)
  const selected = {} as Record<FlowKey, FlowSummary>
  for (const key of FLOW_KEYS) {
    const expectedName = FLOW_NAMES[key]
    const exact = flows.filter(flow => flow.name === expectedName)
    const loose = flows.filter(flow => flow.name.toLowerCase() === expectedName.toLowerCase())
    if (exact.length === 0) {
      if (loose.length > 0) fail('flow_name_mismatch', `engine has ${key} only under a non-canonical name`, {flow: key})
      fail('missing_flow', `engine has no flow named ${expectedName}`, {flow: key})
    }
    if (exact.length > 1 || loose.length > exact.length) {
      fail('duplicate_flow_name', `engine has more than one ${expectedName} flow`, {flow: key, count: Math.max(exact.length, loose.length)})
    }
    const summary = exact[0]!
    if (typeof summary.folder_id === 'string' && summary.folder_id !== reference.manifest.target.folderId) {
      fail('foreign_folder', `${key} engine flow belongs to a foreign folder`, {flow: key})
    }
    if (reference.manifest.target.projectId && typeof summary.project_id === 'string' && summary.project_id !== reference.manifest.target.projectId) {
      fail('project_mismatch', `${key} engine flow belongs to a foreign project`, {flow: key})
    }
    selected[key] = summary
  }
  return selected
}

export interface EngineRequestOptions {
  baseUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
}

export function normalizeEngineBaseUrl(input: string): string {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    fail('invalid_engine_url', 'engine base URL is invalid')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    fail('invalid_engine_url', 'engine base URL must be a plain HTTP(S) origin')
  }
  return url.origin
}

async function engineGet(path: string, options: EngineRequestOptions): Promise<unknown> {
  const baseUrl = normalizeEngineBaseUrl(options.baseUrl)
  const fetcher = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetcher(`${baseUrl}${path}`, {
      method: 'GET',
      headers: {'x-api-key': options.apiKey},
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    })
  } catch {
    fail('engine_unreachable', 'engine GET request failed')
  }
  if (!response.ok) fail('engine_http_error', `engine GET request returned HTTP ${response.status}`, {status: response.status})
  try {
    return await response.json()
  } catch {
    fail('engine_response_invalid', 'engine returned invalid JSON')
  }
}

export async function listEngineFlows(options: EngineRequestOptions): Promise<FlowSummary[]> {
  if (!options.apiKey || options.apiKey.trim() === '') fail('missing_credentials', 'engine API key is required')
  const body = await engineGet('/api/v1/flows/', options)
  if (!Array.isArray(body)) fail('engine_response_invalid', 'engine flow list is not an array')
  return body.map(asFlowSummary)
}

export async function getEngineFlow(flowId: string, options: EngineRequestOptions): Promise<FlowDefinition> {
  if (!text(flowId)) fail('engine_response_invalid', 'engine flow id is missing')
  const body = await engineGet(`/api/v1/flows/${encodeURIComponent(flowId)}`, options)
  return parseFlowDefinition(body, 'engine flow')
}

export interface InspectRuntimeOptions {
  reference: string | LoadedReference
  outputDir: string
  baseUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
  now?: Date
  expectedCanonicalReviewDbPath?: string
  knownSecrets?: readonly string[]
}

export interface InspectRuntimeResult {
  status: 'staged'
  outputDir: string
  manifestSha256: string
  selected: Record<FlowKey, string>
}

export async function inspectRuntimeBindings(options: InspectRuntimeOptions): Promise<InspectRuntimeResult> {
  const reference = typeof options.reference === 'string'
    ? loadReviewedReference(options.reference, {knownSecrets: options.knownSecrets})
    : options.reference
  if (!options.apiKey || options.apiKey.trim() === '') fail('missing_credentials', 'engine API key is required')
  const requestOptions: EngineRequestOptions = {
    baseUrl: normalizeEngineBaseUrl(options.baseUrl),
    apiKey: options.apiKey,
    ...(options.fetchImpl ? {fetchImpl: options.fetchImpl} : {}),
  }
  const summaries = await listEngineFlows(requestOptions)
  const selected = selectEngineFlows(summaries, reference)
  const liveFlows = {} as Record<FlowKey, FlowDefinition>
  for (const key of FLOW_KEYS) {
    const flow = await getEngineFlow(selected[key].id, requestOptions)
    if (flow.id !== selected[key].id || flow.name !== FLOW_NAMES[key]) {
      fail('flow_name_mismatch', `${key} engine detail does not match the selected flow`, {flow: key})
    }
    if (typeof flow.folder_id !== 'string' || flow.folder_id === '') {
      fail('folder_identity_missing', `${key} engine flow has no folder identity`, {flow: key})
    }
    if (flow.folder_id !== reference.manifest.target.folderId) {
      fail('foreign_folder', `${key} engine flow belongs to a foreign folder`, {flow: key})
    }
    if (reference.manifest.target.projectId) {
      if (typeof flow.project_id !== 'string' || flow.project_id === '') {
        fail('project_identity_missing', `${key} engine flow has no project identity`, {flow: key})
      }
      if (flow.project_id !== reference.manifest.target.projectId) {
        fail('project_mismatch', `${key} engine flow belongs to a foreign project`, {flow: key})
      }
    }
    const secretFindings = scanFlowForSecrets(flow, options.knownSecrets)
    if (secretFindings.length > 0) {
      fail('secret_in_flow', `${key} engine flow contains unreviewed secret material`, {
        flow: key,
        paths: secretFindings.map(finding => finding.path),
      })
    }
    liveFlows[key] = flow
  }
  const bundle = buildCandidateBundle({
    reference,
    liveFlows,
    ...(options.now ? {now: options.now} : {}),
    expectedCanonicalReviewDbPath: options.expectedCanonicalReviewDbPath ?? reference.manifest.target.canonicalReviewDbPath ?? defaultReviewDbPath(),
  })
  const staged = stageCandidateBundle({outputDir: options.outputDir, bundle})
  return {
    status: 'staged',
    outputDir: staged.outputDir,
    manifestSha256: staged.manifestSha256,
    selected: Object.fromEntries(FLOW_KEYS.map(key => [key, selected[key].id])) as Record<FlowKey, string>,
  }
}

function validateCandidateManifest(value: unknown): CandidateManifest {
  const manifest = record(value, 'manifest_invalid', 'candidate manifest is not an object')
  if (manifest.kind !== 'syncare-runtime-candidate' || manifest.schemaVersion !== 2 || manifest.status !== 'staged' ||
      manifest.applied !== false || manifest.reviewRequired !== true) {
    fail('manifest_invalid', 'candidate manifest has an unsupported kind, version or status')
  }
  if (!text(manifest.generatedAt) || !Number.isFinite(Date.parse(manifest.generatedAt))) fail('manifest_invalid', 'candidate timestamp is invalid')
  const reference = record(manifest.reference, 'manifest_invalid', 'candidate reference evidence is missing')
  if (!text(reference.manifestSha256) || !SHA256_RE.test(reference.manifestSha256) || !text(reference.reviewer) ||
      !text(reference.reviewedAt) || !Number.isFinite(Date.parse(reference.reviewedAt)) || !isRecord(reference.flowDigests) ||
      !isRecord(reference.flowContentDigests) || !isRecord(reference.roles)) {
    fail('manifest_invalid', 'candidate reference evidence is incomplete')
  }
  exactKeys(reference.flowDigests, FLOW_KEYS, 'manifest_invalid', 'candidate reference flow digests')
  exactKeys(reference.flowContentDigests, FLOW_KEYS, 'manifest_invalid', 'candidate reference content digests')
  for (const key of FLOW_KEYS) {
    const digest = reference.flowDigests[key]
    if (!text(digest) || !SHA256_RE.test(digest)) fail('manifest_invalid', `candidate reference digest is invalid for ${key}`)
    const contentDigest = reference.flowContentDigests[key]
    if (!text(contentDigest) || !SHA256_RE.test(contentDigest)) {
      fail('manifest_invalid', `candidate reference content digest is invalid for ${key}`)
    }
  }
  const target = record(manifest.target, 'manifest_invalid', 'candidate target is missing')
  if (!text(target.folderId)) fail('manifest_invalid', 'candidate target has no folder identity')
  if (target.projectId !== undefined && !text(target.projectId)) fail('manifest_invalid', 'candidate target project is invalid')
  if (!text(target.canonicalReviewDbPath) || !isAbsolute(target.canonicalReviewDbPath)) {
    fail('manifest_invalid', 'candidate target canonical path is invalid')
  }
  const runtime = record(manifest.runtime, 'manifest_invalid', 'candidate runtime bindings are missing')
  const runtimeF2 = record(runtime.f2, 'manifest_invalid', 'candidate F2 binding is missing')
  const runtimeF5 = record(runtime.f5, 'manifest_invalid', 'candidate F5 binding is missing')
  if (!text(runtimeF2.flowId) || !text(runtimeF2.scorerId) || !text(runtimeF2.scorerCodeSha256) ||
      !SHA256_RE.test(runtimeF2.scorerCodeSha256) || !text(runtimeF2.verifiedAt) ||
      !Number.isFinite(Date.parse(runtimeF2.verifiedAt))) {
    fail('manifest_invalid', 'candidate F2 binding is incomplete')
  }
  if (!text(runtimeF5.flowId) || !text(runtimeF5.folderId) || !text(runtimeF5.edgesSha256) ||
      !SHA256_RE.test(runtimeF5.edgesSha256) || !isRecord(runtimeF5.components)) {
    fail('manifest_invalid', 'candidate F5 binding is incomplete')
  }
  const staged = record(manifest.stagedFiles, 'manifest_invalid', 'candidate digest manifest is missing')
  exactKeys(staged, CANDIDATE_FILE_KEYS, 'manifest_invalid', 'candidate digest manifest')
  for (const key of CANDIDATE_FILE_KEYS) {
    const recordValue = record(staged[key], 'manifest_invalid', `candidate digest record is missing for ${key}`)
    if (!text(recordValue.sha256) || !SHA256_RE.test(recordValue.sha256) || typeof recordValue.bytes !== 'number' ||
        !Number.isInteger(recordValue.bytes) || recordValue.bytes < 0) {
      fail('manifest_invalid', `candidate digest record is invalid for ${key}`)
    }
  }
  return manifest as unknown as CandidateManifest
}

function validateObserved(value: unknown): Record<FlowKey, ObservedFlow> {
  const observed = record(value, 'manifest_invalid', 'candidate observed graph evidence is missing')
  exactKeys(observed, FLOW_KEYS, 'manifest_invalid', 'candidate observed graph evidence')
  for (const key of FLOW_KEYS) {
    const flow = record(observed[key], 'manifest_invalid', `candidate observed evidence is missing for ${key}`)
    if (!text(flow.id) || !text(flow.name) || typeof flow.nodeCount !== 'number' || typeof flow.edgeCount !== 'number' ||
        !text(flow.topologySha256) || !SHA256_RE.test(flow.topologySha256) || !Array.isArray(flow.nodes) ||
        !Array.isArray(flow.edges) || !Array.isArray(flow.reviewedEdges) || !Array.isArray(flow.dbPaths)) {
      fail('manifest_invalid', `candidate observed evidence is incomplete for ${key}`)
    }
    const ids = new Set<string>()
    for (const rawNode of flow.nodes) {
      const node = record(rawNode, 'manifest_invalid', `candidate observed node is malformed for ${key}`)
      if (!text(node.id) || ids.has(node.id) || !text(node.type) || !Array.isArray(node.inputs) ||
          !(node.inputs as unknown[]).every(text) || !isRecord(node.values) ||
          (node.codeSha256 !== null && (!text(node.codeSha256) || !SHA256_RE.test(node.codeSha256))) ||
          (node.role !== null && !text(node.role))) {
        fail('manifest_invalid', `candidate observed node is invalid for ${key}`)
      }
      const inputs = [...(node.inputs as string[])].sort()
      const valueKeys = Object.keys(node.values).sort()
      if (inputs.length !== valueKeys.length || inputs.some((input, index) => input !== valueKeys[index])) {
        fail('manifest_invalid', `candidate observed node inputs differ from its reviewed values for ${key}`)
      }
      ids.add(node.id)
    }
    for (const rawEdge of flow.edges) {
      const edge = record(rawEdge, 'manifest_invalid', `candidate observed edge is malformed for ${key}`)
      if (!text(edge.source) || !text(edge.target) || !ids.has(edge.source) || !ids.has(edge.target)) {
        fail('manifest_invalid', `candidate observed edge is invalid for ${key}`)
      }
    }
    for (const rawEdge of flow.reviewedEdges) {
      const edge = record(rawEdge, 'manifest_invalid', `candidate reviewed edge is malformed for ${key}`)
      if (!text(edge.source) || !text(edge.target)) {
        fail('manifest_invalid', `candidate reviewed edge is invalid for ${key}`)
      }
    }
    if (flow.nodes.length !== flow.nodeCount || flow.edges.length !== flow.edgeCount) {
      fail('manifest_invalid', `candidate observed graph counts differ for ${key}`)
    }
    if (flow.reviewedEdges.length !== flow.edgeCount) {
      fail('manifest_invalid', `candidate reviewed edge count differs for ${key}`)
    }
  }
  return observed as unknown as Record<FlowKey, ObservedFlow>
}

export interface VerifyCandidateOptions {
  candidateDir: string
  reference: string | LoadedReference
  expectedCanonicalReviewDbPath?: string
  knownSecrets?: readonly string[]
}

export interface VerifyCandidateResult {
  status: 'verified'
  candidateDir: string
  flows: number
  components: number
  manifestSha256: string
  target: {folderId: string; projectId?: string; canonicalReviewDbPath: string}
}

function exactConfigKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  exactKeys(value, expected, 'manifest_invalid', label)
}

export function verifyCandidate(options: VerifyCandidateOptions): VerifyCandidateResult {
  if (options.reference === undefined || options.reference === null || options.reference === '') {
    fail('reference_required', 'verification requires the approved reviewed reference bundle')
  }
  const reference = typeof options.reference === 'string'
    ? loadReviewedReference(options.reference, {knownSecrets: options.knownSecrets})
    : options.reference
  const candidateDir = assertCandidateLocation(options.candidateDir)
  if (!existsSync(candidateDir) || !lstatSync(candidateDir).isDirectory() || lstatSync(candidateDir).isSymbolicLink()) {
    fail('candidate_not_directory', 'candidate directory is missing or invalid')
  }
  const manifestPath = join(candidateDir, CANDIDATE_MANIFEST_FILE)
  let manifestRaw: string
  try {
    manifestRaw = readFileSync(manifestPath, 'utf8')
  } catch {
    fail('manifest_missing', 'candidate manifest is missing')
  }
  const manifest = validateCandidateManifest(parseJson(manifestRaw, 'manifest_invalid_json', 'candidate manifest is not valid JSON'))
  const expectedPath = resolve(options.expectedCanonicalReviewDbPath ?? reference.target.canonicalReviewDbPath ?? defaultReviewDbPath())
  if (reference.target.canonicalReviewDbPath !== undefined &&
      physicalPath(reference.target.canonicalReviewDbPath) !== physicalPath(expectedPath)) {
    fail('canonical_path_mismatch', 'reviewed reference canonical path differs from the selected target')
  }
  const target = manifest.target

  if (manifest.reference.manifestSha256 !== reference.manifestSha256) {
    fail('reference_manifest_mismatch', 'candidate reference manifest digest does not match the approved reference')
  }
  if (manifest.reference.reviewer !== reference.manifest.review.reviewer ||
      manifest.reference.reviewedAt !== reference.manifest.review.reviewedAt) {
    fail('reference_review_mismatch', 'candidate reference review metadata does not match the approved reference')
  }
  const candidateRoleKeys = Object.keys(manifest.reference.roles).sort()
  const referenceRoleKeys = FLOW_KEYS.filter(key => reference.manifest.flows[key]?.roles !== undefined).sort()
  if (candidateRoleKeys.length !== referenceRoleKeys.length ||
      candidateRoleKeys.some((key, index) => key !== referenceRoleKeys[index])) {
    fail('reference_roles_mismatch', 'candidate reference role key set differs from the approved reference')
  }
  for (const key of FLOW_KEYS) {
    if (manifest.reference.flowDigests[key] !== reference.flowDigests[key]) {
      fail('reference_flow_digest_mismatch', `candidate reference export digest differs for ${key}`, {flow: key})
    }
    if (manifest.reference.flowContentDigests[key] !== reference.contentDigests[key]) {
      fail('reference_content_digest_mismatch', `candidate reference reviewed-content digest differs for ${key}`, {flow: key})
    }
    if (canonicalJson(manifest.reference.roles[key] ?? {}) !== canonicalJson(reference.manifest.flows[key]?.roles ?? {})) {
      fail('reference_roles_mismatch', `candidate reference roles differ for ${key}`, {flow: key})
    }
  }
  if (target.folderId !== reference.target.folderId) {
    fail('foreign_folder', 'candidate target folder differs from the approved reference')
  }
  if (reference.target.projectId !== undefined) {
    if (target.projectId === undefined) fail('project_identity_missing', 'candidate has no project identity')
    if (target.projectId !== reference.target.projectId) fail('project_mismatch', 'candidate target project differs from the approved reference')
  } else if (target.projectId !== undefined) {
    fail('project_identity_unexpected', 'candidate has a project identity the approved reference does not')
  }
  if (physicalPath(target.canonicalReviewDbPath) !== physicalPath(expectedPath)) {
    fail('canonical_path_mismatch', 'candidate target canonical path differs from the selected target')
  }

  const physicalCandidateDir = realpathSync.native(candidateDir)
  const staged: Record<string, string> = {}
  for (const fileKey of CANDIDATE_FILE_KEYS) {
    const relativePath = resolve(candidateDir, fileKey)
    const inside = relative(candidateDir, relativePath)
    if (inside === '' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) fail('manifest_invalid', 'candidate file path escapes its directory')
    if (!existsSync(relativePath)) fail('missing_file', `candidate is missing ${fileKey}`, {file: fileKey})
    const stat = lstatSync(relativePath)
    if (!stat.isFile() || stat.isSymbolicLink()) fail('candidate_invalid', `candidate file is not a regular file: ${fileKey}`, {file: fileKey})
    if (!isInside(realpathSync.native(relativePath), physicalCandidateDir)) {
      fail('candidate_invalid', `candidate file resolves outside its directory: ${fileKey}`, {file: fileKey})
    }
    let content: string
    try {
      content = readFileSync(relativePath, 'utf8')
    } catch {
      fail('missing_file', `candidate is missing ${fileKey}`, {file: fileKey})
    }
    const expected = manifest.stagedFiles[fileKey]!
    if (sha256Hex(content) !== expected.sha256 || Buffer.byteLength(content) !== expected.bytes) {
      fail('digest_mismatch', `candidate digest differs for ${fileKey}`, {file: fileKey})
    }
    staged[fileKey] = content
  }

  const flowsValue = parseJson(staged['flows.json']!, 'manifest_invalid', 'candidate flows.json is invalid JSON')
  const flows = record(flowsValue, 'manifest_invalid', 'candidate flows.json is not an object')
  exactKeys(flows, FLOW_KEYS, 'manifest_invalid', 'candidate flows.json')
  for (const key of FLOW_KEYS) {
    if (!text(flows[key]) || !UUID_RE.test(flows[key] as string)) fail('manifest_invalid', `candidate flow id is invalid for ${key}`)
  }

  const f2 = record(parseJson(staged['config/f2-context.demo.json']!, 'manifest_invalid', 'candidate F2 config is invalid JSON'), 'manifest_invalid', 'candidate F2 config is not an object')
  exactConfigKeys(f2, ['flowId', 'scorerCodeSha256', 'scorerId', 'verifiedAt'], 'candidate F2 config')
  if (!UUID_RE.test(f2.flowId as string) || !text(f2.scorerId) || !SHA256_RE.test(f2.scorerCodeSha256 as string) ||
      !text(f2.verifiedAt) || !Number.isFinite(Date.parse(f2.verifiedAt))) {
    fail('manifest_invalid', 'candidate F2 config is invalid')
  }

  const f5 = record(parseJson(staged['config/f5-runtime.demo.json']!, 'manifest_invalid', 'candidate F5 config is invalid JSON'), 'manifest_invalid', 'candidate F5 config is not an object')
  exactConfigKeys(f5, ['components', 'edgesSha256', 'folderId'], 'candidate F5 config')
  if (!UUID_RE.test(f5.folderId as string) || !SHA256_RE.test(f5.edgesSha256 as string) || !isRecord(f5.components)) {
    fail('manifest_invalid', 'candidate F5 config is invalid')
  }
  for (const [id, hash] of Object.entries(f5.components)) {
    if (!text(id) || !text(hash) || !SHA256_RE.test(hash)) fail('manifest_invalid', 'candidate F5 component pin is invalid')
  }

  const observed = validateObserved(manifest.observed)
  const observedFlowsById = new Map<string, FlowKey>()
  for (const key of FLOW_KEYS) observedFlowsById.set(flows[key] as string, key)
  for (const key of FLOW_KEYS) {
    const flow = observed[key]
    if (flow.name !== FLOW_NAMES[key]) fail('flow_name_mismatch', `candidate observed flow name differs for ${key}`, {flow: key})
    if (flows[key] !== flow.id) fail('flow_id_mismatch', `candidate flows.json id differs for ${key}`, {flow: key})
    if (!UUID_RE.test(flow.id)) fail('manifest_invalid', `candidate observed flow id is invalid for ${key}`)
    const computed = topologyFromObserved(flow)
    if (computed.sha256 !== flow.topologySha256) fail('graph_drift', `candidate observed graph drift for ${key}`, {flow: key})
    if (flow.folderId !== target.folderId) fail('foreign_folder', `candidate observed folder differs for ${key}`, {flow: key})
    if (target.projectId !== undefined) {
      if (flow.projectId === null) fail('project_identity_missing', `candidate observed project is missing for ${key}`, {flow: key})
      if (flow.projectId !== target.projectId) fail('project_mismatch', `candidate observed project differs for ${key}`, {flow: key})
    }
    // Reviewed edges must be the normalization of the observed raw edges under the
    // observed values, so a value cannot be moved to a same-structure sibling while
    // keeping the reviewed edge tokens in place.
    const observedNodeKeys = new Map<string, string>(flow.nodes.map(node => [
      node.id,
      reviewedNodeKey({type: node.type, codeSha256: node.codeSha256, values: node.values}),
    ]))
    const edgeContext: ReviewedContentContext = {
      nodeKeys: observedNodeKeys,
      valueKeys: observedNodeKeys,
      serializedHandles: true,
      flowIds: observedFlowsById,
      folderId: target.folderId,
      ...(target.projectId ? {projectId: target.projectId} : {}),
    }
    const reviewedEdges = (flow.edges as FlowEdge[]).map(edge => {
      const normalized = normalizeReviewedValue(edge, edgeContext, null) as JsonRecord
      normalized.id = '<edge-id>'
      return normalized
    })
    if (canonicalJson([...reviewedEdges].sort(byCanonicalJson)) !== canonicalJson([...flow.reviewedEdges].sort(byCanonicalJson))) {
      fail('reviewed_content_mismatch', `candidate observed values do not match its reviewed edges for ${key}`, {flow: key})
    }
    const content = {
      name: flow.name,
      nodes: flow.nodes.map(node => ({type: node.type, codeSha256: node.codeSha256, values: node.values})),
      edges: reviewedEdges,
    }
    const contentDigest = reviewedFlowContentDigest(content)
    if (contentDigest !== manifest.reference.flowContentDigests[key]) {
      fail('reviewed_content_mismatch', `candidate observed template values or edge data differ for ${key}`, {flow: key})
    }
    if (contentDigest !== reference.contentDigests[key]) {
      fail('reference_content_digest_mismatch', `candidate observed reviewed content differs from the approved reference for ${key}`, {flow: key})
    }

    const expectedRoleSpecs = reference.manifest.flows[key]?.roles ?? {}
    const expectedRoles = Object.keys(expectedRoleSpecs).sort()
    const observedRoles = flow.nodes.filter(node => node.role !== null)
    if (observedRoles.length !== expectedRoles.length) {
      fail('component_missing', `candidate observed role set differs for ${key}`, {flow: key})
    }
    for (const role of expectedRoles) {
      const matches = observedRoles.filter(node => node.role === role)
      if (matches.length !== 1) fail('component_missing', `candidate observed role ${role} is missing or ambiguous`, {flow: key, role})
      const node = matches[0]!
      const spec = expectedRoleSpecs[role]!
      if (node.type !== spec.nodeType) fail('role_type_mismatch', `candidate observed role ${role} has a foreign node type`, {flow: key, role})
      if (node.codeSha256 !== spec.codeSha256) fail('component_code_mismatch', `candidate observed role ${role} has unreviewed code`, {flow: key, role})
      for (const input of spec.requiredInputs) {
        if (!node.inputs.includes(input)) fail('component_input_missing', `candidate observed role ${role} lacks a required input`, {flow: key, role, input})
      }
    }
    for (const node of observedRoles) {
      if (!expectedRoles.includes(node.role!)) fail('component_missing', `candidate observed role ${node.role} is not in the reference`, {flow: key})
    }
  }

  const f2Observed = observed.f2_record_patient_checkin
  if (f2.flowId !== f2Observed.id || f2.flowId !== manifest.runtime.f2.flowId) fail('flow_id_mismatch', 'candidate F2 flow id is inconsistent')
  if (f2.scorerId !== manifest.runtime.f2.scorerId || f2.scorerCodeSha256 !== manifest.runtime.f2.scorerCodeSha256) {
    fail('manifest_invalid', 'candidate F2 runtime evidence differs from its config')
  }
  const scorerNodes = f2Observed.nodes.filter(node => node.role === 'scorer')
  if (scorerNodes.length !== 1) fail('component_missing', 'candidate F2 scorer role is missing or ambiguous')
  if (scorerNodes[0]!.id !== f2.scorerId || scorerNodes[0]!.codeSha256 !== f2.scorerCodeSha256) {
    fail('component_code_mismatch', 'candidate F2 scorer identity differs from observed evidence')
  }

  const f5Observed = observed.f5_answer_care_questions
  if (manifest.runtime.f5.flowId !== f5Observed.id) fail('flow_id_mismatch', 'candidate F5 flow id is inconsistent')
  if (f5.folderId !== target.folderId || f5.folderId !== f5Observed.folderId || f5.folderId !== manifest.runtime.f5.folderId) {
    fail('foreign_folder', 'candidate F5 folder identity is inconsistent')
  }
  const actualEdgesSha256 = sha256Hex(JSON.stringify(f5Observed.edges))
  if (f5.edgesSha256 !== actualEdgesSha256 || f5.edgesSha256 !== manifest.runtime.f5.edgesSha256) {
    fail('graph_drift', 'candidate F5 graph hash differs from the observed graph')
  }
  const f5RoleNodes = f5Observed.nodes.filter(node => node.role !== null)
  const roles = new Map(f5RoleNodes.map(node => [node.role!, node]))
  if (roles.size !== F5_ROLES.length || [...F5_ROLES].some(role => !roles.has(role))) {
    fail('component_missing', 'candidate F5 role set is incomplete')
  }
  const configIds = Object.keys(f5.components).sort()
  const observedIds = f5RoleNodes.map(node => node.id).sort()
  if (configIds.length !== observedIds.length || configIds.some((id, index) => id !== observedIds[index])) {
    fail('component_missing', 'candidate F5 component pins do not match observed roles')
  }
  const runtimeComponents = Object.keys(manifest.runtime.f5.components).sort()
  if (runtimeComponents.length !== configIds.length || runtimeComponents.some((id, index) => id !== configIds[index])) {
    fail('component_missing', 'candidate F5 runtime components do not match the staged config')
  }
  for (const node of f5RoleNodes) {
    if (f5.components[node.id] !== node.codeSha256) fail('component_code_mismatch', `candidate F5 component code differs for ${node.role}`)
    const runtime = manifest.runtime.f5.components[node.id]
    if (!runtime || runtime.role !== node.role || runtime.codeSha256 !== node.codeSha256) {
      fail('component_code_mismatch', `candidate F5 runtime component evidence differs for ${node.role}`)
    }
  }
  if (f5Observed.dbPaths.length !== 1) fail('canonical_path_ambiguous', 'candidate F5 observed graph does not have exactly one canonical path')
  if (physicalPath(f5Observed.dbPaths[0]!) !== physicalPath(target.canonicalReviewDbPath) ||
      physicalPath(target.canonicalReviewDbPath) !== physicalPath(expectedPath)) {
    fail('canonical_path_mismatch', 'candidate F5 canonical path is inconsistent')
  }

  return {
    status: 'verified',
    candidateDir,
    flows: FLOW_KEYS.length,
    components: f5RoleNodes.length,
    manifestSha256: sha256Hex(manifestRaw),
    target: {folderId: target.folderId, ...(target.projectId ? {projectId: target.projectId} : {}), canonicalReviewDbPath: target.canonicalReviewDbPath},
  }
}
