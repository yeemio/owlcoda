import { spawnSync } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type QuickCommandResult = {
  status: string
  exitCode: number
  authorizationGranted: false
  receiptPath?: string
  receiptSha256?: string
  sourceFingerprint?: string | null
  commandExitCode?: number | null
  mutationDecision?: string
  issueCodes?: string[]
  attestCommand?: string
  nextAllowedAction?: string
  attestation?: {
    decision: 'GO' | 'NO_GO' | 'INDETERMINATE'
    issueCodes: string[]
  }
  formalVerification?: {
    valid: boolean
    decision?: string
    issues?: Array<{ code: string }>
  }
  metrics?: Record<string, unknown>
  networkRequests?: number
  issues?: string[]
  message?: string
  decision?: 'GO' | 'NO_GO' | 'INDETERMINATE'
  subjectPath?: string
  subjectSha256?: string
  candidates?: string[]
  repairPlanPath?: string
  repairPlanSha256?: string
  repairAttemptPath?: string
  replacementReceiptId?: string
  reusableCommandIds?: string[]
  replayedCommandIds?: string[]
  activeReceiptSha256?: string
  outputPath?: string
  bundleSha256?: string
  reference?: {
    receiptId: string
    receiptSha256: string
  }
}

export const RUNKIT_QUICK_HELP = `OwlCoda RunKit Quick Verification

Usage:
  owlcoda runkit verify -- <executable> [args...]
  owlcoda runkit verify --json -- <executable> [args...]
  owlcoda attest <receipt> --workspace <path> [--json]
  owlcoda resolve <reference> --store <path> [--json]
  owlcoda runkit metrics --local [--json]

What happens:
  Runs exact argv directly (no shell reconstruction).
  Captures before/after source, exit result, stdout/stderr hashes, and a Quick Receipt.
  Prints the receipt path, SHA-256, source fingerprint, authorization false, and next action.

Attest decisions:
  GO            Receipt and current bound bytes verify under the Quick policy.
  NO-GO         A deterministic mismatch, failure, or forbidden state was found.
  INDETERMINATE Required local material is missing.

Exit codes:
  exit 0  Quick command passed with unchanged source, or attest returned GO.
  exit 1  Command failed, attest returned NO-GO, or resolve was invalid/ambiguous.
  exit 2  Git-visible source changed during or after verification.
  exit 3  Input or required material is missing.

Boundary:
  Quick Receipt assurance is captured_verification, never Formal accepted or reviewer approved.
  Git-ignored artifacts are unbound unless a future explicit artifact contract declares them.
  No network, Git, release, business, writer, or external authority is granted.
  authorization: false
`

export const RUNKIT_REPAIR_HELP = `OwlCoda RunKit Deterministic Repair

Usage:
  owlcoda runkit repair --run-id <run-id> [--json]

What happens:
  Persists RepairPlanV1 before replay.
  Reuses valid command coverage and replays only pending exact argv.
  Preserves old packets, snapshots, receipts, reviews, and failed attempts.
  A successful replacement explicitly supersedes the old receipt.

Exit codes:
  exit 0  Replacement receipt is ready for independent review.
  exit 1  A replay command failed and the failed attempt was preserved.
  exit 2  Source changed during repair and no replacement receipt was created.
  exit 3  Plan, material, lineage, risk, or trusted provenance is incomplete.

Boundary:
  Repair does not sign, commit, publish, release, or grant authority.
  Protected Formal risk requires host-owned actor and reviewer provenance.
  authorization: false
`

export const RUNKIT_STORE_HELP = `OwlCoda RunKit Offline Receipt Store

Usage:
  owlcoda runkit store export --receipt <receipt.json> --output <bundle.json> [--json]
  owlcoda runkit store import --bundle <bundle.json> --store <directory> [--json]

What happens:
  Export creates one exact-byte OwlCodaOfflineAttestationBundleV1.
  Import validates its reference, Core identity, receipt hash, and exact bytes.
  Exact existing receipt bytes are idempotent; conflicts and symlinks fail closed.

Boundary:
  Filesystem mutation remains in the private producer command plane.
  The public verifier stays read-only.
  network requests: 0
  No signing, Git, release, business, writer, or external authority is granted.
  authorization: false
`

function packageRoot(): string {
  return realpathSync(fileURLToPath(new URL('../..', import.meta.url)))
}

