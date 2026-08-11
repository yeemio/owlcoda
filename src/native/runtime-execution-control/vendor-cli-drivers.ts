import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { getOwlcodaDir } from '../../paths.js'
import { trustBuiltInVendorDriver } from './driver-trust.js'
import {
  CODEX_CLI_DRIVER_ID,
  CODEX_CLI_TASK_KIND,
  CURSOR_AGENT_DRIVER_ID,
  CURSOR_AGENT_TASK_KIND,
  KIMI_CLI_DRIVER_ID,
  KIMI_CLI_TASK_KIND,
  RuntimeExecutionControlError,
  type AgentRuntimeDriver,
  type AgentRuntimeDriverCapabilities,
  type AgentRuntimeDriverCollectedOutcome,
  type AgentRuntimeDriverResumeRequest,
  type AgentRuntimeDriverSession,
  type AgentRuntimeDriverStartRequest,
  type RuntimeDriverObservation,
  type RuntimeDriverProbeRequest,
  type RuntimeDriverProbeResult,
  type RuntimeExecutionArtifactFact,
  type RuntimeExecutionFailure,
  type RuntimeExecutionStatus,
  type VendorCliDriverName,
  type VendorCliRuntimeExecutionTask,
  type VendorCliRuntimeTaskKind,
} from './types.js'

export interface VendorCliDriverOptions {
  readonly executable?: string
  readonly artifactRoot?: string
  readonly timeoutMs?: number
  readonly killGraceMs?: number
  readonly maxStdoutBytes?: number
  readonly maxStderrBytes?: number
}

export interface VendorCliAvailability {
  readonly available: boolean
  readonly reason: string
  readonly executable?: string
  readonly cliVersion?: string
  readonly authentication: 'available' | 'missing' | 'unknown'
}

interface VendorDefinition {
  readonly name: VendorCliDriverName
  readonly id: string
  readonly taskKind: VendorCliRuntimeTaskKind
  readonly command: string
  readonly envCommand: string
  readonly versionArgs: readonly string[]
  readonly authArgs: readonly string[]
}

interface VendorSessionState {
  readonly session: AgentRuntimeDriverSession
  readonly abortController: AbortController
  completion: Promise<AgentRuntimeDriverCollectedOutcome>
  status: RuntimeDriverObservation['status']
}

interface CapturedProcessResult {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly childReaped: boolean
  readonly forcedReason?: 'timeout' | 'cancelled' | 'output_limit_exceeded'
  readonly spawnError?: string
}

interface ParsedVendorOutput {
  readonly text: string
  readonly vendorSessionId?: string
  readonly inputTokens: number
  readonly outputTokens: number
}

