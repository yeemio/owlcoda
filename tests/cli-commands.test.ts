/**
 * CLI command integration tests — doctor, config, init, version, help, logs.
 * These spawn the real CLI and verify output, no mocks.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = join(import.meta.dirname, '..')
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli.ts')
const CLI_SUBPROCESS_TEST_TIMEOUT_MS = 20000
const CLI_COMMANDS_TEST_TIMEOUT_MS = 60000

const runtimeDirs = new Set<string>()

function makeRuntimeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'owlcoda-cmd-'))
  runtimeDirs.add(dir)
  return dir
}

async function runCli(
  args: string[],
  runtimeDir: string,
  options: {
    timeoutMs?: number
    env?: NodeJS.ProcessEnv
  } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI_ENTRY, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...options.env,
        HOME: join(runtimeDir, 'home'),
        OWLCODA_HOME: runtimeDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`CLI command timed out: ${args.join(' ')}`))
    }, options.timeoutMs ?? CLI_SUBPROCESS_TEST_TIMEOUT_MS)

    child.on('error', err => { clearTimeout(timer); reject(err) })
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return !isProcessAlive(pid)
}

afterEach(() => {
  for (const dir of runtimeDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  runtimeDirs.clear()
})

describe('CLI commands integration', { timeout: CLI_COMMANDS_TEST_TIMEOUT_MS }, () => {
  it('--version shows version and mode', async () => {
    const runtimeDir = makeRuntimeDir()
    const result = await runCli(['--version'], runtimeDir)
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(/owlcoda \d+\.\d+\.\d+/)
    expect(result.stderr).toContain('native mode')
    expect(result.stderr).toContain('node')
  })

  it('--help shows usage info', async () => {
    const runtimeDir = makeRuntimeDir()
    const result = await runCli(['--help'], runtimeDir)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('Usage:')
    expect(result.stderr).toContain('owlcoda doctor')
    expect(result.stderr).toContain('owlcoda init')
    expect(result.stderr).toContain('owlcoda config')
    expect(result.stderr).toContain('owlcoda logs')
    expect(result.stderr).toContain('--daemon-only')
  })

  it('app-server smoke keeps public health minimal and verifies the authenticated structured contract', async () => {
    const runtimeDir = makeRuntimeDir()
    const managedToken = 'cli-smoke-managed-token'
    const result = await runCli([
      'app-server',
      '--app-server-host',
      '127.0.0.1',
      '--app-server-port',
      '0',
      '--app-server-smoke',
    ], runtimeDir, {
      env: { OWLCODA_APP_SERVER_TOKEN: managedToken },
    })

    expect(result.code).toBe(0)
    const smoke = JSON.parse(result.stdout) as {
      ok: boolean
      baseUrl: string
      health: { status: string }
      compatibility: string
      protocol: {
        methods: Array<{ method: string }>
      }
    }
    expect(smoke.ok).toBe(true)
    expect(smoke.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(smoke.health).toEqual({ status: 'ok' })
    expect(smoke.compatibility).toBe('compatible')
    const methodNames = smoke.protocol.methods.map(method => method.method)
    expect(methodNames).toContain('runtimeTranscript/read')
    expect(methodNames).toContain('interaction/list')
    expect(methodNames).toContain('runtimeRail/read')
    expect(result.stdout).not.toContain(managedToken)
    expect(result.stderr).not.toContain(managedToken)
  })

  it('app-server smoke loads OwlCoda config for authenticated runtime diagnostics', async () => {
    const runtimeDir = makeRuntimeDir()
    writeFileSync(join(runtimeDir, 'config.json'), JSON.stringify({
      port: 8125,
      host: '127.0.0.1',
      routerUrl: 'http://127.0.0.1:8066',
      models: [{
        id: 'desktop-model',
        label: 'Desktop Model',
        backendModel: 'backend-model',
        aliases: ['desktop'],
        provider: 'test',
        tier: 'local',
        default: true,
      }],
    }), 'utf8')

    const result = await runCli([
      'app-server',
      '--app-server-host',
      '127.0.0.1',
      '--app-server-port',
      '0',
      '--app-server-smoke',
    ], runtimeDir)

    expect(result.code).toBe(0)
    const smoke = JSON.parse(result.stdout) as {
      ok: boolean
      health: { status: string }
      diagnostic: {
        subsystems: {
          appServerLoop: {
            status: string
            model?: string
            apiBaseUrl?: string
          }
        }
      }
    }
    expect(smoke.ok).toBe(true)
    expect(smoke.health).toEqual({ status: 'ok' })
    expect(smoke.diagnostic.subsystems.appServerLoop).toMatchObject({
      status: 'ok',
      model: 'desktop-model',
      apiBaseUrl: 'http://127.0.0.1:8125',
    })
  })

  it('app-server smoke replaces a blank configured token with authenticated temporary authority', async () => {
    const runtimeDir = makeRuntimeDir()
    const result = await runCli([
      'app-server',
      '--app-server-host',
      '127.0.0.1',
      '--app-server-port',
      '0',
      '--app-server-smoke',
    ], runtimeDir, {
      env: { OWLCODA_APP_SERVER_TOKEN: '   ' },
    })

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      health: { status: 'ok' },
      compatibility: 'compatible',
    })
  })

  it('app-server stops its ephemeral provider router when the App Server exits', async () => {
    const runtimeDir = makeRuntimeDir()
    const reservation = createServer()
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
    const address = reservation.address()
    if (!address || typeof address === 'string') throw new Error('runtime port reservation failed')
    const runtimePort = address.port
    await new Promise<void>(resolve => reservation.close(() => resolve()))

    writeFileSync(join(runtimeDir, 'config.json'), JSON.stringify({
      port: runtimePort,
      host: '127.0.0.1',
      routerUrl: 'http://127.0.0.1:65534/v1',
      models: [{
        id: 'desktop-model',
        label: 'Desktop Model',
        backendModel: 'desktop-model',
        aliases: [],
        provider: 'openai-compat',
        endpoint: 'http://127.0.0.1:65534/v1',
        apiKey: 'loopback-test-key',
        tier: 'local',
        default: true,
      }],
    }), 'utf8')

    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      CLI_ENTRY,
      'app-server',
      '--app-server-host',
      '127.0.0.1',
      '--app-server-port',
      '0',
      '--runtime-port',
      '0',
    ], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: join(runtimeDir, 'home'),
        OWLCODA_HOME: runtimeDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    let runtimePid: number | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`App Server did not start: ${stderr}`)), 15_000)
        const onData = () => {
          if (!stderr.includes('OwlCoda App Server listening at')) return
          clearTimeout(timeout)
          resolve()
        }
        child.stderr.on('data', onData)
        child.once('exit', code => {
          clearTimeout(timeout)
          reject(new Error(`App Server exited early (${code}): ${stderr}`))
        })
      })

      const runtimeMeta = JSON.parse(readFileSync(join(runtimeDir, 'runtime.json'), 'utf8')) as {
        host: string
        pid: number
        port: number
      }
      runtimePid = runtimeMeta.pid
      expect(runtimeMeta.port).toBeGreaterThan(0)
      const response = await fetch(`http://${runtimeMeta.host}:${runtimeMeta.port}/health`)
      expect(response.ok).toBe(true)
      expect(await response.json()).toMatchObject({ status: 'ok' })
    } finally {
      child.kill('SIGTERM')
      await new Promise<void>(resolve => child.once('close', () => resolve()))
      const runtimeExited = runtimePid === undefined || await waitForProcessExit(runtimePid)
      if (!runtimeExited) await runCli(['stop', '--force'], runtimeDir)
      expect(runtimeExited).toBe(true)
    }
  })

  it('app-server stops its ephemeral provider router when App Server binding fails', async () => {
    const runtimeDir = makeRuntimeDir()
    const occupied = createServer()
    await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve))
    const occupiedAddress = occupied.address()
    if (!occupiedAddress || typeof occupiedAddress === 'string') {
      throw new Error('App Server port reservation failed')
    }

    writeFileSync(join(runtimeDir, 'config.json'), JSON.stringify({
      port: 0,
      host: '127.0.0.1',
      routerUrl: 'http://127.0.0.1:65534/v1',
      models: [{
        id: 'desktop-model',
        label: 'Desktop Model',
        backendModel: 'desktop-model',
        aliases: [],
        provider: 'openai-compat',
        endpoint: 'http://127.0.0.1:65534/v1',
        apiKey: 'loopback-test-key',
        tier: 'local',
        default: true,
      }],
    }), 'utf8')

    let runtimePid: number | undefined
    try {
      const result = await runCli([
        'app-server',
        '--app-server-host',
        '127.0.0.1',
        '--app-server-port',
        String(occupiedAddress.port),
        '--runtime-port',
        '0',
      ], runtimeDir)

      expect(result.code).not.toBe(0)
      expect(result.stderr).toMatch(/EADDRINUSE|address already in use/i)
      const runtimeMetaPath = join(runtimeDir, 'runtime.json')
      if (existsSync(runtimeMetaPath)) {
        const runtimeMeta = JSON.parse(readFileSync(runtimeMetaPath, 'utf8')) as {
          pid: number
        }
        runtimePid = runtimeMeta.pid
        expect(await waitForProcessExit(runtimePid)).toBe(true)
      }
    } finally {
      await new Promise<void>(resolve => occupied.close(() => resolve()))
      if (runtimePid !== undefined && isProcessAlive(runtimePid)) {
        await runCli(['stop', '--force'], runtimeDir)
      }
    }
  })

  it('workflow execute runs a native HTTP plan and prints a machine-readable receipt', async () => {
    const runtimeDir = makeRuntimeDir()
    let server: Server | undefined
    try {
      server = createServer((req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, path: req.url }))
      })
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('test server did not bind')
      const baseUrl = `http://127.0.0.1:${address.port}`
      const planPath = join(runtimeDir, 'workflow-plan.json')
      const receiptPath = join(runtimeDir, 'workflow-receipt.json')
      writeFileSync(planPath, JSON.stringify({
        run_id: 'cli-workflow-smoke',
        base_url: baseUrl,
        steps: [{
          id: 'ping',
          method: 'GET',
          url: '/ping',
          expected_status: 200,
          projection: ['ok'],
        }],
      }), 'utf-8')

      const result = await runCli([
        'workflow',
        'execute',
        '--plan',
        planPath,
        '--receipt',
        receiptPath,
        '--artifact-dir',
        join(runtimeDir, 'workflow-artifacts'),
        '--json',
      ], runtimeDir)

      expect(result.code).toBe(0)
      const receipt = JSON.parse(result.stdout)
      expect(receipt).toMatchObject({
        run_id: 'cli-workflow-smoke',
        acceptance: 'pass',
        required_endpoint_calls: '1/1',
      })
      expect(existsSync(receiptPath)).toBe(true)
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()))
    }
  })

  it('workflow resume continues a saved native HTTP plan from the first unfinished step', async () => {
    const runtimeDir = makeRuntimeDir()
    let server: Server | undefined
    let flakyStatus = 500
    const calls: string[] = []
    try {
      server = createServer((req, res) => {
        calls.push(req.url ?? '/')
        res.setHeader('content-type', 'application/json')
        if (req.url === '/flaky') {
          res.statusCode = flakyStatus
          res.end(JSON.stringify({ ok: flakyStatus === 200 }))
          return
        }
        res.end(JSON.stringify({ ok: true, path: req.url }))
      })
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('test server did not bind')
      const planPath = join(runtimeDir, 'workflow-resume-plan.json')
      writeFileSync(planPath, JSON.stringify({
        run_id: 'cli-workflow-resume',
        base_url: `http://127.0.0.1:${address.port}`,
        steps: [{
          id: 'already_done',
          method: 'GET',
          url: '/done',
          expected_status: 200,
          projection: ['ok'],
        }, {
          id: 'finish_later',
          method: 'GET',
          url: '/flaky',
          expected_status: 200,
          projection: ['ok'],
        }],
        acceptance: {
          required_endpoint_calls: 2,
          must_all_ok: true,
        },
      }), 'utf-8')

      const first = await runCli([
        'workflow',
        'execute',
        '--plan',
        planPath,
        '--cwd',
        runtimeDir,
        '--json',
      ], runtimeDir)

      expect(first.code).toBe(1)
      expect(calls).toEqual(['/done', '/flaky'])

      calls.length = 0
      flakyStatus = 200
      const resumed = await runCli([
        'workflow',
        'resume',
        '--run-id',
        'cli-workflow-resume',
        '--cwd',
        runtimeDir,
        '--json',
      ], runtimeDir)

      expect(resumed.code).toBe(0)
      expect(calls).toEqual(['/flaky'])
      const receipt = JSON.parse(resumed.stdout)
      expect(receipt).toMatchObject({
        run_id: 'cli-workflow-resume',
        acceptance: 'pass',
        required_endpoint_calls: '2/2',
        resume: {
          previous_run_id: 'cli-workflow-resume',
          resumed_step_ids: ['already_done'],
        },
      })
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()))
    }
  })

  it('workflow list and inspect expose WorkflowConsumerManifest JSON without natural language', async () => {
    const runtimeDir = makeRuntimeDir()
    const runId = 'cli-workflow-inspect'
    const runDir = join(runtimeDir, '.owlcoda-workflows', runId)
    const artifactDir = join(runDir, `${runId}-artifacts`)
    mkdirSync(artifactDir, { recursive: true })
    const receiptPath = join(runDir, 'receipt.json')
    const planPath = join(runDir, 'plan.json')
    writeFileSync(planPath, JSON.stringify({
      run_id: runId,
      plan_version: 'cli-inspect.test',
      steps: [{ id: 'ping', method: 'GET', url: 'https://example.test/ping' }],
    }), 'utf-8')
    writeFileSync(receiptPath, JSON.stringify({
      schema_version: 1,
      kind: 'workflow_invocation_receipt',
      run_id: runId,
      started_at: '2026-07-02T02:00:00.000Z',
      finished_at: '2026-07-02T02:00:01.000Z',
      plan_version: 'cli-inspect.test',
      plan_digest: 'digest',
      plan_path: planPath,
      receipt_path: receiptPath,
      artifact_dir: artifactDir,
      required_steps_total: 1,
      required_steps_completed: 1,
      failed_steps: [],
      skipped_steps: [],
      endpoint_calls: [],
      acceptance: 'pass',
      required_endpoint_calls: '1/1',
    }), 'utf-8')

    const listed = await runCli([
      'workflow',
      'list',
      '--cwd',
      runtimeDir,
      '--json',
    ], runtimeDir)

    expect(listed.code).toBe(0)
    expect(listed.stderr.trim()).toBe('')
    const listBody = JSON.parse(listed.stdout)
    expect(listBody).toMatchObject({
      schemaVersion: 1,
      workflowRoot: join(runtimeDir, '.owlcoda-workflows'),
      count: 1,
      runs: [{
        runId,
        normalizedState: 'completed',
        acceptance: { status: 'pass' },
        finalReportEligibility: { allowed: true },
      }],
    })

    const inspected = await runCli([
      'workflow',
      'inspect',
      '--run-id',
      runId,
      '--cwd',
      runtimeDir,
      '--json',
    ], runtimeDir)

    expect(inspected.code).toBe(0)
    expect(inspected.stderr.trim()).toBe('')
    const manifest = JSON.parse(inspected.stdout)
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      kind: 'workflow_consumer_manifest',
      runId,
      plan: { path: planPath, version: 'cli-inspect.test' },
      receipt: { path: receiptPath, acceptance: 'pass' },
      normalizedState: 'completed',
      finalReportEligibility: { allowed: true, blockers: [] },
    })
  })

  it('workflow inspect returns a structured JSON error for unknown run ids', async () => {
    const runtimeDir = makeRuntimeDir()
    const result = await runCli([
      'workflow',
      'inspect',
      '--run-id',
      'missing-run',
      '--cwd',
      runtimeDir,
      '--json',
    ], runtimeDir)

    expect(result.code).toBe(1)
    expect(result.stderr.trim()).toBe('')
    const body = JSON.parse(result.stdout)
    expect(body).toMatchObject({
      type: 'error',
      error: {
        type: 'workflow_run_not_found',
        runId: 'missing-run',
      },
    })
  })

  it('instructions inspect exposes the runtime instruction chain as JSON', async () => {
    const runtimeDir = makeRuntimeDir()
    const projectDir = join(runtimeDir, 'project')
    const rulesDir = join(projectDir, '.claude', 'rules')
    mkdirSync(join(projectDir, '.git'), { recursive: true })
    mkdirSync(rulesDir, { recursive: true })
    writeFileSync(join(projectDir, 'AGENTS.override.md'), 'Project override rules', 'utf-8')
    writeFileSync(join(projectDir, 'AGENTS.md'), 'Project runtime rules', 'utf-8')
    writeFileSync(join(rulesDir, 'api.md'), [
      '---',
      'paths:',
      '  - "src/api/**/*.ts"',
      '---',
      'api-only rule',
    ].join('\n'), 'utf-8')

    const result = await runCli([
      'instructions',
      'inspect',
      '--cwd',
      projectDir,
      '--json',
    ], runtimeDir)

    expect(result.code).toBe(0)
    expect(result.stderr.trim()).toBe('')
    const body = JSON.parse(result.stdout)
    expect(body).toMatchObject({
      schemaVersion: 1,
      kind: 'owlcoda_instruction_chain',
      cwd: projectDir,
      count: 2,
      limits: {
        maxBytesPerFile: 16 * 1024,
        maxSearchDepth: 6,
        maxRuleFiles: 32,
      },
    })
    expect(body.sources.map((source: { name: string; scope: string; kind: string }) => [
      source.name,
      source.scope,
      source.kind,
    ])).toEqual([
      ['builtin:AGENTS.md', 'builtin', 'builtin'],
      ['AGENTS.override.md', 'project', 'AGENTS.override.md'],
    ])
    expect(body.sources[0].contentPreview).toContain('OwlCoda Agent Working Guidelines')
    expect(body.sources[1].contentPreview).toContain('Project override rules')
    expect(body.skipped.map((source: { reason: string; name: string }) => [
      source.reason,
      source.name,
    ])).toEqual([
      ['shadowed-by-override', 'AGENTS.md'],
      ['path-scoped-rule', '.claude/rules/api.md'],
    ])
  })

  it('instructions inspect prints skipped sources in human-readable output', async () => {
    const runtimeDir = makeRuntimeDir()
    const projectDir = join(runtimeDir, 'project')
    const rulesDir = join(projectDir, '.claude', 'rules')
    mkdirSync(join(projectDir, '.git'), { recursive: true })
    mkdirSync(rulesDir, { recursive: true })
    writeFileSync(join(projectDir, 'AGENTS.override.md'), 'Project override rules', 'utf-8')
    writeFileSync(join(projectDir, 'AGENTS.md'), 'Project runtime rules', 'utf-8')
    writeFileSync(join(rulesDir, 'api.md'), [
      '---',
      'paths:',
      '  - "src/api/**/*.ts"',
      '---',
      'api-only rule',
    ].join('\n'), 'utf-8')

    const result = await runCli([
      'instructions',
      'inspect',
      '--cwd',
      projectDir,
    ], runtimeDir)

    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('')
    expect(result.stderr).toContain('Instruction chain (2 sources)')
    expect(result.stderr).toContain('Skipped (2)')
    expect(result.stderr).toContain('shadowed-by-override AGENTS.md')
    expect(result.stderr).toContain('path-scoped-rule .claude/rules/api.md')
  })

  it('doctor runs all checks', async () => {
    const runtimeDir = makeRuntimeDir()
    const result = await runCli(['doctor'], runtimeDir)
    expect(result.stderr).toContain('owlcoda doctor')
    expect(result.stderr).toContain('Node.js')
    expect(result.stderr).toContain('Launch mode')
    // Node.js check should pass in test env
    expect(result.stderr).toMatch(/✅.*Node\.js/)
  })

  it('doctor --json emits machine-readable build and schema identity', async () => {
    const runtimeDir = makeRuntimeDir()
    const result = await runCli(['doctor', '--json'], runtimeDir)
    const report = JSON.parse(result.stdout)
    expect(report.releaseIdentity).toMatchObject({
      packageVersion: expect.any(String),
      build: { sha: expect.any(String), dirty: expect.any(Boolean), builtAt: expect.any(String) },
      schemaBundle: {
        algorithm: 'sha256',
        hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        fileCount: expect.any(Number),
      },
    })
    expect(result.stderr).not.toContain('owlcoda doctor')
  })

  it('init creates config.json', async () => {
    const runtimeDir = makeRuntimeDir()
    const result = await runCli(['init'], runtimeDir)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('✅')

    const configPath = join(runtimeDir, 'config.json')
    expect(existsSync(configPath)).toBe(true)
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(config.port).toBe(8019)
    expect(Array.isArray(config.models)).toBe(true)
  })

  it('init refuses overwrite without --force', async () => {
    const runtimeDir = makeRuntimeDir()
    await runCli(['init'], runtimeDir)
    const second = await runCli(['init'], runtimeDir)
    expect(second.code).toBe(1)
    expect(second.stderr).toContain('already exists')
  })

  it('init --force overwrites', async () => {
    const runtimeDir = makeRuntimeDir()
    await runCli(['init'], runtimeDir)
    const result = await runCli(['init', '--force', '--port', '9999'], runtimeDir)
    expect(result.code).toBe(0)
    const config = JSON.parse(readFileSync(join(runtimeDir, 'config.json'), 'utf-8'))
    expect(config.port).toBe(9999)
  })

  it('config shows active configuration', async () => {
    const runtimeDir = makeRuntimeDir()
    // First create config
    await runCli(['init'], runtimeDir)
    const result = await runCli(['config'], runtimeDir)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('owlcoda config')
    expect(result.stderr).toContain('127.0.0.1:8019')
    expect(result.stderr).toContain('Launch mode')
  })

  it('sessions audit-runtime-events --json reports runtime event contract diagnostics without a model turn', async () => {
    const runtimeDir = makeRuntimeDir()
    const sessionsDir = join(runtimeDir, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(join(sessionsDir, 'runtime-audit-fixture.json'), JSON.stringify({
      version: 1,
      id: 'runtime-audit-fixture',
      model: 'mimo-v2.5-pro',
      system: 'test',
      maxTokens: 4096,
      turns: [],
      createdAt: 1,
      updatedAt: 2,
      runtimeEventLog: {
        schemaVersion: 1,
        updatedAt: '2026-06-19T10:00:03.000Z',
        nextSeq: 4,
        events: [{
          id: 'runtime_event-1',
          seq: 1,
          kind: 'runtime_intervention',
          at: '2026-06-19T10:00:00.000Z',
          conversationId: 'runtime-audit-fixture',
          payload: { intervention_kind: 'long_task_wait_policy' },
          contract: {
            schema_version: 1,
            kind: 'runtime_event_contract',
            event_kind: 'runtime_intervention',
            payload_schema: 'runtime_intervention.v1',
            validation_status: 'valid',
          },
        }, {
          id: 'runtime_event-2',
          seq: 2,
          kind: 'runtime_recovery_report_recorded',
          at: '2026-06-19T10:00:01.000Z',
          conversationId: 'runtime-audit-fixture',
          checkpointId: 'long_task_checkpoint-1',
          checkpointKind: 'long_task_checkpoint',
          payload: {
            report_kind: 'long_task_checkpoint_report',
            report_source: 'assistant_text',
            report: {
              kind: 'long_task_checkpoint_report',
              checkpoint_id: 'long_task_checkpoint-1',
              checkpoint_kind: 'long_task_checkpoint',
              long_task_id: 'task:audit-legacy',
              inspect_command: 'LongTaskGet longTaskId=task:audit-legacy',
            },
          },
        }, {
          id: 'runtime_event-3',
          seq: 3,
          kind: 'checkpoint_resolved',
          at: '2026-06-19T10:00:02.000Z',
          conversationId: 'runtime-audit-fixture',
          checkpointId: 'long_task_checkpoint-1',
          checkpointKind: 'long_task_checkpoint',
          payload: {
            checkpoint_id: 'long_task_checkpoint-1',
            checkpoint_kind: 'long_task_checkpoint',
          },
          contract: {
            schema_version: 1,
            kind: 'runtime_event_contract',
            event_kind: 'runtime_intervention',
            payload_schema: 'checkpoint_resolved.v1',
            validation_status: 'valid',
          },
        }],
      },
    }, null, 2))

    const result = await runCli(['sessions', 'audit-runtime-events', '--json', '--include-test'], runtimeDir)

    expect(result.code).toBe(1)
    const report = JSON.parse(result.stdout)
    expect(report).toMatchObject({
      schema_version: 1,
      kind: 'runtime_event_audit_report',
      sessions_scanned: 1,
      sessions_with_runtime_events: 1,
      totals: {
        event_count: 3,
        contract_valid: 1,
        legacy_replay_compatible: 1,
        malformed_saved_event: 1,
      },
    })
    expect(report.sessions[0]).toMatchObject({
      id: 'runtime-audit-fixture',
      status: 'failed',
      diagnostics: {
        malformed_event_count: 1,
      },
    })
    expect(report.sessions[0].diagnostics.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        seq: 3,
        status: 'malformed_saved_event',
        validation_errors: expect.arrayContaining([
          'contract.event_kind:mismatch',
          'payload.disposition',
        ]),
      }),
    ]))
  })

  it('logs fails gracefully without logFilePath', async () => {
    const runtimeDir = makeRuntimeDir()
    await runCli(['init'], runtimeDir)
    const result = await runCli(['logs'], runtimeDir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('logFilePath')
  })

  it('--dry-run validates without launching', async () => {
    const runtimeDir = makeRuntimeDir()
    await runCli(['init'], runtimeDir)
    const result = await runCli(['--dry-run'], runtimeDir)
    // Should show config + doctor output
    expect(result.stderr).toContain('owlcoda config')
    expect(result.stderr).toContain('owlcoda doctor')
    expect(result.stderr).toContain('Dry run')
  })
})