function coreCliPath(): string {
  const root = packageRoot()
  const candidate = path.join(root, 'scripts', 'runkit-contract', 'runkit-cli.mjs')
  const stat = lstatSync(candidate)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('RunKit private command port is not a trusted regular file')
  }
  const real = realpathSync(candidate)
  const remainder = path.relative(root, real)
  if (
    remainder === ''
    || remainder === '..'
    || remainder.startsWith(`..${path.sep}`)
    || path.isAbsolute(remainder)
  ) {
    throw new Error('RunKit private command port resolves outside the OwlCoda package')
  }
  return real
}

function publicVerifierCliPath(): string {
  const root = packageRoot()
  const candidate = path.join(root, 'packages', 'attest', 'cli', 'owlcoda-attest.mjs')
  const stat = lstatSync(candidate)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('RunKit public verifier command port is not a trusted regular file')
  }
  const real = realpathSync(candidate)
  const remainder = path.relative(root, real)
  if (
    remainder === ''
    || remainder === '..'
    || remainder.startsWith(`..${path.sep}`)
    || path.isAbsolute(remainder)
  ) {
    throw new Error('RunKit public verifier command port resolves outside the OwlCoda package')
  }
  return real
}

function invokeCore(argv: string[]): QuickCommandResult {
  const completed = spawnSync(process.execPath, [coreCliPath(), ...argv], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
    shell: false,
  })
  if (completed.error) throw completed.error
  let result: QuickCommandResult
  try {
    result = JSON.parse(completed.stdout) as QuickCommandResult
  } catch {
    throw new Error(`RunKit private command port returned invalid JSON: ${completed.stderr.trim()}`)
  }
  if (!Number.isInteger(result.exitCode) || result.exitCode !== completed.status) {
    throw new Error('RunKit private command port exit status does not match its result')
  }
  return result
}

function invokeRepairCore(argv: string[]): QuickCommandResult {
  const completed = spawnSync(process.execPath, [coreCliPath(), ...argv], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  if (completed.error) throw completed.error
  let result: QuickCommandResult
  try {
    result = JSON.parse(completed.stdout) as QuickCommandResult
  } catch {
    throw new Error('RunKit private repair command port returned invalid JSON')
  }
  if (!Number.isInteger(result.exitCode) || result.exitCode !== completed.status) {
    throw new Error('RunKit private repair command port exit status does not match its result')
  }
  return result
}

function invokePublicVerifier(argv: string[]): QuickCommandResult {
  const completed = spawnSync(process.execPath, [publicVerifierCliPath(), ...argv, '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
    shell: false,
  })
  if (completed.error) throw completed.error
  let result: QuickCommandResult
  try {
    result = JSON.parse(completed.stdout) as QuickCommandResult
  } catch {
    throw new Error(`RunKit public verifier command port returned invalid JSON: ${completed.stderr.trim()}`)
  }
  if (!Number.isInteger(result.exitCode) || result.exitCode !== completed.status) {
    throw new Error('RunKit public verifier exit status does not match its result')
  }
  return result
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`)
  }
  return value
}

function optionValues(args: string[], name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${name} requires a value`)
    }
    values.push(value)
    index += 1
  }
  return values
}

function onlyOptions(args: string[], allowedBoolean: Set<string>, allowedValues: Set<string>): void {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!
    if (allowedBoolean.has(value)) continue
    if (allowedValues.has(value)) {
      if (args[index + 1] === undefined) throw new Error(`${value} requires a value`)
      index += 1
      continue
    }
    throw new Error(`Unknown Quick option: ${value}`)
  }
}