const DEFINITIONS: Record<VendorCliDriverName, VendorDefinition> = {
  kimi: {
    name: 'kimi',
    id: KIMI_CLI_DRIVER_ID,
    taskKind: KIMI_CLI_TASK_KIND,
    command: 'kimi',
    envCommand: 'OWLCODA_KIMI_CLI_PATH',
    versionArgs: ['--version'],
    authArgs: ['doctor'],
  },
  cursor: {
    name: 'cursor',
    id: CURSOR_AGENT_DRIVER_ID,
    taskKind: CURSOR_AGENT_TASK_KIND,
    command: 'cursor-agent',
    envCommand: 'OWLCODA_CURSOR_AGENT_PATH',
    versionArgs: ['--version'],
    authArgs: ['status'],
  },
  codex: {
    name: 'codex',
    id: CODEX_CLI_DRIVER_ID,
    taskKind: CODEX_CLI_TASK_KIND,
    command: 'codex',
    envCommand: 'OWLCODA_CODEX_CLI_PATH',
    versionArgs: ['--version'],
    authArgs: ['login', 'status'],
  },
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_KILL_GRACE_MS = 1_000
const DEFAULT_MAX_STDOUT_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_STDERR_BYTES = 512 * 1024
const PROBE_TIMEOUT_MS = 5_000

export class VendorCliAgentRuntimeDriver implements AgentRuntimeDriver {
  readonly id: string
  readonly family = 'vendor-native' as const
  readonly capabilities: AgentRuntimeDriverCapabilities
  readonly name: VendorCliDriverName
  private readonly definition: VendorDefinition
  private readonly options: VendorCliDriverOptions
  private readonly sessions = new Map<string, VendorSessionState>()

  constructor(name: VendorCliDriverName, options: VendorCliDriverOptions = {}) {
    this.definition = DEFINITIONS[name]
    this.name = name
    this.id = this.definition.id
    this.options = Object.freeze({ ...options })
    this.capabilities = Object.freeze({
      taskKinds: Object.freeze([this.definition.taskKind]),
      permissionModes: Object.freeze(['local_read_only'] as const),
      lifecycle: Object.freeze({
        probe: true,
        start: true,
        observe: true,
        interrupt: true,
        resume: false,
        collect: true,
      }),
      artifactCollection: true,
    })
    trustBuiltInVendorDriver(this)
  }

  async probe(request: RuntimeDriverProbeRequest): Promise<RuntimeDriverProbeResult> {
    const supported = request.taskKind === this.definition.taskKind
      && request.permissionMode === 'local_read_only'
    if (!supported) {
      return Object.freeze({
        driverId: this.id,
        driverFamily: this.family,
        status: 'unsupported',
        capabilities: this.capabilities,
        reason: `${this.id} does not support ${request.taskKind}/${request.permissionMode}`,
      })
    }
    const executable = await resolveVendorExecutable(this.definition, this.options.executable)
    return Object.freeze({
      driverId: this.id,
      driverFamily: this.family,
      status: executable ? 'available' : 'unsupported',
      capabilities: this.capabilities,
      ...(!executable ? { reason: `${this.definition.command} executable is unavailable` } : {}),
    })
  }

  async start(request: AgentRuntimeDriverStartRequest): Promise<AgentRuntimeDriverSession> {
    if (
      request.identity.driverId !== this.id
      || request.task.kind !== this.definition.taskKind
      || request.permissionMode !== 'local_read_only'
    ) {
      throw new RuntimeExecutionControlError(
        'RUNTIME_DRIVER_START_REJECTED',
        `${this.id} cannot start driver=${request.identity.driverId} task=${request.task.kind} mode=${request.permissionMode}`,
      )
    }
    const driverSessionId = `${this.id}:session:${request.identity.attemptId}`
    if (this.sessions.has(driverSessionId)) {
      throw new RuntimeExecutionControlError(
        'RUNTIME_DRIVER_SESSION_COLLISION',
        `${this.id} driver session already exists: ${driverSessionId}`,
      )
    }
    const session: AgentRuntimeDriverSession = Object.freeze({
      ...request.identity,
      driverSessionId,
    })
    const abortController = new AbortController()
    const unbindSignal = bindAbortSignal(request.signal, reason => abortController.abort(reason))
    const state: VendorSessionState = {
      session,
      abortController,
      status: 'running',
      completion: Promise.resolve(undefined as never),
    }
    state.completion = this.run(request, state).finally(unbindSignal)
    this.sessions.set(driverSessionId, state)
    return session
  }

  async observe(session: AgentRuntimeDriverSession): Promise<RuntimeDriverObservation> {
    const state = this.requireSession(session)
    return Object.freeze({ ...state.session, status: state.status })
  }

  async interrupt(session: AgentRuntimeDriverSession, reason: string): Promise<void> {
    const state = this.requireSession(session)
    if (isTerminal(state.status)) return
    state.status = 'interrupting'
    if (!state.abortController.signal.aborted) {
      state.abortController.abort(new RuntimeExecutionControlError('RUNTIME_EXECUTION_CANCELLED', reason))
    }
  }

  async resume(_request: AgentRuntimeDriverResumeRequest): Promise<AgentRuntimeDriverSession> {
    throw new RuntimeExecutionControlError(
      'RUNTIME_DRIVER_RESUME_UNSUPPORTED',
      `${this.id} does not advertise resume in this structured-output driver`,
    )
  }

  async collect(session: AgentRuntimeDriverSession): Promise<AgentRuntimeDriverCollectedOutcome> {
    return await this.requireSession(session).completion
  }

  private async run(
    request: AgentRuntimeDriverStartRequest,
    state: VendorSessionState,
  ): Promise<AgentRuntimeDriverCollectedOutcome> {
    const task = request.task as VendorCliRuntimeExecutionTask
    const artifactRoot = resolve(this.options.artifactRoot ?? join(getOwlcodaDir(), 'runtime-executions'))
    const executionDir = join(artifactRoot, safeSegment(request.identity.executionId))
    const stdoutRef = join(executionDir, 'stdout.log')
    const stderrRef = join(executionDir, 'stderr.log')
    const resultRef = join(executionDir, 'result.txt')
    const receiptRef = join(executionDir, 'receipt.json')
    const startedAt = new Date().toISOString()
    const startedAtMs = Date.now()
    let scratch = ''
    let scratchRemoved = false
    let executable = ''
    let cliVersion: string | undefined
    let processResult: CapturedProcessResult = {
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      durationMs: 0,
      childReaped: true,
    }
    let parsed: ParsedVendorOutput = { text: '', inputTokens: 0, outputTokens: 0 }
    let argv: string[] = []
    let failure: RuntimeExecutionFailure | undefined
    let status: RuntimeExecutionStatus = 'failed'

    try {
      validateDriverOptions(this.options)
      executable = await resolveVendorExecutable(this.definition, this.options.executable) ?? ''
      if (!executable) {
        failure = runtimeFailure('RUNTIME_VENDOR_EXECUTABLE_UNAVAILABLE', `${this.definition.command} executable is unavailable`)
      } else {
        cliVersion = await readCliVersion(this.definition, executable)
        await mkdir(executionDir, { recursive: true, mode: 0o700 })
        scratch = await mkdtemp(join(tmpdir(), `owlcoda-${this.name}-driver-`))
        const invocation = await buildInvocation(this.definition, task, scratch)
        argv = invocation.argv
        processResult = await runCapturedProcess({
          executable,
          argv,
          stdin: invocation.stdin,
          cwd: scratch,
          env: childEnvironment(this.name),
          timeoutMs: boundedInteger(this.options.timeoutMs, DEFAULT_TIMEOUT_MS),
          killGraceMs: boundedInteger(this.options.killGraceMs, DEFAULT_KILL_GRACE_MS),
          maxStdoutBytes: boundedInteger(this.options.maxStdoutBytes, DEFAULT_MAX_STDOUT_BYTES),
          maxStderrBytes: boundedInteger(this.options.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES),
          signal: state.abortController.signal,
        })
        parsed = await parseVendorOutput(this.name, processResult.stdout, invocation.lastMessagePath)
        failure = processFailure(processResult, parsed.text, state.abortController.signal)
      }
    } catch (error) {
      failure = runtimeFailure(
        'RUNTIME_VENDOR_DRIVER_FAILED',
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      if (scratch) {
        await rm(scratch, { recursive: true, force: true })
        scratchRemoved = true
      } else {
        scratchRemoved = true
      }
    }

    status = failure
      ? (failure.code === 'RUNTIME_EXECUTION_CANCELLED' ? 'cancelled' : 'failed')
      : 'completed'
    state.status = status
    await mkdir(executionDir, { recursive: true, mode: 0o700 })
    await Promise.all([
      writeFile(stdoutRef, processResult.stdout, { mode: 0o600 }),
      writeFile(stderrRef, processResult.stderr, { mode: 0o600 }),
      writeFile(resultRef, parsed.text, { mode: 0o600 }),
    ])
    const completedAt = new Date().toISOString()
    const cleanup = Object.freeze({
      childReaped: processResult.childReaped,
      scratchRemoved,
      orphanCount: processResult.childReaped ? 0 : 1,
    })
    const receipt = {
      schemaVersion: 'owlcoda-vendor-agent-receipt.v1',
      driverId: this.id,
      driverFamily: this.family,
      taskKind: this.definition.taskKind,
      status,
      executionId: request.identity.executionId,
      attemptId: request.identity.attemptId,
      driverSessionId: state.session.driverSessionId,
      ...(parsed.vendorSessionId ? { vendorSessionId: parsed.vendorSessionId } : {}),
      correlationId: request.correlationId,
      permissionMode: request.permissionMode,
      backendModel: task.model,
      executable,
      ...(cliVersion ? { cliVersion } : {}),
      argv: redactArgv(argv, task.prompt),
      promptSha256: digest(task.prompt),
      ...(task.outputSchema ? { schemaSha256: digest(stableJson(task.outputSchema)) } : {}),
      stdoutSha256: digest(processResult.stdout),
      stderrSha256: digest(processResult.stderr),
      resultSha256: digest(parsed.text),
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      startedAt,
      completedAt,
      durationMs: Math.max(processResult.durationMs, Date.now() - startedAtMs),
      cleanup,
      ...(failure ? { failure } : {}),
    }
    await writeFile(receiptRef, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })

    const artifactFacts: RuntimeExecutionArtifactFact[] = [
      { artifactType: 'vendor_stdout', ref: stdoutRef },
      { artifactType: 'vendor_stderr', ref: stderrRef },
      { artifactType: 'vendor_result', ref: resultRef },
      { artifactType: 'vendor_receipt', ref: receiptRef },
    ]
    return Object.freeze({
      status,
      driverSessionId: state.session.driverSessionId,
      correlationRefs: Object.freeze({
        correlationId: request.correlationId,
        receiptRef,
        artifactRefs: Object.freeze([stdoutRef, stderrRef, resultRef]),
      }),
      artifactFacts: Object.freeze(artifactFacts),
      vendorResult: Object.freeze({
        text: parsed.text,
        ...(task.model ? { backendModel: task.model } : {}),
        executable,
        ...(cliVersion ? { cliVersion } : {}),
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        durationMs: receipt.durationMs,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        stdoutRef,
        stderrRef,
        resultRef,
        receiptRef,
        cleanup,
      }),
      ...(failure ? { failure } : {}),
    })
  }

  private requireSession(session: AgentRuntimeDriverSession): VendorSessionState {
    const state = this.sessions.get(session.driverSessionId)
    if (
      !state
      || state.session.driverId !== session.driverId
      || state.session.executionId !== session.executionId
      || state.session.attemptId !== session.attemptId
    ) {
      throw new RuntimeExecutionControlError(
        'RUNTIME_DRIVER_SESSION_UNKNOWN',
        `${this.id} does not own driver session ${session.driverSessionId}`,
      )
    }
    return state
  }
}

export class KimiCliAgentRuntimeDriver extends VendorCliAgentRuntimeDriver {
  constructor(options: VendorCliDriverOptions = {}) { super('kimi', options) }
}

export class CursorAgentRuntimeDriver extends VendorCliAgentRuntimeDriver {
  constructor(options: VendorCliDriverOptions = {}) { super('cursor', options) }
}

export class CodexCliAgentRuntimeDriver extends VendorCliAgentRuntimeDriver {
  constructor(options: VendorCliDriverOptions = {}) { super('codex', options) }
}

export async function inspectVendorCliAvailability(
  name: VendorCliDriverName,
  options: VendorCliDriverOptions = {},
): Promise<VendorCliAvailability> {
  const definition = DEFINITIONS[name]
  try {
    validateDriverOptions(options)
    const executable = await resolveVendorExecutable(definition, options.executable)
    if (!executable) {
      return { available: false, reason: 'executable_unavailable', authentication: 'missing' }
    }
    const cliVersion = await readCliVersion(definition, executable)
    const auth = await runShortCommand(executable, definition.authArgs, childEnvironment(name))
    if (auth.exitCode !== 0) {
      return {
        available: false,
        reason: 'authentication_unavailable',
        executable,
        ...(cliVersion ? { cliVersion } : {}),
        authentication: 'missing',
      }
    }
    return {
      available: true,
      reason: name === 'kimi' ? 'transport_available_auth_unverified' : 'available',
      executable,
      ...(cliVersion ? { cliVersion } : {}),
      authentication: name === 'kimi' ? 'unknown' : 'available',
    }
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
      authentication: 'unknown',
    }
  }
}

