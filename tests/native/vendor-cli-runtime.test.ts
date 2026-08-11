import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalizeModel, resolveModelRoute, type OwlCodaConfig } from '../../src/config.js'
import { startServer } from '../../src/server.js'
import {
  CODEX_CLI_DRIVER_ID,
  CODEX_CLI_TASK_KIND,
  CURSOR_AGENT_DRIVER_ID,
  CURSOR_AGENT_TASK_KIND,
  KIMI_CLI_DRIVER_ID,
  KIMI_CLI_TASK_KIND,
  createDefaultRuntimeExecutionController,
} from '../../src/native/runtime-execution-control/index.js'

const OUTPUT_SCHEMA = {
  type: 'object' as const,
  required: ['artifact', 'summary', 'confidence'],
  additionalProperties: false,
  properties: {
    artifact: { type: 'string' as const, const: 'evidence-digest.v1' },
    summary: { type: 'string' as const },
    confidence: { type: 'number' as const },
  },
}

const FAKE_VENDOR_CLI = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
if (argv.includes('--version') || argv[0] === '--version') {
  process.stdout.write('fake-vendor-cli 1.0.0\\n')
  process.exit(0)
}
if (argv[0] === 'status' || (argv[0] === 'login' && argv[1] === 'status')) {
  process.stdout.write('Logged in\\n')
  process.exit(0)
}
if (argv[0] === 'doctor') {
  process.stdout.write('All checked config files are valid.\\n')
  process.exit(0)
}
if (process.env.SHOULD_NOT_REACH_VENDOR === 'secret-value') {
  process.stderr.write('unsafe-environment-leak')
  process.exit(91)
}

const valueAfter = (flag) => argv[argv.indexOf(flag) + 1]
const kind = argv[0] === 'exec'
  ? 'codex'
  : argv.includes('--skills-dir')
    ? 'kimi'
    : 'cursor'
let prompt = ''
if (kind === 'codex') prompt = readFileSync(0, 'utf8')
else if (kind === 'kimi') {
  if (argv.includes('--plan')) {
    process.stderr.write('kimi-prompt-plan-conflict')
    process.exit(24)
  }
  const agentFile = valueAfter('--agent-file')
  if (!agentFile || !readFileSync(agentFile, 'utf8').includes('tools: []')) {
    process.stderr.write('kimi-tools-not-disabled')
    process.exit(25)
  }
  prompt = valueAfter('-p') || valueAfter('--prompt') || ''
}
else prompt = argv.at(-1) || ''

if (kind === 'codex') {
  const schema = JSON.parse(readFileSync(valueAfter('--output-schema'), 'utf8'))
  const propertyNames = Object.keys(schema.properties || {}).sort()
  const requiredNames = [...(schema.required || [])].sort()
  const missingTypes = propertyNames.filter(name => !schema.properties[name]?.type)
  if (
    schema.additionalProperties !== false
    || JSON.stringify(propertyNames) !== JSON.stringify(requiredNames)
    || missingTypes.length > 0
  ) {
    process.stderr.write('codex-schema-not-strict')
    process.exit(26)
  }
}

