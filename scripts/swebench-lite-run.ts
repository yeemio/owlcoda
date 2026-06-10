#!/usr/bin/env tsx
/**
 * OwlCoda SWE-bench Lite batch runner.
 *
 * This is intentionally a repo-side evaluation tool, not an npm package file.
 * It generates predictions by running an OwlCoda binary against checked-out
 * SWE-bench Lite instances, then invokes the official SWE-bench harness.
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { finished } from 'node:stream/promises'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { pathToFileURL } from 'node:url'
import {
  diagnoseSwebenchRun,
  shouldWriteSwebenchPrediction,
  summarizeSwebenchRecords,
  type SwebenchRunRecord,
} from '../src/benchmark/swebench-run-records.js'

interface Options {
  root: string
  model: string
  config: string
  count: number | 'all'
  instances: string[]
  repoCache: string
  githubUrlBase: string
  concurrency: number
  packageSpec: string | null
  owlcodaBin: string | null
  swebenchDir: string
  python: string
  resume: boolean
  runEvaluation: boolean
  label: string | null
  startPort: number
  timeoutMs: number
  taskNoProgressLimit: string
  postPatchTimeoutMs: number
  infraRetryPasses: number
  maxInfraFailures: number
  maxConsecutiveInfraFailures: number
}

interface SwebenchInstance {
  instance_id: string
  repo: string
  base_commit: string
  problem_statement: string
}

const DEFAULT_ROOT = '/tmp/owlcoda-swebench-runs/latest'
const DEFAULT_SWEBENCH_DIR = '/tmp/owlcoda-swebench-smoke/SWE-bench'
const DEFAULT_REPO_CACHE = '/tmp/owlcoda-swebench-repo-cache'
const REPO_COMMAND_ATTEMPTS = 3

interface RunPaths {
  instances: string
  home: string
  owlcodaHome: string
  logs: string
  patches: string
  repoCache: string
  predictions: string
  records: string
  infraFailures: string
  providerFailures: string
  summary: string
}

export type SwebenchRunnerOutputPaths = Pick<RunPaths, 'predictions' | 'records' | 'infraFailures' | 'providerFailures'>

interface PendingItem {
  inst: SwebenchInstance
  index: number
}

interface InfraState {
  attempts: Map<string, number>
  totalFailures: number
  consecutiveFailures: number
  aborted: boolean
  abortReason: string | null
}

interface OwlCodaRunAttempt {
  run: Awaited<ReturnType<typeof runLogged>>
  finalJson: ReturnType<typeof parseFinalJson>
  patchText: string
  diagnostics: ReturnType<typeof diagnoseSwebenchRun>
  stdoutPath: string
  stderrPath: string
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  mkdirSync(opts.root, { recursive: true })

  const metadata = loadInstances(opts)
  const selected = selectInstances(metadata, opts)
  if (selected.length === 0) {
    throw new Error('No SWE-bench Lite instances selected.')
  }

  const label = opts.label ?? inferLabel(opts)
  const runRoot = resolve(opts.root)
  const paths = {
    instances: join(runRoot, 'instances'),
    home: join(runRoot, 'home'),
    owlcodaHome: join(runRoot, 'owlcoda-home'),
    logs: join(runRoot, 'logs'),
    patches: join(runRoot, 'patches'),
    repoCache: resolve(opts.repoCache),
    predictions: join(runRoot, `${label}-predictions.jsonl`),
    records: join(runRoot, `${label}-records.jsonl`),
    infraFailures: join(runRoot, `${label}-infra-failures.jsonl`),
    providerFailures: join(runRoot, `${label}-provider-failures.jsonl`),
    summary: join(runRoot, `${label}-summary.json`),
  } satisfies RunPaths
  for (const p of [paths.instances, paths.home, paths.owlcodaHome, paths.logs, paths.patches, paths.repoCache]) {
    mkdirSync(p, { recursive: true })
  }

  const owlcodaCommand = resolveOwlcodaCommand(opts, runRoot)
  console.log(`OwlCoda SWE-bench Lite runner`)
  console.log(`  label: ${label}`)
  console.log(`  root: ${runRoot}`)
  console.log(`  instances: ${selected.length}`)
  console.log(`  concurrency: ${opts.concurrency}`)
  console.log(`  repo cache: ${paths.repoCache}`)
  console.log(`  github url base: ${opts.githubUrlBase}`)
  console.log(`  task_no_progress limit: ${opts.taskNoProgressLimit}`)
  console.log(`  binary: ${owlcodaCommand.command} ${owlcodaCommand.baseArgs.join(' ')}`)

  prepareRunOutputFiles(paths, opts.resume)

  const completed = opts.resume ? readCompletedIds(paths.records) : new Set<string>()
  const pending: PendingItem[] = selected
    .map((inst, index) => ({ inst, index }))
    .filter(({ inst }) => {
      if (!completed.has(inst.instance_id)) return true
      console.log(`  SKIP ${inst.instance_id} (resume)`)
      return false
    })
  let cursor = 0
  const infraState: InfraState = {
    attempts: new Map<string, number>(),
    totalFailures: 0,
    consecutiveFailures: 0,
    aborted: false,
    abortReason: null,
  }
  async function worker(workerId: number): Promise<void> {
    while (!infraState.aborted && cursor < pending.length) {
      const item = pending[cursor++]!
      const { inst, index } = item
      console.log(`  RUN  ${index + 1}/${selected.length} ${inst.instance_id} worker=${workerId}`)
      const startedAt = Date.now()
      let record: SwebenchRunRecord
      try {
        record = await runInstance(inst, index, opts, paths, owlcodaCommand, label, startedAt)
      } catch (err) {
        const attempt = (infraState.attempts.get(inst.instance_id) ?? 0) + 1
        infraState.attempts.set(inst.instance_id, attempt)
        const failure = recordInfrastructureFailure(inst, paths, startedAt, err, attempt)
        appendJsonl(paths.infraFailures, failure)
        infraState.totalFailures++
        infraState.consecutiveFailures++
        const retryRemaining = attempt <= opts.infraRetryPasses
        const abortReason = shouldAbortForInfra(infraState, opts)
        if (abortReason) {
          infraState.aborted = true
          infraState.abortReason = abortReason
          console.error(`  ABORT benchmark generation: ${abortReason}`)
        } else if (retryRemaining) {
          pending.push(item)
          console.warn(`       ${inst.instance_id} infra retry queued attempt=${attempt}/${opts.infraRetryPasses + 1}`)
        } else {
          console.warn(`       ${inst.instance_id} infra deferred after ${attempt} attempt(s); not writing prediction row`)
        }
        continue
      }
      infraState.consecutiveFailures = 0
      appendJsonl(paths.records, record)
      if (record.provider_quota_exhausted && !infraState.aborted) {
        infraState.aborted = true
        infraState.abortReason = `provider quota exhausted at ${inst.instance_id}; stop before writing more tainted empty predictions`
        console.error(`  ABORT benchmark generation: ${infraState.abortReason}`)
      }
      if (shouldWriteSwebenchPrediction(record)) {
        appendJsonl(paths.predictions, {
          instance_id: inst.instance_id,
          model_name_or_path: label,
          model_patch: readFileSync(record.patch_path, 'utf8'),
        })
      } else {
        if (record.provider_failure || record.provider_quota_exhausted || record.port_collision) {
          appendJsonl(paths.providerFailures, record)
        }
        console.warn(`       ${inst.instance_id} unscored=${record.provider_quota_exhausted ? 'provider_quota' : record.provider_failure ? 'provider_failure' : record.port_collision ? 'port_collision' : 'runtime'} patch=${record.patch_bytes}B`)
      }
      console.log(`       ${inst.instance_id} exit=${record.exit_code} parse=${record.parse_ok ? 'ok' : 'bad'} patch=${record.patch_bytes}B denials=${record.approval_denials.length} duration=${formatDuration(record.duration_ms)}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, Math.max(1, pending.length)) }, (_, i) => worker(i + 1)))

  const summary = summarizeRun(paths.records, selected.length, label)
  const infraFailures = readJsonl<SwebenchRunRecord>(paths.infraFailures)
  const completedCount = Number(summary.completed ?? 0)
  const scoreEligibleCount = Number(summary.scoreEligiblePredictions ?? 0)
  const providerFailures = Number(summary.providerFailures ?? 0)
  const uniqueInfraFailures = new Set(infraFailures.map((row) => row.instance_id))
  Object.assign(summary, {
    infrastructureFailures: infraFailures.length,
    infrastructureFailureInstances: uniqueInfraFailures.size,
    deferredInstances: selected.length - scoreEligibleCount,
    aborted: infraState.aborted,
    abortReason: infraState.abortReason,
    infraFailuresPath: paths.infraFailures,
    providerFailuresPath: paths.providerFailures,
  })
  writeFileSync(paths.summary, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`\nPrediction generation summary:`)
  console.log(`  completed rows: ${summary.completed}`)
  console.log(`  score-eligible predictions: ${summary.scoreEligiblePredictions}`)
  console.log(`  infrastructure failures: ${summary.infrastructureFailures}`)
  console.log(`  infrastructure failure instances: ${summary.infrastructureFailureInstances}`)
  console.log(`  deferred instances: ${summary.deferredInstances}`)
  if (summary.aborted) console.log(`  aborted: ${summary.abortReason}`)
  console.log(`  provider failures: ${summary.providerFailures}`)
  console.log(`  provider quota failures: ${summary.providerQuotaFailures}`)
  console.log(`  task_no_progress stops: ${summary.taskNoProgressStops}`)
  console.log(`  task_no_progress recovery: attempts=${summary.taskNoProgressRecoveryAttempts} recovered=${summary.taskNoProgressRecovered}`)
  console.log(`  port collisions: ${summary.portCollisions}`)
  console.log(`  parse failures: ${summary.parseFailures}`)
  console.log(`  post-patch timeout preserved patches: ${summary.postPatchTimeoutPreservedPatches}`)
  console.log(`  empty patches: ${summary.emptyPatches}`)
  console.log(`  unscored empty patches: ${summary.unscoredEmptyPatches}`)
  console.log(`  approval-denial instances: ${summary.instancesWithApprovalDenials}`)
  console.log(`  avg duration: ${formatDuration(Number(summary.avgDurationMs ?? 0))}`)
  console.log(`  predictions: ${paths.predictions}`)
  console.log(`  records: ${paths.records}`)

  if (infraFailures.length > 0 || providerFailures > 0 || scoreEligibleCount !== selected.length) {
    process.exitCode = 1
  }

  if (opts.runEvaluation) {
    const scoreEligibleIds = readScoreEligibleIds(paths.records)
    if (scoreEligibleIds.length !== selected.length || infraFailures.length > 0 || providerFailures > 0) {
      console.warn(`\nSkipping official harness: prediction set is incomplete or provider/infra-tainted (${scoreEligibleIds.length}/${selected.length} score-eligible rows, ${infraFailures.length} infra failures, ${providerFailures} provider failures).`)
      process.exitCode = 1
    } else {
      runOfficialHarness(opts, paths.predictions, scoreEligibleIds, label, runRoot)
    }
  }
}

function parseArgs(args: string[]): Options {
  const opts: Options = {
    root: DEFAULT_ROOT,
    model: 'deepseek-v4-pro',
    config: join(process.env['HOME'] ?? '', '.owlcoda', 'config.json'),
    count: 1,
    instances: [],
    repoCache: DEFAULT_REPO_CACHE,
    githubUrlBase: process.env['OWLCODA_SWEBENCH_GITHUB_URL_BASE'] ?? 'https://github.com',
    concurrency: 1,
    packageSpec: null,
    owlcodaBin: null,
    swebenchDir: DEFAULT_SWEBENCH_DIR,
    python: 'python',
    resume: false,
    runEvaluation: true,
    label: null,
    startPort: 19800,
    timeoutMs: 30 * 60 * 1000,
    taskNoProgressLimit: '40',
    postPatchTimeoutMs: 5 * 60 * 1000,
    infraRetryPasses: 1,
    maxInfraFailures: 20,
    maxConsecutiveInfraFailures: 6,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const [key, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) as [string, string] : [arg, '']
    const value = inlineValue || args[i + 1]
    const consume = inlineValue ? 0 : 1
    switch (key) {
      case '--root': opts.root = requiredValue(key, value); i += consume; break
      case '--model': opts.model = requiredValue(key, value); i += consume; break
      case '--config': opts.config = requiredValue(key, value); i += consume; break
      case '--count': {
        const raw = requiredValue(key, value); i += consume
        opts.count = raw === 'all' ? 'all' : Number.parseInt(raw, 10)
        break
      }
      case '--instance':
      case '--instances': {
        opts.instances.push(...requiredValue(key, value).split(',').map((s) => s.trim()).filter(Boolean))
        i += consume
        break
      }
      case '--package': opts.packageSpec = requiredValue(key, value); i += consume; break
      case '--owlcoda-bin': opts.owlcodaBin = requiredValue(key, value); i += consume; break
      case '--swebench-dir': opts.swebenchDir = requiredValue(key, value); i += consume; break
      case '--python': opts.python = requiredValue(key, value); i += consume; break
      case '--repo-cache': opts.repoCache = requiredValue(key, value); i += consume; break
      case '--github-url-base': opts.githubUrlBase = requiredValue(key, value); i += consume; break
      case '--concurrency': opts.concurrency = Number.parseInt(requiredValue(key, value), 10); i += consume; break
      case '--task-no-progress-limit': opts.taskNoProgressLimit = requiredValue(key, value); i += consume; break
      case '--label': opts.label = requiredValue(key, value); i += consume; break
      case '--start-port': opts.startPort = Number.parseInt(requiredValue(key, value), 10); i += consume; break
      case '--timeout-ms': opts.timeoutMs = Number.parseInt(requiredValue(key, value), 10); i += consume; break
      case '--post-patch-timeout-ms': opts.postPatchTimeoutMs = Number.parseInt(requiredValue(key, value), 10); i += consume; break
      case '--infra-retry-passes': opts.infraRetryPasses = Number.parseInt(requiredValue(key, value), 10); i += consume; break
      case '--max-infra-failures': opts.maxInfraFailures = Number.parseInt(requiredValue(key, value), 10); i += consume; break
      case '--max-consecutive-infra-failures': opts.maxConsecutiveInfraFailures = Number.parseInt(requiredValue(key, value), 10); i += consume; break
      case '--resume': opts.resume = true; break
      case '--no-eval': opts.runEvaluation = false; break
      case '--help': printHelpAndExit(); break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!opts.packageSpec && !opts.owlcodaBin) {
    opts.owlcodaBin = resolve('dist/cli.js')
  }
  if (opts.count !== 'all' && (!Number.isFinite(opts.count) || opts.count <= 0)) {
    throw new Error(`Invalid --count: ${opts.count}`)
  }
  if (!Number.isFinite(opts.concurrency) || opts.concurrency <= 0) {
    throw new Error(`Invalid --concurrency: ${opts.concurrency}`)
  }
  if (!Number.isFinite(opts.postPatchTimeoutMs)) {
    throw new Error(`Invalid --post-patch-timeout-ms: ${opts.postPatchTimeoutMs}`)
  }
  if (!Number.isFinite(opts.infraRetryPasses) || opts.infraRetryPasses < 0) {
    throw new Error(`Invalid --infra-retry-passes: ${opts.infraRetryPasses}`)
  }
  if (!Number.isFinite(opts.maxInfraFailures) || opts.maxInfraFailures < 0) {
    throw new Error(`Invalid --max-infra-failures: ${opts.maxInfraFailures}`)
  }
  if (!Number.isFinite(opts.maxConsecutiveInfraFailures) || opts.maxConsecutiveInfraFailures < 0) {
    throw new Error(`Invalid --max-consecutive-infra-failures: ${opts.maxConsecutiveInfraFailures}`)
  }
  return opts
}

function requiredValue(key: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`)
  return value
}

function printHelpAndExit(): never {
  console.log(`Usage:
  npx tsx scripts/swebench-lite-run.ts --package owlcoda@0.14.26 --model deepseek-v4-pro --count 5 --root /tmp/owlcoda-swebench-runs/0.14.26-sample5
  npx tsx scripts/swebench-lite-run.ts --owlcoda-bin /abs/path/dist/cli.js --label dev-candidate --instance pytest-dev__pytest-5221

Options:
  --package <spec>       Install package into <root>/npm-prefix and use its owlcoda binary.
  --owlcoda-bin <path>   Use a local OwlCoda CLI entry. .js files run through node.
  --count <N|all>        Deterministic prefix count from SWE-bench Lite test split.
  --instance <id,...>    Explicit instance id list. Overrides count selection.
  --root <dir>           Evidence root.
  --repo-cache <dir>     Shared bare mirror cache. Default: ${DEFAULT_REPO_CACHE}
  --github-url-base <url>  GitHub clone base. Examples: https://github.com or git@github.com:. Env: OWLCODA_SWEBENCH_GITHUB_URL_BASE.
  --concurrency <N>      Number of instances to generate in parallel. Default: 1.
  --task-no-progress-limit <N|unlimited>  Guard limit for benchmark runs. Default: 40.
  --post-patch-timeout-ms <N>  Stop an instance after its diff stays non-empty and stable for N ms. Use 0 to disable. Default: 300000.
  --infra-retry-passes <N>  Requeue clone/cache infrastructure failures this many times before deferring. Default: 1.
  --max-infra-failures <N>  Abort generation after N clone/cache infrastructure failures. Use 0 to disable. Default: 20.
  --max-consecutive-infra-failures <N>  Abort after N consecutive clone/cache failures. Use 0 to disable. Default: 6.
  --config <path>        OwlCoda config path.
  --resume               Skip instance ids already recorded.
  --no-eval              Generate predictions only; skip official harness.
`)
  process.exit(0)
}

function loadInstances(opts: Options): SwebenchInstance[] {
  const script = `
from datasets import load_dataset
import json
rows = load_dataset("SWE-bench/SWE-bench_Lite", split="test")
for row in rows:
    print(json.dumps({
        "instance_id": row["instance_id"],
        "repo": row["repo"],
        "base_commit": row["base_commit"],
        "problem_statement": row["problem_statement"],
    }))
`
  const result = spawnSync(opts.python, ['-c', script], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 })
  if (result.status !== 0) {
    throw new Error(`Failed to load SWE-bench Lite metadata with ${opts.python}.\n${result.stderr || result.stdout}`)
  }
  return result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as SwebenchInstance)
}

function selectInstances(rows: SwebenchInstance[], opts: Options): SwebenchInstance[] {
  if (opts.instances.length > 0) {
    const byId = new Map(rows.map((row) => [row.instance_id, row]))
    return opts.instances.map((id) => {
      const row = byId.get(id)
      if (!row) throw new Error(`Unknown SWE-bench Lite instance id: ${id}`)
      return row
    })
  }
  return opts.count === 'all' ? rows : rows.slice(0, opts.count)
}

function resolveOwlcodaCommand(opts: Options, runRoot: string): { command: string; baseArgs: string[] } {
  if (opts.packageSpec) {
    const prefix = join(runRoot, 'npm-prefix')
    mkdirSync(prefix, { recursive: true })
    const install = spawnSync('npm', ['install', '-g', opts.packageSpec, '--prefix', prefix], { stdio: 'inherit' })
    if (install.status !== 0) throw new Error(`npm install failed for ${opts.packageSpec}`)
    return { command: join(prefix, 'bin', 'owlcoda'), baseArgs: [] }
  }
  const bin = resolve(opts.owlcodaBin!)
  if (bin.endsWith('.js')) return { command: process.execPath, baseArgs: [bin] }
  return { command: bin, baseArgs: [] }
}

async function runInstance(
  inst: SwebenchInstance,
  index: number,
  opts: Options,
  paths: RunPaths,
  owlcodaCommand: { command: string; baseArgs: string[] },
  label: string,
  startedAt: number,
): Promise<SwebenchRunRecord> {
  const workspace = join(paths.instances, inst.instance_id)
  resetWorkspace(workspace, inst, paths.repoCache, opts.githubUrlBase)

  const instanceHome = join(paths.home, inst.instance_id)
  const instanceOwlcodaHome = join(paths.owlcodaHome, inst.instance_id)
  mkdirSync(instanceHome, { recursive: true })
  mkdirSync(instanceOwlcodaHome, { recursive: true })

  const stdoutPath = join(paths.logs, `${inst.instance_id}.stdout.log`)
  const stderrPath = join(paths.logs, `${inst.instance_id}.stderr.log`)
  const patchPath = join(paths.patches, `${inst.instance_id}.patch`)
  const prompt = buildPrompt(inst, workspace)
  const preferredPort = opts.startPort + (index * 10)
  const port = await pickAvailablePort(preferredPort)
  if (port !== preferredPort) {
    console.warn(`  WARN ${inst.instance_id}: preferred port ${preferredPort} unavailable; using ${port}`)
  }
  let attempt = await runOwlCodaAttempt({
    prompt,
    stdoutPath,
    stderrPath,
    workspace,
    opts,
    owlcodaCommand,
    port,
    instanceHome,
    instanceOwlcodaHome,
  })

  const taskNoProgressRecoveryAttempted = shouldRetryTaskNoProgress(attempt)
  if (taskNoProgressRecoveryAttempted) {
    console.warn(`       ${inst.instance_id} task_no_progress recovery queued after 0B patch`)
    attempt = await runOwlCodaAttempt({
      prompt: buildTaskNoProgressRecoveryPrompt(inst, workspace, attempt.finalJson.ok ? attempt.finalJson.value : undefined),
      stdoutPath: join(paths.logs, `${inst.instance_id}.retry.stdout.log`),
      stderrPath: join(paths.logs, `${inst.instance_id}.retry.stderr.log`),
      workspace,
      opts,
      owlcodaCommand,
      port,
      instanceHome,
      instanceOwlcodaHome,
      taskNoProgressLimit: recoveryTaskNoProgressLimit(opts.taskNoProgressLimit),
    })
  }

  writeFileSync(patchPath, attempt.patchText)

  await stopDaemon(owlcodaCommand, opts, port, instanceHome, instanceOwlcodaHome)

  const recordError = attempt.finalJson.ok
    ? undefined
    : attempt.run.interactivePromptDetected
      ? `interactive prompt detected; ${attempt.finalJson.error}`
      : attempt.run.timedOut
        ? `timed out; ${attempt.finalJson.error}`
        : attempt.run.postPatchTimedOut
          ? `post-patch timeout; ${attempt.finalJson.error}`
          : attempt.finalJson.error

  const timeoutEmptyStdout = attempt.run.timedOut &&
    attempt.patchText.length === 0 &&
    !attempt.finalJson.ok &&
    attempt.finalJson.error === 'stdout was empty'
  const postPatchTimeoutPreservedPatch = attempt.run.postPatchTimedOut &&
    attempt.patchText.length > 0 &&
    !attempt.finalJson.ok &&
    attempt.finalJson.error === 'stdout was empty'

  const record: SwebenchRunRecord = {
    instance_id: inst.instance_id,
    repo: inst.repo,
    workspace,
    exit_code: attempt.run.code,
    parse_ok: attempt.finalJson.ok,
    approval_denials: attempt.finalJson.value?.approval_denials ?? [],
    patch_bytes: Buffer.byteLength(attempt.patchText),
    patch_path: patchPath,
    stdout_path: attempt.stdoutPath,
    stderr_path: attempt.stderrPath,
    interactive_prompt_detected: attempt.run.interactivePromptDetected,
    timed_out: attempt.run.timedOut,
    post_patch_timeout: attempt.run.postPatchTimedOut,
    duration_ms: Date.now() - startedAt,
    session_id: attempt.finalJson.value?.session_id,
    ...attempt.diagnostics,
    task_no_progress_recovery_attempted: taskNoProgressRecoveryAttempted || undefined,
    task_no_progress_recovered: (taskNoProgressRecoveryAttempted && attempt.patchText.length > 0) || undefined,
    timeout_empty_stdout: timeoutEmptyStdout || undefined,
    post_patch_timeout_preserved_patch: postPatchTimeoutPreservedPatch || undefined,
    runtime_failure_kind: attempt.diagnostics.runtime_failure_kind ?? (timeoutEmptyStdout ? 'timeout_empty_stdout' : undefined),
    error: recordError,
  }
  record.score_eligible = shouldWriteSwebenchPrediction(record)
  return record
}

async function runOwlCodaAttempt(args: {
  prompt: string
  stdoutPath: string
  stderrPath: string
  workspace: string
  opts: Options
  owlcodaCommand: { command: string; baseArgs: string[] }
  port: number
  instanceHome: string
  instanceOwlcodaHome: string
  taskNoProgressLimit?: string
}): Promise<OwlCodaRunAttempt> {
  const cliArgs = [
    ...args.owlcodaCommand.baseArgs,
    '--config', resolve(args.opts.config),
    '--port', String(args.port),
    'run',
    '--model', args.opts.model,
    '--auto-approve',
    '--json',
    '--prompt', args.prompt,
  ]

  const run = await runLogged(args.owlcodaCommand.command, cliArgs, {
    cwd: args.workspace,
    env: {
      ...process.env,
      HOME: args.instanceHome,
      OWLCODA_HOME: args.instanceOwlcodaHome,
      OWLCODA_TASK_NO_PROGRESS_ITER_LIMIT: args.taskNoProgressLimit ?? process.env['OWLCODA_TASK_NO_PROGRESS_ITER_LIMIT'] ?? args.opts.taskNoProgressLimit,
    },
    stdoutPath: args.stdoutPath,
    stderrPath: args.stderrPath,
    timeoutMs: args.opts.timeoutMs,
    patchWatchCwd: args.workspace,
    postPatchTimeoutMs: args.opts.postPatchTimeoutMs,
  })

  const finalJson = parseFinalJson(readFileSync(args.stdoutPath, 'utf8'))
  const patch = spawnSync('git', ['-C', args.workspace, 'diff', '--binary'], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 })
  if (patch.status !== 0) throw new Error(`git diff failed for ${args.workspace}: ${patch.stderr}`)
  const stderrText = existsSync(args.stderrPath) ? readFileSync(args.stderrPath, 'utf8') : ''
  const fallbackText = [
    finalJson.ok ? '' : finalJson.error,
    stderrText,
  ].filter(Boolean).join('\n')
  const diagnostics = diagnoseSwebenchRun(finalJson.ok ? finalJson.value : undefined, fallbackText)

  return {
    run,
    finalJson,
    patchText: patch.stdout,
    diagnostics,
    stdoutPath: args.stdoutPath,
    stderrPath: args.stderrPath,
  }
}

export function recoveryTaskNoProgressLimit(originalLimit: string): string {
  const parsed = Number(originalLimit)
  if (Number.isFinite(parsed) && parsed > 0) return String(Math.min(parsed, 12))
  return '12'
}

function shouldRetryTaskNoProgress(attempt: OwlCodaRunAttempt): boolean {
  return attempt.patchText.length === 0 &&
    Boolean(attempt.diagnostics.task_no_progress) &&
    !attempt.diagnostics.provider_failure &&
    !attempt.diagnostics.provider_quota_exhausted &&
    !attempt.diagnostics.port_collision &&
    !attempt.run.timedOut &&
    !attempt.run.interactivePromptDetected
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const rem = seconds % 60
  return minutes > 0 ? `${minutes}m${String(rem).padStart(2, '0')}s` : `${rem}s`
}

function resetWorkspace(workspace: string, inst: SwebenchInstance, repoCache: string, githubUrlBase = 'https://github.com'): void {
  const source = githubRepoUrl(inst.repo, githubUrlBase)
  const mirror = ensureRepoMirror(inst.repo, inst.base_commit, repoCache, source)
  if (!existsSync(workspace)) {
    cloneWorkspace(workspace, inst, mirror, source)
  }
  try {
    runChecked('git', ['-C', workspace, 'checkout', '-f', inst.base_commit], undefined)
  } catch (err) {
    console.warn(`  WARN ${inst.instance_id}: workspace checkout failed; recloning once (${formatError(err)})`)
    removePath(workspace)
    cloneWorkspace(workspace, inst, mirror, source)
    runChecked('git', ['-C', workspace, 'checkout', '-f', inst.base_commit], undefined)
  }
  runChecked('git', ['-C', workspace, 'clean', '-fdx'], undefined)
}

function ensureRepoMirror(repo: string, requiredCommit: string, repoCache: string, source: string): string | undefined {
  const mirror = join(repoCache, `${repo.replace(/[^A-Za-z0-9_.-]+/g, '__')}.git`)
  mkdirSync(dirname(mirror), { recursive: true })

  if (existsSync(mirror) && !isValidBareMirror(mirror)) {
    console.warn(`  WARN ${repo}: removing incomplete repo mirror ${mirror}`)
    removePath(mirror)
  }

  if (existsSync(mirror)) {
    console.log(`  CACHE ${repo}`)
    if (runWithRetries('git', ['-C', mirror, 'remote', 'update', '--prune'], undefined, REPO_COMMAND_ATTEMPTS, `update mirror ${repo}`)) {
      if (!mirrorHasCommit(mirror, requiredCommit)) {
        console.warn(`  WARN ${repo}: cached mirror updated but missing required commit ${requiredCommit}`)
        return undefined
      }
      return mirror
    }
    if (mirrorHasCommit(mirror, requiredCommit)) {
      console.warn(`  WARN ${repo}: cached mirror update failed; using existing mirror offline because ${requiredCommit} is present`)
      return mirror
    }
    console.warn(`  WARN ${repo}: cached mirror update failed and required commit ${requiredCommit} is missing; leaving cache in place and trying direct clone`)
    return undefined
  }

  for (let attempt = 1; attempt <= REPO_COMMAND_ATTEMPTS; attempt++) {
    console.log(`  MIRROR ${repo} attempt=${attempt}/${REPO_COMMAND_ATTEMPTS}`)
    removePath(mirror)
    if (runCommand('git', ['clone', '--mirror', source, mirror], undefined) === 0 && isValidBareMirror(mirror)) {
      if (!mirrorHasCommit(mirror, requiredCommit)) {
        console.warn(`  WARN ${repo}: new mirror is missing required commit ${requiredCommit}`)
        return undefined
      }
      return mirror
    }
    console.warn(`  WARN ${repo}: mirror clone attempt ${attempt}/${REPO_COMMAND_ATTEMPTS} failed`)
  }

  console.warn(`  WARN ${repo}: mirror unavailable after ${REPO_COMMAND_ATTEMPTS} attempts; falling back to direct workspace clone`)
  return undefined
}

function cloneWorkspace(workspace: string, inst: SwebenchInstance, mirror: string | undefined, source: string): void {
  mkdirSync(dirname(workspace), { recursive: true })
  const cloneSource = mirror ?? source
  for (let attempt = 1; attempt <= REPO_COMMAND_ATTEMPTS; attempt++) {
    removePath(workspace)
    if (runCommand('git', ['clone', cloneSource, workspace], undefined) === 0) {
      if (mirror) {
        runChecked('git', ['-C', workspace, 'remote', 'set-url', 'origin', source], undefined)
      }
      return
    }
    if (attempt < REPO_COMMAND_ATTEMPTS) {
      console.warn(`  WARN clone workspace ${inst.instance_id}: attempt ${attempt}/${REPO_COMMAND_ATTEMPTS} failed; retrying`)
    }
  }
  throw new Error(`Failed to clone workspace for ${inst.instance_id}`)
}

function githubRepoUrl(repo: string, base: string): string {
  if (base.endsWith(':')) return `${base}${repo}.git`
  return `${base.replace(/\/+$/g, '')}/${repo}.git`
}

function runChecked(command: string, args: string[], cwd: string | undefined): void {
  const status = runCommand(command, args, cwd)
  if (status !== 0) throw new Error(`Command failed: ${command} ${args.join(' ')}`)
}

function runWithRetries(command: string, args: string[], cwd: string | undefined, attempts: number, label: string): boolean {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (runCommand(command, args, cwd) === 0) return true
    if (attempt < attempts) {
      console.warn(`  WARN ${label}: attempt ${attempt}/${attempts} failed; retrying`)
    }
  }
  return false
}

function runCommand(command: string, args: string[], cwd: string | undefined): number | null {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  return result.status
}

function isValidBareMirror(path: string): boolean {
  const result = spawnSync('git', ['-C', path, 'rev-parse', '--is-bare-repository'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return result.status === 0 && result.stdout.trim() === 'true'
}

function mirrorHasCommit(mirror: string, commit: string): boolean {
  const result = spawnSync('git', ['-C', mirror, 'cat-file', '-e', `${commit}^{commit}`], {
    stdio: 'ignore',
  })
  return result.status === 0
}

function removePath(path: string): void {
  if (!existsSync(path)) return
  rmSync(path, { recursive: true, force: true })
}

async function pickAvailablePort(preferredPort: number): Promise<number> {
  for (let offset = 0; offset < 10; offset++) {
    const candidate = preferredPort + offset
    if (await isPortAvailable(candidate)) return candidate
  }
  throw new Error(`No free OwlCoda daemon port in range ${preferredPort}-${preferredPort + 9}`)
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer()
    server.once('error', () => resolvePromise(false))
    server.once('listening', () => {
      server.close(() => resolvePromise(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

function shouldAbortForInfra(state: InfraState, opts: Options): string | null {
  if (opts.maxInfraFailures > 0 && state.totalFailures >= opts.maxInfraFailures) {
    return `max infra failures reached (${state.totalFailures}/${opts.maxInfraFailures})`
  }
  if (opts.maxConsecutiveInfraFailures > 0 && state.consecutiveFailures >= opts.maxConsecutiveInfraFailures) {
    return `max consecutive infra failures reached (${state.consecutiveFailures}/${opts.maxConsecutiveInfraFailures})`
  }
  return null
}

function recordInfrastructureFailure(inst: SwebenchInstance, paths: RunPaths, startedAt: number, err: unknown, attempt: number): SwebenchRunRecord {
  const stdoutPath = join(paths.logs, `${inst.instance_id}.stdout.log`)
  const stderrPath = join(paths.logs, `${inst.instance_id}.stderr.log`)
  const patchPath = join(paths.patches, `${inst.instance_id}.patch`)
  const error = formatError(err)
  writeFileSync(stdoutPath, '')
  writeFileSync(stderrPath, `[swebench-lite-run] infrastructure failure before OwlCoda run (attempt ${attempt}):\n${error}\n`)
  writeFileSync(patchPath, '')
  console.error(`       ${inst.instance_id} infra-failure attempt=${attempt} ${error}`)
  return {
    instance_id: inst.instance_id,
    repo: inst.repo,
    workspace: join(paths.instances, inst.instance_id),
    exit_code: null,
    parse_ok: false,
    approval_denials: [],
    patch_bytes: 0,
    patch_path: patchPath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    interactive_prompt_detected: false,
    timed_out: false,
    post_patch_timeout: false,
    duration_ms: Date.now() - startedAt,
    error: `infrastructure failure: ${error}`,
    infra_attempt: attempt,
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function runLogged(
  command: string,
  args: string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    stdoutPath: string
    stderrPath: string
    timeoutMs: number
    patchWatchCwd?: string
    postPatchTimeoutMs?: number
  },
): Promise<{ code: number | null; interactivePromptDetected: boolean; timedOut: boolean; postPatchTimedOut: boolean }> {
  return new Promise((resolvePromise, reject) => {
    const stdout = createWriteStream(options.stdoutPath)
    const stderr = createWriteStream(options.stderrPath)
    let interactivePromptDetected = false
    let timedOut = false
    let postPatchTimedOut = false
    let stdoutTail = ''
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    let lastPatchSignature = ''
    let lastPatchChangedAt = 0
    const patchTimer = options.patchWatchCwd && (options.postPatchTimeoutMs ?? 0) > 0
      ? setInterval(() => {
          const signature = getWorkspaceDiffSignature(options.patchWatchCwd!)
          if (!signature) return
          const now = Date.now()
          if (signature !== lastPatchSignature) {
            lastPatchSignature = signature
            lastPatchChangedAt = now
            return
          }
          if (lastPatchChangedAt > 0 && now - lastPatchChangedAt >= (options.postPatchTimeoutMs ?? 0)) {
            postPatchTimedOut = true
            stderr.write(`\n[swebench-lite-run] non-empty patch stayed stable for ${options.postPatchTimeoutMs}ms; terminating instance and keeping diff.\n`)
            child.kill('SIGTERM')
            setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
            }, 1000).unref()
          }
        }, 15_000)
      : undefined
    patchTimer?.unref()
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdoutTail = `${stdoutTail}${chunk.toString('utf8')}`.slice(-4096)
      if (!interactivePromptDetected && looksLikeInteractivePrompt(stdoutTail)) {
        interactivePromptDetected = true
        stderr.write('\n[swebench-lite-run] interactive prompt detected; terminating instance so batch automation can continue.\n')
        child.kill('SIGTERM')
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }, 1000).unref()
      }
    })
    child.stdout.pipe(stdout)
    child.stderr.pipe(stderr)
    child.on('error', reject)
    child.on('close', async (code) => {
      clearTimeout(timer)
      if (patchTimer) clearInterval(patchTimer)
      stdout.end()
      stderr.end()
      try {
        await Promise.all([finished(stdout), finished(stderr)])
        resolvePromise({ code, interactivePromptDetected, timedOut, postPatchTimedOut })
      } catch (err) {
        reject(err)
      }
    })
  })
}

function getWorkspaceDiffSignature(cwd: string): string {
  const result = spawnSync('git', ['-C', cwd, 'diff', '--raw', '--shortstat'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  if (result.status !== 0) return ''
  return result.stdout.trim()
}

function looksLikeInteractivePrompt(text: string): boolean {
  return /Enter numbers separated by commas, or type your answer:\s*>?\s*$/m.test(text) ||
    /Enter number or type your answer:\s*>?\s*$/m.test(text)
}

async function stopDaemon(
  owlcodaCommand: { command: string; baseArgs: string[] },
  opts: Options,
  port: number,
  home: string,
  owlcodaHome: string,
): Promise<void> {
  await runLogged(owlcodaCommand.command, [
    ...owlcodaCommand.baseArgs,
    '--config', resolve(opts.config),
    '--port', String(port),
    'stop',
    '--force',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, OWLCODA_HOME: owlcodaHome },
    stdoutPath: join(owlcodaHome, 'stop.stdout.log'),
    stderrPath: join(owlcodaHome, 'stop.stderr.log'),
    timeoutMs: 30_000,
  }).catch(() => undefined)
}

function buildPrompt(inst: SwebenchInstance, workspace: string): string {
  return [
    'We need solve this SWE-bench issue in the current repository checkout.',
    '',
    'Workspace and permissions:',
    `- Current repository checkout: ${workspace}/`,
    '- You may edit any file under this checkout only.',
    '- This is an unattended benchmark run: never call AskUserQuestion or ask the user for permission/clarification.',
    '- Use structured Read/Grep/Edit/Write tools for repository inspection and code changes.',
    '- Do not use bash for file inspection, grep, echo, file creation, cleanup, patching, local builds, dependency setup, or git inspection. In particular, do not run shell redirection, rm, grep/rg through bash, echo through bash, tee, sed -i, perl -pi, python -c, git -C through bash, pip install, or setup.py build_ext.',
    '- If you need to inspect files, use Read or Grep tools. If you need to modify files, use Edit or Write tools.',
    '- Make a plausible minimal edit by the third tool call whenever the target file is reasonably identifiable. If evidence is incomplete, edit the most likely file instead of continuing broad exploration.',
    '- Do not repeat the same read/search pattern. If you have revisited the same area twice, patch first and verify after.',
    '- After producing a non-empty patch, finish immediately. Do not run verification commands in this unattended generation pass; record tests not run in your final summary.',
    '- If a shell check is denied or dependencies are unavailable, keep the code edit, record the blocker in your final summary, and finish; do not try another shell command and do not wait for user approval.',
    '- Do not finish until you have either produced a non-empty repository diff or reported a concrete blocker.',
    '',
    'Issue:',
    inst.problem_statement.trim(),
    '',
    'Requirements:',
    '- Modify the repository files to implement the requested behavior.',
    '- Keep the patch minimal and production-quality.',
    '- Do not commit.',
    '- Do not run verification commands during this prediction-generation pass.',
    '- When done, briefly summarize changed files and say tests were not run by this unattended runner.',
  ].join('\n')
}

function buildTaskNoProgressRecoveryPrompt(inst: SwebenchInstance, workspace: string, previousResult: unknown): string {
  const inspectedPaths = extractInspectedPaths(previousResult, workspace)
  return [
    'The previous unattended SWE-bench attempt stopped with task_no_progress after many read-only tool calls and no repository edit.',
    '',
    'Recovery rules:',
    '- This is the one recovery attempt for the same checkout.',
    '- Hard first action: your first tool call in this recovery attempt must be Edit or Write.',
    '- Do not call Read, Grep, Bash, or any other inspection tool before the first edit.',
    '- Make the smallest plausible Edit or Write immediately, using one of the already inspected implementation files unless the issue clearly names a better target.',
    '- Do not use bash for file inspection, grep, echo, file creation, cleanup, patching, local builds, or dependency setup.',
    '- Do not use shell redirection, rm, grep/rg through bash, echo through bash, tee, sed -i, perl -pi, python -c, git -C through bash, pip install, or setup.py build_ext.',
    '- If the exact fix is uncertain, still make the minimal production-quality change nearest to the issue instead of continuing a read-only loop.',
    '- After a non-empty patch exists, finish immediately and record tests not run.',
    inspectedPaths.length > 0 ? `- Previously inspected files: ${inspectedPaths.join(', ')}` : '- No inspected file list was available; use the issue text to choose the most likely implementation file.',
    '',
    'Workspace and permissions:',
    `- Current repository checkout: ${workspace}/`,
    '- You may edit any file under this checkout only.',
    '',
    'Original issue:',
    inst.problem_statement.trim(),
  ].join('\n')
}

export function extractInspectedPaths(previousResult: unknown, workspace: string): string[] {
  const root = previousResult !== null && typeof previousResult === 'object' ? previousResult as Record<string, unknown> : undefined
  const calls = Array.isArray(root?.['tool_calls']) ? root['tool_calls'] : []
  const seen = new Set<string>()
  const normalizedWorkspace = normalizeDarwinTmpPath(workspace)
  for (const call of calls) {
    if (seen.size >= 8 || call === null || typeof call !== 'object') continue
    const input = (call as Record<string, unknown>)['input']
    if (input === null || typeof input !== 'object') continue
    const rawPath = (input as Record<string, unknown>)['path']
    if (typeof rawPath !== 'string' || rawPath.length === 0) continue
    const comparablePath = normalizeDarwinTmpPath(rawPath)
    const normalized = comparablePath.startsWith(`${normalizedWorkspace}/`) ? comparablePath.slice(normalizedWorkspace.length + 1) : comparablePath
    if (!normalized.startsWith('/') && !seen.has(normalized)) seen.add(normalized)
  }
  return Array.from(seen)
}

function normalizeDarwinTmpPath(path: string): string {
  return path.startsWith('/private/tmp/') ? `/tmp/${path.slice('/private/tmp/'.length)}` : path
}

function parseFinalJson(stdout: string): { ok: true; value: any } | { ok: false; error: string } {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  const last = lines[lines.length - 1]
  if (!last) return { ok: false, error: 'stdout was empty' }
  try {
    return { ok: true, value: JSON.parse(last) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function runOfficialHarness(opts: Options, predictionsPath: string, instanceIds: string[], label: string, runRoot: string): void {
  if (!existsSync(opts.swebenchDir)) throw new Error(`SWE-bench dir not found: ${opts.swebenchDir}`)
  const runId = `${label}-${Date.now()}`
  const logPath = join(runRoot, `${label}-harness.log`)
  const args = [
    '-m', 'swebench.harness.run_evaluation',
    '--dataset_name', 'SWE-bench/SWE-bench_Lite',
    '--predictions_path', predictionsPath,
    '--max_workers', '1',
    '--run_id', runId,
    '--namespace', 'none',
    '--instance_ids', ...instanceIds,
  ]
  const result = spawnSync(opts.python, args, {
    cwd: opts.swebenchDir,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  })
  writeFileSync(logPath, `${result.stdout}${result.stderr}`)
  console.log(`\nOfficial harness exit: ${result.status}`)
  console.log(`  log: ${logPath}`)
  if (result.status !== 0) process.exitCode = 1
}

function summarizeRun(recordsPath: string, expected: number, label: string): Record<string, unknown> {
  return summarizeSwebenchRecords(readJsonl<SwebenchRunRecord>(recordsPath), expected, label)
}

function readScoreEligibleIds(recordsPath: string): string[] {
  return readJsonl<SwebenchRunRecord>(recordsPath)
    .filter(shouldWriteSwebenchPrediction)
    .map((row) => row.instance_id)
}

export function prepareRunOutputFiles(paths: SwebenchRunnerOutputPaths, resume: boolean): void {
  if (!resume) {
    writeFileSync(paths.predictions, '')
    writeFileSync(paths.records, '')
    writeFileSync(paths.infraFailures, '')
    writeFileSync(paths.providerFailures, '')
    return
  }
  ensureFile(paths.predictions)
  ensureFile(paths.records)
  ensureFile(paths.infraFailures)
  ensureFile(paths.providerFailures)
}

export function readCompletedIds(recordsPath: string): Set<string> {
  return new Set(
    readJsonl<Pick<SwebenchRunRecord, 'instance_id'>>(recordsPath)
      .map((row) => row.instance_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as T)
}

function appendJsonl(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { flag: 'a' })
}

function ensureFile(path: string): void {
  if (!existsSync(path)) writeFileSync(path, '')
}

function inferLabel(opts: Options): string {
  if (opts.packageSpec) return opts.packageSpec.replace(/[^A-Za-z0-9_.-]+/g, '-')
  const bin = opts.owlcodaBin ? opts.owlcodaBin.replace(/[^A-Za-z0-9_.-]+/g, '-') : 'local'
  return `dev-candidate-${bin}`.slice(0, 120)
}

export function isDirectScriptEntry(importMetaUrl = import.meta.url, argv1 = process.argv[1]): boolean {
  return Boolean(argv1) && importMetaUrl === pathToFileURL(argv1!).href
}

if (isDirectScriptEntry()) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err))
    process.exit(1)
  })
}