function validateDriverOptions(options: VendorCliDriverOptions): void {
  for (const [name, value] of Object.entries({
    timeoutMs: options.timeoutMs,
    killGraceMs: options.killGraceMs,
    maxStdoutBytes: options.maxStdoutBytes,
    maxStderrBytes: options.maxStderrBytes,
  })) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new RuntimeExecutionControlError('RUNTIME_VENDOR_CONFIG_INVALID', `${name} must be an integer >= 1`)
    }
  }
}

async function resolveVendorExecutable(
  definition: VendorDefinition,
  configured: string | undefined,
): Promise<string | null> {
  const requested = configured?.trim() || process.env[definition.envCommand]?.trim() || definition.command
  const candidates = requested.includes('/')
    ? [isAbsolute(requested) ? requested : resolve(requested)]
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, requested))
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue through the exact PATH candidates without invoking a shell.
    }
  }
  return null
}

async function readCliVersion(definition: VendorDefinition, executable: string): Promise<string | undefined> {
  const result = await runShortCommand(executable, definition.versionArgs, childEnvironment(definition.name))
  const value = result.stdout.trim() || result.stderr.trim()
  return result.exitCode === 0 && value ? value.split(/\r?\n/u)[0]?.trim() : undefined
}

async function runShortCommand(
  executable: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const result = await runCapturedProcess({
    executable,
    argv: [...argv],
    stdin: '',
    cwd: tmpdir(),
    env,
    timeoutMs: PROBE_TIMEOUT_MS,
    killGraceMs: 250,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024,
  })
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
}

