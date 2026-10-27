/**
 * Staged runtime-binding CLI.
 *
 *   bun scripts/runtime-bindings.ts inspect --output <owned-candidate-directory> [--reference <reviewed-bundle>] [--review-db <path>]
 *   bun scripts/runtime-bindings.ts verify --candidate <owned-candidate-directory> --reference <reviewed-bundle> [--review-db <path>]
 *
 * inspect: read-only GET requests to Langflow; writes only the candidate directory.
 * verify:  read-only checks against the staged candidate and the approved reference.
 *
 * Credentials come only from the private environment through the established
 * unprotectEnvironment helper. Credential flags are rejected and never echoed.
 */
import { resolve } from 'node:path'
import { unprotectEnvironment } from '../src/security/private-files.cjs'
import {
  RuntimeBindingError,
  defaultReviewDbPath,
  inspectRuntimeBindings,
  privateEnvironmentKnownSecrets,
  verifyCandidate,
} from './lib/runtime-bindings.ts'

export interface CliOptions {
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
  cwd?: string
  now?: Date
}

export interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
}

const CREDENTIAL_FLAG_RE = /^(--)?(api[-_]?key|apikey|token|password|secret|credential)s?$/i
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  inspect: ['output', 'reference', 'review-db'],
  verify: ['candidate', 'reference', 'review-db'],
}
const KNOWN_FLAGS = ['output', 'reference', 'candidate', 'review-db']
const USAGE = `Usage:
  bun scripts/runtime-bindings.ts inspect --output <owned-candidate-directory> [--reference <reviewed-bundle>] [--review-db <path>]
  bun scripts/runtime-bindings.ts verify --candidate <owned-candidate-directory> --reference <reviewed-bundle> [--review-db <path>]

inspect reads Langflow with GET only and stages flows.json,
config/f2-context.demo.json, config/f5-runtime.demo.json and a digest manifest.
verify requires the explicitly approved reference bundle, reloads it, and checks
the candidate's recorded reference digest, flow digests, roles and target against
it. Nothing is applied automatically. SYNCARE_RUNTIME_REFERENCE may provide the
reference path instead of --reference.`

type Flags = Record<string, string>