function printHuman(result: QuickCommandResult): void {
  if (result.attestation) {
    console.log(`${result.attestation.decision}: Quick Receipt attestation`)
    console.log(`receipt: ${result.receiptPath}`)
    console.log(`receipt sha256: ${result.receiptSha256}`)
    console.log(`source fingerprint: ${result.sourceFingerprint}`)
    console.log(`issues: ${result.attestation.issueCodes.join(', ') || 'none'}`)
  } else if (result.status === 'formal_attestation' && result.formalVerification) {
    console.log(`${result.decision}: Formal RunKit attestation`)
    console.log(`formal closeout: ${result.formalVerification.decision}`)
    console.log(`subject: ${result.subjectPath}`)
    console.log(`subject sha256: ${result.subjectSha256}`)
    console.log(`issues: ${result.formalVerification.issues?.map((issue) => issue.code).join(', ') || 'none'}`)
  } else if (result.metrics) {
    console.log('LOCAL: RunKit Quick metrics')
    console.log(JSON.stringify(result.metrics, null, 2))
    console.log(`network requests: ${result.networkRequests ?? 0}`)
  } else if (
    result.status === 'repaired'
    || result.status === 'repair_plan_incomplete'
    || result.status === 'repair_replay_failed'
    || result.status === 'repair_source_drift'
    || result.status === 'repair_finalize_failed'
  ) {
    const heading = result.status === 'repaired'
      ? 'READY: Formal repair replacement'
      : result.status === 'repair_source_drift'
        ? 'SOURCE DRIFT: Formal repair'
        : result.status === 'repair_replay_failed'
          ? 'NO-GO: Formal repair replay'
          : 'BLOCKED: Formal repair plan'
    console.log(heading)
    console.log(`repair plan: ${result.repairPlanPath}`)
    console.log(`repair plan sha256: ${result.repairPlanSha256 ?? 'unavailable'}`)
    if (result.repairAttemptPath) console.log(`repair attempt: ${result.repairAttemptPath}`)
    if (result.receiptPath) console.log(`replacement receipt: ${result.receiptPath}`)
    if (result.activeReceiptSha256) console.log(`active receipt sha256: ${result.activeReceiptSha256}`)
    console.log(`source fingerprint: ${result.sourceFingerprint ?? 'unavailable'}`)
    console.log(`reused commands: ${(result.reusableCommandIds ?? []).join(', ') || 'none'}`)
    console.log(`replayed commands: ${(result.replayedCommandIds ?? []).join(', ') || 'none'}`)
    console.log(`issues: ${(result.issueCodes ?? []).join(', ') || 'none'}`)
  } else if (result.status.startsWith('offline_')) {
    const heading = result.exitCode === 0 ? 'READY: Offline receipt transfer' : 'NO-GO: Offline receipt transfer'
    console.log(heading)
    if (result.outputPath) console.log(`bundle: ${result.outputPath}`)
    if (result.bundleSha256) console.log(`bundle sha256: ${result.bundleSha256}`)
    if (result.receiptPath) console.log(`receipt: ${result.receiptPath}`)
    if (result.receiptSha256) console.log(`receipt sha256: ${result.receiptSha256}`)
    if (result.reference) console.log(`receipt id: ${result.reference.receiptId}`)
    console.log(`network requests: ${result.networkRequests ?? 0}`)
  } else {
    const heading = result.exitCode === 0
      ? 'PASS: Quick Verification'
      : result.exitCode === 2
        ? 'SOURCE DRIFT: Quick Verification'
        : 'NO-GO: Quick Verification'
    console.log(heading)
    console.log(`receipt: ${result.receiptPath}`)
    console.log(`receipt sha256: ${result.receiptSha256}`)
    console.log(`source fingerprint: ${result.sourceFingerprint}`)
    console.log(`command exit: ${result.commandExitCode}`)
    console.log(`mutation: ${result.mutationDecision}`)
    console.log(`issues: ${(result.issueCodes ?? []).join(', ') || 'none'}`)
    if (result.attestCommand) console.log(`attest: ${result.attestCommand}`)
  }
  console.log('authorization: false')
  console.log(`next: ${result.nextAllowedAction ?? 'none'}`)
}

function emit(result: QuickCommandResult, json: boolean): number {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } else {
    printHuman(result)
  }
  return result.exitCode
}