async function buildInvocation(
  definition: VendorDefinition,
  task: VendorCliRuntimeExecutionTask,
  scratch: string,
): Promise<{ argv: string[]; stdin: string; lastMessagePath?: string }> {
  const modelArgs = task.model?.trim() ? ['--model', task.model.trim()] : []
  if (definition.name === 'kimi') {
    const skillsDir = join(scratch, 'skills')
    const agentFile = join(scratch, 'structured-output-agent.md')
    await mkdir(skillsDir, { mode: 0o700 })
    await writeFile(agentFile, [
      '---',
      'name: owlcoda-structured-output',
      'description: Bounded structured-output generation without tools',
      'tools: []',
      'subagents: []',
      '---',
      'Answer only from the supplied prompt. You have no tools and must return the requested JSON object.',
      '',
    ].join('\n'), { mode: 0o600 })
    return {
      argv: [
        '-p', task.prompt,
        ...modelArgs,
        '--output-format', 'stream-json',
        '--skills-dir', skillsDir,
        '--agent-file', agentFile,
      ],
      stdin: '',
    }
  }
  if (definition.name === 'cursor') {
    return {
      argv: [
        '-p',
        '--trust',
        '--mode', 'ask',
        '--sandbox', 'enabled',
        ...modelArgs,
        '--output-format', 'stream-json',
        '--workspace', scratch,
        task.prompt,
      ],
      stdin: '',
    }
  }
  const schemaPath = join(scratch, 'output-schema.json')
  const lastMessagePath = join(scratch, 'output-last-message.json')
  const schema = codexTransportSchema(task.outputSchema ?? { type: 'object' })
  await writeFile(schemaPath, `${JSON.stringify(schema)}\n`, { mode: 0o600 })
  await writeFile(lastMessagePath, '', { mode: 0o600 })
  return {
    argv: [
      'exec',
      '--ephemeral',
      '--ignore-rules',
      '--ignore-user-config',
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      ...modelArgs,
      '--json',
      '--output-schema', schemaPath,
      '--output-last-message', lastMessagePath,
      '-',
    ],
    stdin: task.prompt,
    lastMessagePath,
  }
}

