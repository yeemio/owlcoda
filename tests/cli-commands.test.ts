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
  timeoutMs: number = CLI_SUBPROCESS_TEST_TIMEOUT_MS,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI_ENTRY, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
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
    }, timeoutMs)

    child.on('error', err => { clearTimeout(timer); reject(err) })
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
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

  it('app-server smoke starts the structured desktop App Server contract', async () => {
    const runtimeDir = makeRuntimeDir()
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
      baseUrl: string
      health: { status: string; methods: string[] }
    }
    expect(smoke.ok).toBe(true)
    expect(smoke.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(smoke.health.status).toBe('ok')
    expect(smoke.health.methods).toContain('runtimeTranscript/read')
    expect(smoke.health.methods).toContain('interaction/list')
    expect(smoke.health.methods).toContain('runtimeRail/read')
  })

  it('app-server smoke loads OwlCoda config for runtime loop execution', async () => {
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
      health: {
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
    expect(smoke.health.subsystems.appServerLoop).toMatchObject({
      status: 'ok',
      model: 'desktop-model',
      apiBaseUrl: 'http://127.0.0.1:8125',
    })
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

  it('doctor runs all checks', async () => {
    const runtimeDir = makeRuntimeDir()
    const result = await runCli(['doctor'], runtimeDir)
    expect(result.stderr).toContain('owlcoda doctor')
    expect(result.stderr).toContain('Node.js')
    expect(result.stderr).toContain('Launch mode')
    // Node.js check should pass in test env
    expect(result.stderr).toMatch(/✅.*Node\.js/)
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