export function runPublicRunKitCommand(args: string[], cwd = process.cwd()): number {
  const action = args[0]
  if (action === 'verify' && args[1] === '--help') {
    process.stdout.write(RUNKIT_QUICK_HELP)
    return 0
  }
  if (action === 'repair' && args[1] === '--help') {
    process.stdout.write(RUNKIT_REPAIR_HELP)
    return 0
  }
  if (action === 'store' && args[1] === '--help') {
    process.stdout.write(RUNKIT_STORE_HELP)
    return 0
  }
  if (action === 'verify') {
    const separator = args.indexOf('--')
    if (separator < 0 || separator === args.length - 1) {
      throw new Error('Usage: owlcoda runkit verify [--json] -- <executable> [args...]')
    }
    const options = args.slice(1, separator)
    onlyOptions(options, new Set(['--json']), new Set())
    const result = invokeCore([
      'quick-verify',
      '--workspace', realpathSync(cwd),
      '--',
      ...args.slice(separator + 1),
    ])
    return emit(result, options.includes('--json'))
  }
  if (action === 'metrics') {
    const options = args.slice(1)
    onlyOptions(options, new Set(['--local', '--json']), new Set())
    if (!options.includes('--local')) throw new Error('Usage: owlcoda runkit metrics --local [--json]')
    const result = invokeCore([
      'quick-metrics',
      '--workspace', realpathSync(cwd),
      '--local',
    ])
    return emit(result, options.includes('--json'))
  }
  if (action === 'repair') {
    const options = args.slice(1)
    onlyOptions(options, new Set(['--json']), new Set(['--run-id']))
    const runId = optionValue(options, '--run-id')
    if (!runId) throw new Error('Usage: owlcoda runkit repair --run-id <run-id> [--json]')
    const result = invokeRepairCore([
      'repair',
      '--workspace', realpathSync(cwd),
      '--run-id', runId,
    ])
    return emit(result, options.includes('--json'))
  }
  if (action === 'store') {
    const operation = args[1]
    const options = args.slice(2)
    onlyOptions(options, new Set(['--json']), new Set([
      '--receipt',
      '--output',
      '--bundle',
      '--store',
    ]))
    if (operation === 'export') {
      const receipt = optionValue(options, '--receipt')
      const output = optionValue(options, '--output')
      if (!receipt || !output) {
        throw new Error('Usage: owlcoda runkit store export --receipt <receipt.json> --output <bundle.json> [--json]')
      }
      const result = invokeCore([
        'offline-export',
        '--workspace', realpathSync(cwd),
        '--receipt', path.resolve(cwd, receipt),
        '--output', path.resolve(cwd, output),
      ])
      return emit(result, options.includes('--json'))
    }
    if (operation === 'import') {
      const bundle = optionValue(options, '--bundle')
      const store = optionValue(options, '--store')
      if (!bundle || !store) {
        throw new Error('Usage: owlcoda runkit store import --bundle <bundle.json> --store <directory> [--json]')
      }
      const result = invokeCore([
        'offline-import',
        '--workspace', realpathSync(cwd),
        '--bundle', path.resolve(cwd, bundle),
        '--store', path.resolve(cwd, store),
      ])
      return emit(result, options.includes('--json'))
    }
    throw new Error('Usage: owlcoda runkit store <export|import> [options]')
  }
  throw new Error('Usage: owlcoda runkit <verify|repair|metrics|store> [options]')
}

export function runPublicAttestCommand(args: string[], cwd = process.cwd()): number {
  const receipt = args[0]
  if (!receipt || receipt.startsWith('--')) {
    throw new Error('Usage: owlcoda attest <receipt> --workspace <path> [--json]')
  }
  const options = args.slice(1)
  onlyOptions(options, new Set(['--json']), new Set(['--workspace']))
  const workspace = realpathSync(optionValue(options, '--workspace') ?? cwd)
  const result = invokePublicVerifier([
    'attest',
    receipt,
    '--workspace', workspace,
  ])
  if (result.status === 'input_invalid') {
    throw new Error(result.message ?? result.issueCodes?.join('; ') ?? 'RunKit attestation input is invalid')
  }
  if (
    result.status !== 'quick_attestation'
    && result.status !== 'formal_attestation'
  ) {
    throw new Error(result.issues?.join('; ') || 'RunKit attestation returned no decision')
  }
  if (options.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return result.exitCode
  }
  return emit(result, false)
}

export function runPublicResolveCommand(args: string[]): number {
  const reference = args[0]
  if (!reference || reference.startsWith('--')) {
    throw new Error('Usage: owlcoda resolve <attestation-ref> --store <path> [--store <path>...] [--json]')
  }
  const options = args.slice(1)
  onlyOptions(options, new Set(['--json']), new Set(['--store', '--workspace']))
  const stores = optionValues(options, '--store')
  if (stores.length === 0) {
    throw new Error('Usage: owlcoda resolve <attestation-ref> --store <path> [--store <path>...] [--json]')
  }
  const verifierArgs = [
    'resolve',
    reference,
  ]
  const selectedWorkspace = optionValue(options, '--workspace')
  if (selectedWorkspace !== undefined) {
    verifierArgs.push('--workspace', realpathSync(selectedWorkspace))
  }
  for (const store of stores) {
    verifierArgs.push('--store', store)
  }
  const result = invokePublicVerifier(verifierArgs)
  if (result.status === 'input_invalid') {
    throw new Error(result.message ?? result.issueCodes?.join('; ') ?? 'RunKit reference input is invalid')
  }
  if (options.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return result.exitCode
  }
  return emit(result, false)
}