function codexTransportSchema(schema: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === 'string')
      : [],
  )
  const properties = objectValue(schema.properties)
  const strictProperties = properties
    ? Object.fromEntries(
        Object.entries(properties)
          .filter(([name]) => required.has(name))
          .map(([name, value]) => [name, codexSchemaValue(value)]),
      )
    : {}
  const mapped = Object.fromEntries(
    Object.entries(schema)
      .filter(([name]) => !['properties', 'required', 'additionalProperties'].includes(name))
      .map(([name, value]) => [name, codexSchemaValue(value)]),
  )
  return {
    ...mapped,
    type: schema.type ?? 'object',
    properties: strictProperties,
    required: Object.keys(strictProperties),
    additionalProperties: false,
  }
}

function codexSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(codexSchemaValue)
  const record = objectValue(value)
  if (!record) return value
  if (record.type === 'object' || objectValue(record.properties)) return codexTransportSchema(record)
  const mapped = Object.fromEntries(
    Object.entries(record).map(([name, child]) => [name, codexSchemaValue(child)]),
  )
  const inferredType = record.type === undefined ? inferJsonSchemaType(record) : undefined
  return inferredType ? { ...mapped, type: inferredType } : mapped
}

function inferJsonSchemaType(schema: Record<string, unknown>): string | undefined {
  if ('const' in schema) return jsonValueType(schema.const)
  if (!Array.isArray(schema.enum) || schema.enum.length === 0) return undefined
  const types = new Set(schema.enum.map(jsonValueType))
  return types.size === 1 ? [...types][0] : undefined
}