if (prompt.includes('IGNORE_TERM')) process.on('SIGTERM', () => {})
if (prompt.includes('HANG')) {
  setInterval(() => {}, 1_000)
} else if (prompt.includes('OVERFLOW')) {
  process.stdout.write('x'.repeat(32_000))
  setInterval(() => {}, 1_000)
} else if (prompt.includes('NONZERO')) {
  process.stderr.write('synthetic-provider-failure')
  process.exit(23)
} else if (prompt.includes('MALFORMED')) {
  process.stdout.write('not-json-output\\n')
} else {
  const output = JSON.stringify({ artifact: 'evidence-digest.v1', summary: kind, confidence: 0.91 })
  if (kind === 'codex') {
    writeFileSync(valueAfter('--output-last-message'), output)
    process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-001' }) + '\\n')
    process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } }) + '\\n')
  } else if (kind === 'kimi') {
    process.stdout.write(JSON.stringify({ session_id: 'kimi-session-001', message: { role: 'assistant', content: output } }) + '\\n')
  } else {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cursor-session-001', model: 'cursor-test' }) + '\\n')
    process.stdout.write(JSON.stringify({ type: 'result', result: output }) + '\\n')
  }
}
`

type VendorCase = {
  name: 'kimi' | 'cursor' | 'codex'
  driverId: string
  taskKind: typeof KIMI_CLI_TASK_KIND | typeof CURSOR_AGENT_TASK_KIND | typeof CODEX_CLI_TASK_KIND
  model: string
  executorKind: 'kimi-cli' | 'cursor-agent' | 'codex-cli'
}

const CASES: VendorCase[] = [
  { name: 'kimi', driverId: KIMI_CLI_DRIVER_ID, taskKind: KIMI_CLI_TASK_KIND, model: 'kimi-code/k3', executorKind: 'kimi-cli' },
  { name: 'cursor', driverId: CURSOR_AGENT_DRIVER_ID, taskKind: CURSOR_AGENT_TASK_KIND, model: 'auto', executorKind: 'cursor-agent' },
  { name: 'codex', driverId: CODEX_CLI_DRIVER_ID, taskKind: CODEX_CLI_TASK_KIND, model: 'gpt-5.6-sol', executorKind: 'codex-cli' },
]

describe('vendor CLI drivers behind Runtime Execution Control', () => {
  let root = ''
  let fakeCli = ''
  let app: Server | undefined
  let appUrl = ''
  const originalOwlCodaHome = process.env.OWLCODA_HOME
  const originalLeakMarker = process.env.SHOULD_NOT_REACH_VENDOR

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'owlcoda-vendor-cli-test-'))
    fakeCli = join(root, 'fake-vendor-cli.mjs')
    await writeFile(fakeCli, FAKE_VENDOR_CLI, { mode: 0o700 })
    await chmod(fakeCli, 0o700)
    process.env.OWLCODA_HOME = join(root, 'owlcoda-home')
    process.env.SHOULD_NOT_REACH_VENDOR = 'secret-value'
  })

  afterAll(async () => {
    if (app) await new Promise<void>(resolve => app!.close(() => resolve()))
    if (originalOwlCodaHome === undefined) delete process.env.OWLCODA_HOME
    else process.env.OWLCODA_HOME = originalOwlCodaHome
    if (originalLeakMarker === undefined) delete process.env.SHOULD_NOT_REACH_VENDOR
    else process.env.SHOULD_NOT_REACH_VENDOR = originalLeakMarker
    if (root) await rm(root, { recursive: true, force: true })
  })

  it.each(CASES)('registers and executes the real $name driver with correlated durable evidence', async (item) => {
    let sequence = 0
    const controller = createDefaultRuntimeExecutionController({
      identityFactory: () => {
        sequence += 1
        return {
          executionId: `runtime-execution:${item.name}:${sequence}`,
          attemptId: `runtime-attempt:${item.name}:${sequence}`,
        }
      },
      vendorCli: {
        [item.name]: {
          executable: fakeCli,
          artifactRoot: join(root, 'runtime-artifacts'),
          timeoutMs: 2_000,
          killGraceMs: 30,
          maxStdoutBytes: 64_000,
          maxStderrBytes: 16_000,
        },
      },
    })
    const reservation = controller.reserve({
      taskKind: item.taskKind,
      correlationId: `structured-output-${item.name}`,
      workspaceRoot: root,
      permissionMode: 'local_read_only',
    })
    const result = await controller.execute(reservation, {
      kind: item.taskKind,
      prompt: `Return the ${item.name} fixture JSON`,
      model: item.model,
      outputSchema: OUTPUT_SCHEMA,
    })

    expect(result).toMatchObject({
      status: 'completed',
      driverFamily: 'vendor-native',
      driverId: item.driverId,
      executionId: reservation.executionId,
      attemptId: reservation.attemptId,
      correlationRefs: {
        correlationId: `structured-output-${item.name}`,
        receiptRef: expect.any(String),
      },
      vendorResult: {
        text: JSON.stringify({ artifact: 'evidence-digest.v1', summary: item.name, confidence: 0.91 }),
        backendModel: item.model,
        cleanup: { childReaped: true, scratchRemoved: true, orphanCount: 0 },
      },
    })
    expect(new Set([result.executionId, result.attemptId, result.driverSessionId]).size).toBe(3)
    expect(result.artifactFacts.map(fact => fact.artifactType)).toEqual(expect.arrayContaining([
      'vendor_stdout',
      'vendor_stderr',
      'vendor_result',
      'vendor_receipt',
    ]))
    const receipt = JSON.parse(await readFile(result.correlationRefs.receiptRef!, 'utf8')) as Record<string, unknown>
    expect(receipt).toMatchObject({
      schemaVersion: 'owlcoda-vendor-agent-receipt.v1',
      driverId: item.driverId,
      taskKind: item.taskKind,
      status: 'completed',
      executionId: reservation.executionId,
      attemptId: reservation.attemptId,
      driverSessionId: result.driverSessionId,
      promptSha256: expect.stringMatching(/^sha256:/),
    })
    expect(JSON.stringify(receipt)).not.toContain('Return the')
    expect(JSON.stringify(result)).not.toContain('secret-value')
  })

  it('kills a stubborn vendor process on central interrupt and preserves the same identities', async () => {
    const controller = createDefaultRuntimeExecutionController({
      identityFactory: () => ({ executionId: 'runtime-execution:cancel', attemptId: 'runtime-attempt:cancel' }),
      vendorCli: {
        codex: {
          executable: fakeCli,
          artifactRoot: join(root, 'runtime-artifacts'),
          timeoutMs: 5_000,
          killGraceMs: 25,
        },
      },
    })
    const reservation = controller.reserve({
      taskKind: CODEX_CLI_TASK_KIND,
      correlationId: 'structured-output-cancel',
      workspaceRoot: root,
      permissionMode: 'local_read_only',
    })
    const pending = controller.execute(reservation, {
      kind: CODEX_CLI_TASK_KIND,
      prompt: 'HANG IGNORE_TERM',
      model: 'gpt-5.6-sol',
      outputSchema: OUTPUT_SCHEMA,
    })
    await new Promise(resolve => setTimeout(resolve, 60))
    const interrupt = await controller.interrupt(reservation, 'test_cancel')
    const result = await pending

    expect(interrupt).toMatchObject({ accepted: true, executionId: reservation.executionId })
    expect(result).toMatchObject({
      status: 'cancelled',
      executionId: reservation.executionId,
      attemptId: reservation.attemptId,
      failure: { code: 'RUNTIME_EXECUTION_CANCELLED' },
      vendorResult: { cleanup: { childReaped: true, scratchRemoved: true, orphanCount: 0 } },
    })
  })

  it('fails closed and reaps the child when bounded output is exceeded', async () => {
    const controller = createDefaultRuntimeExecutionController({
      identityFactory: () => ({ executionId: 'runtime-execution:overflow', attemptId: 'runtime-attempt:overflow' }),
      vendorCli: {
        kimi: {
          executable: fakeCli,
          artifactRoot: join(root, 'runtime-artifacts'),
          timeoutMs: 2_000,
          killGraceMs: 25,
          maxStdoutBytes: 128,
        },
      },
    })
    const reservation = controller.reserve({
      taskKind: KIMI_CLI_TASK_KIND,
      correlationId: 'structured-output-overflow',
      workspaceRoot: root,
      permissionMode: 'local_read_only',
    })
    const result = await controller.execute(reservation, {
      kind: KIMI_CLI_TASK_KIND,
      prompt: 'OVERFLOW',
      model: 'kimi-code/k3',
      outputSchema: OUTPUT_SCHEMA,
    })
    expect(result).toMatchObject({
      status: 'failed',
      failure: { code: 'RUNTIME_VENDOR_OUTPUT_LIMIT_EXCEEDED' },
      vendorResult: { cleanup: { childReaped: true, scratchRemoved: true, orphanCount: 0 } },
    })
  })

  it('leaves exact failure receipts for timeout, non-zero exit, and malformed output', async () => {
    const failures = [
      { name: 'timeout', prompt: 'HANG', timeoutMs: 40, code: 'RUNTIME_VENDOR_TIMEOUT' },
      { name: 'nonzero', prompt: 'NONZERO', timeoutMs: 2_000, code: 'RUNTIME_VENDOR_PROCESS_FAILED' },
      { name: 'malformed', prompt: 'MALFORMED', timeoutMs: 2_000, code: 'RUNTIME_VENDOR_OUTPUT_MALFORMED' },
    ]
    for (const failure of failures) {
      const controller = createDefaultRuntimeExecutionController({
        identityFactory: () => ({
          executionId: `runtime-execution:${failure.name}`,
          attemptId: `runtime-attempt:${failure.name}`,
        }),
        vendorCli: {
          kimi: {
            executable: fakeCli,
            artifactRoot: join(root, 'runtime-artifacts'),
            timeoutMs: failure.timeoutMs,
            killGraceMs: 25,
          },
        },
      })
      const reservation = controller.reserve({
        taskKind: KIMI_CLI_TASK_KIND,
        correlationId: `structured-output-${failure.name}`,
        workspaceRoot: root,
        permissionMode: 'local_read_only',
      })
      const result = await controller.execute(reservation, {
        kind: KIMI_CLI_TASK_KIND,
        prompt: failure.prompt,
        model: 'kimi-code/k3',
        outputSchema: OUTPUT_SCHEMA,
      })
      expect(result).toMatchObject({
        status: 'failed',
        failure: { code: failure.code },
        vendorResult: { cleanup: { childReaped: true, scratchRemoved: true, orphanCount: 0 } },
      })
      const receipt = JSON.parse(await readFile(result.correlationRefs.receiptRef!, 'utf8'))
      expect(receipt).toMatchObject({ status: 'failed', failure: { code: failure.code } })
    }
  })

  it('normalizes three typed CLI model routes without falling through to HTTP', () => {
    const config = makeConfig(CASES.map(item => normalizeModel({
      id: `${item.name}-driver-test`,
      label: `${item.name} driver test`,
      aliases: [`${item.name}-driver-test`],
      backendModel: item.model,
      provider: item.executorKind,
      executor: { kind: item.executorKind, executable: fakeCli },
      tier: 'custom',
    })))

    for (const item of CASES) {
      const model = config.models.find(candidate => candidate.id === `${item.name}-driver-test`)!
      expect(model.executor?.kind).toBe(item.executorKind)
      expect(model.supportsStructuredOutput).toBe(true)
      expect(model.supportsStreaming).toBe(false)
      expect(resolveModelRoute(config, model.id)).toMatchObject({
        backendModel: item.model,
        executorKind: item.executorKind,
        endpointUrl: '',
        requestedModelConfigured: true,
      })
    }
  })

  it('serves all three configured CLI drivers through /v1/models and /v1/structured-output', async () => {
    const config = makeConfig(CASES.map((item, index) => normalizeModel({
      id: `${item.name}-driver-http`,
      label: `${item.name} CLI driver`,
      aliases: [`${item.name}-driver-http`],
      backendModel: item.model,
      provider: item.executorKind,
      executor: {
        kind: item.executorKind,
        executable: fakeCli,
        timeoutMs: 2_000,
        killGraceMs: 30,
      },
      tier: 'custom',
      default: index === 0,
    })))
    app = startServer(config)
    await new Promise<void>(resolve => app!.once('listening', resolve))
    const address = app.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind')
    appUrl = `http://127.0.0.1:${address.port}`

    const modelsResponse = await fetch(`${appUrl}/v1/models`)
    const modelsBody = await modelsResponse.json() as { data: Array<Record<string, unknown>> }
    expect(modelsBody.data).toHaveLength(3)
    for (const item of CASES) {
      expect(modelsBody.data.find(model => model.id === `${item.name}-driver-http`)).toMatchObject({
        availability: 'available',
        executor: item.executorKind,
        driver_id: item.driverId,
        cli_version: 'fake-vendor-cli 1.0.0',
      })

      const response = await fetch(`${appUrl}/v1/structured-output`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: `${item.name}-driver-http`,
          preset: 'evidence-digest.v1',
          user: `Return the ${item.name} HTTP fixture`,
        }),
      })
      const body = await response.json() as Record<string, any>
      expect(response.status).toBe(200)
      expect(body).toMatchObject({
        ok: true,
        schemaValid: true,
        runtimeExecution: {
          status: 'completed',
          driverId: item.driverId,
          driverFamily: 'vendor-native',
          vendorResult: { backendModel: item.model },
        },
      })
      expect(body.attempts[0].runtimeExecution.driverId).toBe(item.driverId)
    }
  })
})

function makeConfig(models: OwlCodaConfig['models']): OwlCodaConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    routerUrl: 'http://127.0.0.1:9',
    localRuntimeProtocol: 'auto',
    routerTimeoutMs: 500,
    models,
    responseModelStyle: 'platform',
    logLevel: 'error',
    catalogLoaded: false,
    middleware: {},
    modelMap: {},
    defaultModel: models[0]?.backendModel ?? '',
    reverseMapInResponse: true,
  }
}