function emit(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`
}

function result(exitCode: number, payload: unknown, stderr = ''): CliResult {
  return {exitCode, stdout: emit(payload), stderr}
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {}
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (!arg.startsWith('--')) throw new RuntimeBindingError('usage', 'unexpected positional argument')
    const [rawName, inlineValue] = arg.slice(2).split('=', 2)
    if (!rawName) throw new RuntimeBindingError('usage', 'empty flag')
    if (CREDENTIAL_FLAG_RE.test(rawName)) throw new RuntimeBindingError('credentials_forbidden', 'credentials must come from the private environment, never arguments')
    let value: string | undefined = inlineValue
    if (value === undefined) {
      value = args[index + 1]
      if (value === undefined || value.startsWith('--')) throw new RuntimeBindingError('usage', `missing value for --${rawName}`)
      index++
    }
    if (value.trim() === '') throw new RuntimeBindingError('usage', `empty value for --${rawName}`)
    flags[rawName] = value
  }
  return flags
}

function blocked(code: string, message: string): CliResult {
  return result(1, {status: 'blocked', code, message, candidate: null})
}

function refused(code: string, message: string): CliResult {
  return result(1, {status: 'refused', code, message, candidate: null})
}

function pathFrom(options: CliOptions, value: string): string {
  return resolve(options.cwd ?? process.cwd(), value)
}

export async function runRuntimeBindingsCli(argv: string[], options: CliOptions = {}): Promise<CliResult> {
  const environment = {...(options.env ?? process.env)}
  try {
    unprotectEnvironment(environment)
  } catch {
    return blocked('private_environment_unavailable', 'private environment material could not be unwrapped')
  }
  const command = argv[0]
  if (!command || command === '--help' || command === '-h') return result(0, {status: 'help', usage: USAGE})
  let flags: Flags
  try {
    flags = parseFlags(argv.slice(1))
  } catch (error) {
    const code = error instanceof RuntimeBindingError ? error.code : 'usage'
    const status = code === 'credentials_forbidden' ? 'blocked' : 'usage'
    return result(code === 'credentials_forbidden' ? 1 : 2, {status, code, message: (error as Error).message})
  }
  const allowed = COMMAND_FLAGS[command]
  if (!allowed) return result(2, {status: 'usage', code: 'unknown_command', message: `unknown command: ${command}`})
  for (const flag of Object.keys(flags)) {
    if (allowed.includes(flag)) continue
    if (KNOWN_FLAGS.includes(flag)) {
      return result(2, {status: 'usage', code: 'flag_not_applicable', message: `--${flag} does not apply to ${command}`})
    }
    return result(2, {status: 'usage', code: 'unknown_flag', message: `unknown flag --${flag}`})
  }
  const knownSecrets = privateEnvironmentKnownSecrets(environment)
  const configuredReviewDb = flags['review-db'] ?? environment.SYNCARE_REVIEW_DB
  const reviewDb = configuredReviewDb && configuredReviewDb.trim() !== ''
    ? pathFrom(options, configuredReviewDb)
    : defaultReviewDbPath(environment)

  if (command === 'inspect') {
    const outputDir = flags.output
    if (!outputDir) return result(2, {status: 'usage', code: 'usage', message: 'inspect requires --output'})
    const reference = flags.reference ?? environment.SYNCARE_RUNTIME_REFERENCE
    if (!reference) return blocked('reference_required', 'inspect requires --reference or SYNCARE_RUNTIME_REFERENCE')
    const apiKey = environment.LANGFLOW_API_KEY ?? ''
    if (apiKey.trim() === '') return blocked('missing_credentials', 'LANGFLOW_API_KEY is absent from the private environment')
    const baseUrl = environment.LANGFLOW_BASE_URL ?? 'http://127.0.0.1:7860'
    try {
      const inspected = await inspectRuntimeBindings({
        reference: pathFrom(options, reference),
        outputDir: pathFrom(options, outputDir),
        baseUrl,
        apiKey,
        ...(options.fetchImpl ? {fetchImpl: options.fetchImpl} : {}),
        ...(options.now ? {now: options.now} : {}),
        expectedCanonicalReviewDbPath: reviewDb,
        knownSecrets,
      })
      return result(0, {
        status: inspected.status,
        candidate: inspected.outputDir,
        flows: Object.keys(inspected.selected).length,
        manifestSha256: inspected.manifestSha256,
        engineWrites: false,
        activeConfigWrites: false,
        applied: false,
      })
    } catch (error) {
      const known = error instanceof RuntimeBindingError
      return blocked(known ? error.code : 'inspect_failed', known ? error.message : 'inspection failed without exposing diagnostics')
    }
  }

  if (command === 'verify') {
    const candidateDir = flags.candidate
    if (!candidateDir) return result(2, {status: 'usage', code: 'usage', message: 'verify requires --candidate'})
    const reference = flags.reference ?? environment.SYNCARE_RUNTIME_REFERENCE
    if (!reference) return blocked('reference_required', 'verify requires --reference or SYNCARE_RUNTIME_REFERENCE')
    try {
      const verified = verifyCandidate({
        candidateDir: pathFrom(options, candidateDir),
        reference: pathFrom(options, reference),
        expectedCanonicalReviewDbPath: reviewDb,
        knownSecrets,
      })
      return result(0, {
        status: verified.status,
        candidate: verified.candidateDir,
        flows: verified.flows,
        components: verified.components,
        manifestSha256: verified.manifestSha256,
        target: verified.target,
        engineWrites: false,
        activeConfigWrites: false,
        applied: false,
      })
    } catch (error) {
      const known = error instanceof RuntimeBindingError
      return refused(known ? error.code : 'verify_failed', known ? error.message : 'verification failed without exposing diagnostics')
    }
  }

  return result(2, {status: 'usage', code: 'unknown_command', message: `unknown command: ${command}`})
}

if (import.meta.main) {
  const outcome = await runRuntimeBindingsCli(process.argv.slice(2))
  if (outcome.stdout) process.stdout.write(outcome.stdout)
  if (outcome.stderr) process.stderr.write(outcome.stderr)
  process.exit(outcome.exitCode)
}