function jsonValueType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

async function parseVendorOutput(
  name: VendorCliDriverName,
  stdout: string,
  lastMessagePath: string | undefined,
): Promise<ParsedVendorOutput> {
  if (name === 'codex') {
    const text = lastMessagePath ? await readFile(lastMessagePath, 'utf8').catch(() => '') : ''
    let vendorSessionId: string | undefined
    let inputTokens = 0
    let outputTokens = 0
    for (const event of jsonLines(stdout)) {
      if (event.type === 'thread.started' && stringValue(event.thread_id)) vendorSessionId = stringValue(event.thread_id)
      if (event.type === 'turn.completed') {
        const usage = objectValue(event.usage)
        if (numberValue(usage?.input_tokens) !== undefined) inputTokens = numberValue(usage?.input_tokens)!
        if (numberValue(usage?.output_tokens) !== undefined) outputTokens = numberValue(usage?.output_tokens)!
      }
    }
    return { text: text.trim(), ...(vendorSessionId ? { vendorSessionId } : {}), inputTokens, outputTokens }
  }
  if (name === 'kimi') {
    let text = ''
    let vendorSessionId: string | undefined
    for (const event of jsonLines(stdout)) {
      const message = objectValue(event.message)
      const session = objectValue(event.session)
      vendorSessionId = stringValue(event.session_id)
        ?? stringValue(event.sessionId)
        ?? stringValue(message?.session_id)
        ?? stringValue(session?.id)
        ?? vendorSessionId
      if (message?.role !== 'assistant' && event.role !== 'assistant') continue
      const content = message?.content ?? event.content
      const candidate = contentText(content)
      if (candidate) text = candidate
    }
    return { text: text.trim(), ...(vendorSessionId ? { vendorSessionId } : {}), inputTokens: 0, outputTokens: 0 }
  }
  let text = ''
  let streamed = ''
  let vendorSessionId: string | undefined
  for (const event of jsonLines(stdout)) {
    vendorSessionId = stringValue(event.session_id) ?? vendorSessionId
    if (event.type === 'result' && stringValue(event.result)) text = stringValue(event.result)!
    if (event.type !== 'assistant') continue
    const candidate = contentText(objectValue(event.message)?.content ?? event.content ?? event.result)
    if (!candidate) continue
    if ('timestamp_ms' in event && !('model_call_id' in event)) streamed += candidate
    else if (!streamed) text = candidate
  }
  if (streamed.trim()) text = streamed.trim()
  return { text: text.trim(), ...(vendorSessionId ? { vendorSessionId } : {}), inputTokens: 0, outputTokens: 0 }
}

function processFailure(
  result: CapturedProcessResult,
  text: string,
  signal: AbortSignal,
): RuntimeExecutionFailure | undefined {
  if (result.forcedReason === 'cancelled' || signal.aborted) {
    return runtimeFailure(
      'RUNTIME_EXECUTION_CANCELLED',
      signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'runtime_execution_cancelled'),
    )
  }
  if (result.forcedReason === 'timeout') {
    return runtimeFailure('RUNTIME_VENDOR_TIMEOUT', 'Vendor CLI execution reached its timeout')
  }
  if (result.forcedReason === 'output_limit_exceeded') {
    return runtimeFailure('RUNTIME_VENDOR_OUTPUT_LIMIT_EXCEEDED', 'Vendor CLI output exceeded its configured byte limit')
  }
  if (result.spawnError || result.exitCode !== 0 || result.signal !== null) {
    return runtimeFailure('RUNTIME_VENDOR_PROCESS_FAILED', 'Vendor CLI process did not exit successfully')
  }
  if (!text.trim()) {
    return runtimeFailure('RUNTIME_VENDOR_OUTPUT_MALFORMED', 'Vendor CLI did not produce a machine-readable assistant result')
  }
  return undefined
}

function runtimeFailure(code: string, message: string): RuntimeExecutionFailure {
  return Object.freeze({ code, message })
}

function runCapturedProcess(args: {
  executable: string
  argv: string[]
  stdin: string
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  killGraceMs: number
  maxStdoutBytes: number
  maxStderrBytes: number
  signal?: AbortSignal
}): Promise<CapturedProcessResult> {
  const startedAt = Date.now()
  return new Promise(resolvePromise => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(args.executable, args.argv, {
        cwd: args.cwd,
        env: args.env,
        detached: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolvePromise({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: Date.now() - startedAt,
        childReaped: true,
        spawnError: error instanceof Error ? error.message : String(error),
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let forcedReason: CapturedProcessResult['forcedReason']
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined

    const finish = (exitCode: number | null, signal: string | null, spawnError?: string) => {
      if (settled) return
      settled = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)
      if (abortListener && args.signal) args.signal.removeEventListener('abort', abortListener)
      resolvePromise({
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        childReaped: true,
        ...(forcedReason ? { forcedReason } : {}),
        ...(spawnError ? { spawnError } : {}),
      })
    }

    const terminate = (reason: NonNullable<CapturedProcessResult['forcedReason']>) => {
      if (settled || forcedReason) return
      forcedReason = reason
      signalProcess(child, 'SIGTERM')
      killTimer = setTimeout(() => {
        if (!settled) signalProcess(child, 'SIGKILL')
      }, args.killGraceMs)
      killTimer.unref()
    }

    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      if (settled) return
      if (target === 'stdout') {
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > args.maxStdoutBytes) {
          terminate('output_limit_exceeded')
          return
        }
        stdout += chunk.toString('utf8')
      } else {
        stderrBytes += chunk.byteLength
        if (stderrBytes > args.maxStderrBytes) {
          terminate('output_limit_exceeded')
          return
        }
        stderr += chunk.toString('utf8')
      }
    }

    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk))
    child.stdin.on('error', () => undefined)
    child.once('error', error => finish(null, null, error.message))
    child.once('close', (exitCode, signal) => finish(exitCode, signal))
    abortListener = () => terminate('cancelled')
    if (args.signal) {
      if (args.signal.aborted) abortListener()
      else args.signal.addEventListener('abort', abortListener, { once: true })
    }
    timeoutTimer = setTimeout(() => terminate('timeout'), args.timeoutMs)
    timeoutTimer.unref()
    child.stdin.end(args.stdin)
  })
}

function childEnvironment(name: VendorCliDriverName): NodeJS.ProcessEnv {
  const common = [
    'HOME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR',
    'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
  ]
  const vendor = name === 'kimi'
    ? ['KIMI_API_KEY']
    : name === 'cursor'
      ? ['CURSOR_API_KEY', 'CURSOR_API_ENDPOINT']
      : ['OPENAI_API_KEY', 'CODEX_HOME']
  const environment: NodeJS.ProcessEnv = {}
  for (const key of [...common, ...vendor]) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }
  return environment
}

function signalProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      process.kill(child.pid, signal)
    } catch {
      // The process already exited.
    }
  }
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = []
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as unknown
      const object = objectValue(value)
      if (object) events.push(object)
    } catch {
      // Non-JSON diagnostics never become assistant output.
    }
  }
  return events
}

function contentText(content: unknown): string | undefined {
  if (typeof content === 'string' && content.trim()) return content.trim()
  if (!Array.isArray(content)) return undefined
  const text = content
    .map(item => objectValue(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map(item => stringValue(item.text) ?? '')
    .join('')
    .trim()
  return text || undefined
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined
}

function boundedInteger(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : value
}

function redactArgv(argv: readonly string[], prompt: string): string[] {
  const promptDigest = digest(prompt)
  return argv.map(value => value === prompt ? `<prompt:${promptDigest}>` : value)
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'runtime-execution'
}

function isTerminal(status: RuntimeDriverObservation['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function bindAbortSignal(signal: AbortSignal | undefined, abort: (reason: unknown) => void): () => void {
  if (!signal) return () => undefined
  const listener = () => abort(signal.reason)
  if (signal.aborted) listener()
  else signal.addEventListener('abort', listener, { once: true })
  return () => signal.removeEventListener('abort', listener)
}
