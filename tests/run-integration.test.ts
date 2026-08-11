/**
 * OwlCoda v0.5.2 run integration tests — real CLI subprocess harness.
 *
 * These tests exercise the actual `owlcoda run` path through CLI subprocess,
 * including preflight, ensureProxyRunning, model resolution, session
 * persistence (including tool_result), resume, and JSON output.
 *
 * Uses a fake router that returns canned Anthropic responses.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { parseArgs, VERSION } from '../dist/cli-core.js'
import {
  fetchHealthz,
  healthzMatchesRuntimeMeta,
  resolveClientHost,
  waitForHealthzGone,
  type RuntimeMetaLike,
} from '../src/healthz-client.js'

const REPO_ROOT = join(import.meta.dirname, '..')
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli.ts')
const CLI_SUBPROCESS_TEST_TIMEOUT_MS = 15000

const runtimeDirs = new Set<string>()
const heldServers = new Set<Server>()

function makeRuntimeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'owlcoda-run-int-'))
  runtimeDirs.add(dir)
  return dir
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') { server.close(); reject(new Error('No port')); return }
      const { port } = addr
      server.close(err => { if (err) reject(err); else resolve(port) })
    })
  })
}

function makeConfig(runtimeDir: string, port: number, routerUrl: string, models?: unknown[]): string {
  mkdirSync(runtimeDir, { recursive: true })
  const configPath = join(runtimeDir, 'config.json')
  writeFileSync(configPath, JSON.stringify({
    host: '127.0.0.1',
    port,
    routerUrl,
    models: models ?? [
      { id: 'test-backend', label: 'Test Backend', backendModel: 'test-backend', aliases: ['default'], tier: 'production', default: true },
      { id: 'test-heavy', label: 'Test Heavy', backendModel: 'test-heavy', aliases: ['heavy'], tier: 'heavy' },
    ],
  }, null, 2))
  return configPath
}

function writeSessionFixture(
  runtimeDir: string,
  id: string,
  updatedAt: number,
): void {
  const sessionsDir = join(runtimeDir, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(join(sessionsDir, `${id}.json`), JSON.stringify({
    version: 1,
    id,
    model: 'test-backend',
    system: 'fixture-system',
    maxTokens: 4096,
    turns: [
      { role: 'user', content: [{ type: 'text', text: `fixture ${id}` }], timestamp: updatedAt - 1 },
      { role: 'assistant', content: [{ type: 'text', text: `fixture answer ${id}` }], timestamp: updatedAt },
    ],
    createdAt: updatedAt - 10,
    updatedAt,
    title: id,
  }, null, 2))
}

function writeLiveRegistry(
  runtimeDir: string,
  client: {
    clientId: string
    clientPid: number
    daemonPid: number
    runtimeToken: string
    host: string
    port: number
    routerUrl: string
    startedAt: string
    sessionId?: string
  },
): void {
  writeFileSync(join(runtimeDir, 'live-repl.json'), JSON.stringify({
    version: 2,
    clients: [client],
  }, null, 2))
}

async function runCli(
  args: string[],
  runtimeDir: string,
  envOverrides: Record<string, string> = {},
  stdinData?: string,
  timeoutMs: number = 20000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI_ENTRY, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, OWLCODA_HOME: runtimeDir, ...envOverrides },
      stdio: [stdinData ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    if (stdinData && child.stdin) {
      child.stdin.write(stdinData)
      child.stdin.end()
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Timed out: ${args.join(' ')}`)) }, timeoutMs)
    child.on('error', err => { clearTimeout(timer); reject(err) })
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

type FakeRouterResponse = object | { statusCode: number; body: object }

function isStatusOverride(value: FakeRouterResponse): value is { statusCode: number; body: object } {
  return typeof (value as { statusCode?: unknown }).statusCode === 'number'
    && typeof (value as { body?: unknown }).body === 'object'
    && (value as { body?: unknown }).body !== null
}

/** Start a fake router that serves /healthz + /v1/models + /v1/chat/completions */
function startFakeRouter(port: number, responseOverride?: (req: IncomingMessage, body: string) => FakeRouterResponse): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
        return
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'test-backend' }, { id: 'test-heavy' }] }))
        return
      }
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          const bodyStr = Buffer.concat(chunks).toString('utf-8')
          let parsedBody: Record<string, unknown> = {}
          try { parsedBody = JSON.parse(bodyStr) } catch { /* ignore */ }

          if (responseOverride) {
            const obj = responseOverride(req, bodyStr)
            if (isStatusOverride(obj)) {
              res.writeHead(obj.statusCode, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify(obj.body))
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify(obj))
            }
            return
          }

          const isStream = parsedBody['stream'] === true

          if (isStream) {
            // Return SSE streaming format so the owlcoda stream translator can parse it
            res.writeHead(200, { 'Content-Type': 'text/event-stream' })
            const delta1 = JSON.stringify({ id: 'fake-1', object: 'chat.completion.chunk', model: 'test-backend', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
            const delta2 = JSON.stringify({ id: 'fake-1', object: 'chat.completion.chunk', model: 'test-backend', choices: [{ index: 0, delta: { content: 'Hello from fake router' }, finish_reason: null }] })
            const delta3 = JSON.stringify({ id: 'fake-1', object: 'chat.completion.chunk', model: 'test-backend', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
            res.write(`data: ${delta1}\n\n`)
            res.write(`data: ${delta2}\n\n`)
            res.write(`data: ${delta3}\n\n`)
            res.write('data: [DONE]\n\n')
            res.end()
          } else {
            // Non-streaming response
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              id: 'fake-1',
              object: 'chat.completion',
              model: 'test-backend',
              choices: [{
                index: 0,
                message: { role: 'assistant', content: 'Hello from fake router' },
                finish_reason: 'stop',
              }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }))
          }
        })
        return
      }
      res.writeHead(404)
      res.end('Not found')
    })
    heldServers.add(server)
    server.listen(port, '127.0.0.1', () => resolve(server))
    server.on('error', reject)
  })
}

type ProcessIdentity = {
  command: string
  startTime: string
}

function readProcessIdentity(pid: number): ProcessIdentity | null {
  try {
    return {
      command: execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' }).trim(),
      startTime: execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf-8' }).trim(),
    }
  } catch {
    return null
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sameProcessIdentity(a: ProcessIdentity | null, b: ProcessIdentity | null): boolean {
  return a !== null && b !== null && a.command === b.command && a.startTime === b.startTime
}

async function waitForProcessExit(pid: number, timeoutMs: number = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (!isPidAlive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return !isPidAlive(pid)
}

async function cleanupOwnedDaemon(runtimeDir: string): Promise<void> {
  const pidPath = join(runtimeDir, 'owlcoda.pid')
  if (!existsSync(pidPath)) return

  const pid = Number(readFileSync(pidPath, 'utf-8').trim())
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid daemon PID in ${pidPath}`)
  const metaPath = join(runtimeDir, 'runtime.json')
  if (!existsSync(metaPath)) {
    if (isPidAlive(pid)) throw new Error(`daemon PID ${pid} has no runtime identity`)
    return
  }

  const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as RuntimeMetaLike
  if (meta.pid !== pid || !Number.isInteger(meta.port) || typeof meta.runtimeToken !== 'string') {
    throw new Error(`daemon identity mismatch for PID ${pid}`)
  }

  const processBeforeSignal = readProcessIdentity(pid)
  if (!processBeforeSignal) return
  const configPath = join(runtimeDir, 'config.json')
  if (!processBeforeSignal.command.includes(`${CLI_ENTRY} server --config ${configPath}`)) {
    throw new Error(`refusing to signal PID ${pid}: command identity mismatch`)
  }

  const baseUrl = `http://${resolveClientHost(meta.host)}:${meta.port}`
  const healthz = await fetchHealthz(baseUrl, 1000, meta.runtimeToken)
  if (!healthz || !healthzMatchesRuntimeMeta(healthz, meta)) {
    throw new Error(`refusing to signal PID ${pid}: health identity mismatch`)
  }

  process.kill(pid, 'SIGTERM')
  let healthzGone = await waitForHealthzGone(baseUrl, 5000)
  let processGone = await waitForProcessExit(pid, 5000)
  if (!healthzGone || !processGone) {
    const processBeforeKill = readProcessIdentity(pid)
    if (!sameProcessIdentity(processBeforeKill, processBeforeSignal)) {
      throw new Error(`refusing SIGKILL for PID ${pid}: process identity changed`)
    }
    process.kill(pid, 'SIGKILL')
    healthzGone = await waitForHealthzGone(baseUrl, 2000)
    processGone = await waitForProcessExit(pid, 2000)
  }
  if (!healthzGone || !processGone) {
    throw new Error(`daemon PID ${pid} did not fully release ${baseUrl}`)
  }
}

afterEach(async () => {
  for (const server of heldServers) {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  heldServers.clear()

  const cleanupErrors: Error[] = []
  for (const runtimeDir of runtimeDirs) {
    try { await cleanupOwnedDaemon(runtimeDir) } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)))
    }
    try { rmSync(runtimeDir, { recursive: true, force: true }) } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)))
    }
  }
  runtimeDirs.clear()
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'OwlCoda test daemon cleanup failed')
  }
})

// ─── parseArgs (retained from v0.5.1 for regression) ───

describe('parseArgs: run command', () => {
  it('parses run command', () => {
    const result = parseArgs(['node', 'cli.js', 'run'])
    expect(result.command).toBe('run')
  })

  it('parses run --prompt', () => {
    const result = parseArgs(['node', 'cli.js', 'run', '--prompt', 'hello world'])
    expect(result.command).toBe('run')
    expect(result.prompt).toBe('hello world')
  })

  it('parses run --json', () => {
    const result = parseArgs(['node', 'cli.js', 'run', '--json', '--prompt', 'test'])
    expect(result.jsonOutput).toBe(true)
  })

  it('parses run --auto-approve', () => {
    const result = parseArgs(['node', 'cli.js', 'run', '--auto-approve', '--prompt', 'test'])
    expect(result.autoApprove).toBe(true)
  })

  it('parses run --resume with ID', () => {
    const result = parseArgs(['node', 'cli.js', 'run', '--resume', '20260101-abc', '--prompt', 'continue'])
    expect(result.resumeSession).toBe('20260101-abc')
  })

  it('parses run --resume at end defaults to "last"', () => {
    const result = parseArgs(['node', 'cli.js', 'run', '--prompt', 'test', '--resume'])
    expect(result.resumeSession).toBe('last')
  })

  it('parses all flags combined', () => {
    const result = parseArgs(['node', 'cli.js', 'run', '--prompt', 'hi', '--json', '--auto-approve', '--allow-tool', 'read,write', '--deny-tool', 'bash', '--resume', 'ses-123'])
    expect(result.command).toBe('run')
    expect(result.prompt).toBe('hi')
    expect(result.jsonOutput).toBe(true)
    expect(result.autoApprove).toBe(true)
    expect(result.allowTools).toEqual(['read', 'write'])
    expect(result.denyTools).toEqual(['bash'])
    expect(result.resumeSession).toBe('ses-123')
  })
})

// ─── Version consistency ───

describe('version consistency', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf-8'))

  it('VERSION matches package.json', () => {
    expect(VERSION).toBe(pkg.version)
  })

  it('package.json version is semver', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/)
  })
})

// ─── Real CLI subprocess: run path ───

describe('run: real CLI subprocess integration', () => {
  it('run --prompt exits 1 when router is unreachable (preflight blocked)', async () => {
    const runtimeDir = makeRuntimeDir()
    // Point to a port where nothing listens
    const configPath = makeConfig(runtimeDir, await getFreePort(), 'http://127.0.0.1:65534')
    const result = await runCli(['run', '--prompt', 'hello', '--config', configPath], runtimeDir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Cannot proceed')
  }, CLI_SUBPROCESS_TEST_TIMEOUT_MS)

  it('run --prompt succeeds with fake router, returns text on stdout', async () => {
    const runtimeDir = makeRuntimeDir()
    const routerPort = await getFreePort()
    const proxyPort = await getFreePort()
    await startFakeRouter(routerPort)
    const configPath = makeConfig(runtimeDir, proxyPort, `http://127.0.0.1:${routerPort}`)

    const result = await runCli(['run', '--prompt', 'hello', '--config', configPath], runtimeDir)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Hello from fake router')
    expect(result.stdout).not.toContain('\x1b[')
    expect(result.stdout).not.toContain('───')
    expect(result.stdout).not.toContain('╭')
  }, CLI_SUBPROCESS_TEST_TIMEOUT_MS)

  it('run --prompt --json outputs valid JSON contract', async () => {
    const runtimeDir = makeRuntimeDir()
    const routerPort = await getFreePort()
    const proxyPort = await getFreePort()
    await startFakeRouter(routerPort)
    const configPath = makeConfig(runtimeDir, proxyPort, `http://127.0.0.1:${routerPort}`)

    const result = await runCli(['run', '--prompt', 'hello', '--json', '--config', configPath], runtimeDir)
    expect(result.code).toBe(0)

    const json = JSON.parse(result.stdout.trim())
    expect(json).toHaveProperty('text')
    expect(json).toHaveProperty('model')
    expect(json).toHaveProperty('session_id')
    expect(json).toHaveProperty('resumed', false)
    expect(json).toHaveProperty('exit_code', 0)
    expect(json).toHaveProperty('tool_calls')
    expect(Array.isArray(json.tool_calls)).toBe(true)
    expect(typeof json.session_id).toBe('string')
    expect(json.text).toContain('Hello from fake router')
  }, CLI_SUBPROCESS_TEST_TIMEOUT_MS)

  it('run --allow-tool Agent exposes the Agent tool schema to the model', async () => {
    const runtimeDir = makeRuntimeDir()
    const routerPort = await getFreePort()
    const proxyPort = await getFreePort()
    let sawAgentTool = false
    let toolNames: Array<string | undefined> = []

    await startFakeRouter(routerPort, (_req, body) => {
      const parsed = JSON.parse(body)
      const tools = Array.isArray(parsed.tools) ? parsed.tools : []
      toolNames = tools.map((tool: { name?: string; function?: { name?: string } }) =>
        tool.name ?? tool.function?.name,
      )
      sawAgentTool = tools.some((tool: { name?: string; function?: { name?: string } }) =>
        tool.name === 'Agent' || tool.function?.name === 'Agent',
      )
      return {
        id: 'fake-agent-schema',
        object: 'chat.completion',
        model: parsed.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Agent schema visible' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }
    })
    const configPath = makeConfig(runtimeDir, proxyPort, `http://127.0.0.1:${routerPort}`)

    const result = await runCli(
      ['run', '--prompt', 'delegate work', '--json', '--allow-tool', 'Agent', '--config', configPath],
      runtimeDir,
    )

    expect(result.code).toBe(0)
    expect(sawAgentTool).toBe(true)
    expect(toolNames).toContain('Agent')
    const json = JSON.parse(result.stdout.trim())
    expect(json.text).toContain('Agent schema visible')
    expect(json.approval_tool_allowlist).toEqual(['Agent'])
  }, CLI_SUBPROCESS_TEST_TIMEOUT_MS)

  it('run creates a session file on disk', async () => {
    const runtimeDir = makeRuntimeDir()
    const routerPort = await getFreePort()
    const proxyPort = await getFreePort()
    await startFakeRouter(routerPort)
    const configPath = makeConfig(runtimeDir, proxyPort, `http://127.0.0.1:${routerPort}`)

    await runCli(['run', '--prompt', 'test session', '--config', configPath], runtimeDir)

    const sessDir = join(runtimeDir, 'sessions')
    expect(existsSync(sessDir)).toBe(true)
    const files = readdirSync(sessDir).filter(f => f.endsWith('.json'))
    expect(files.length).toBeGreaterThanOrEqual(1)

    // Load session and verify transcript (format uses 'turns', content is ContentBlock[])
    const session = JSON.parse(readFileSync(join(sessDir, files[0]!), 'utf-8'))
    expect(session.turns.length).toBeGreaterThanOrEqual(2)
    expect(session.turns[0].role).toBe('user')
    expect(session.turns[0].content[0].text).toBe('test session')
    expect(session.turns[1].role).toBe('assistant')
  }, CLI_SUBPROCESS_TEST_TIMEOUT_MS)

  it('run --resume continues a session and restores model', async () => {
    const runtimeDir = makeRuntimeDir()
    const routerPort = await getFreePort()
    const proxyPort = await getFreePort()

    let lastRequestModel = ''
    await startFakeRouter(routerPort, (_req, body) => {
      const parsed = JSON.parse(body)
      lastRequestModel = parsed.model
      return {
        id: 'fake-resume',
        object: 'chat.completion',
        model: parsed.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'resumed response' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }
    })
    const configPath = makeConfig(runtimeDir, proxyPort, `http://127.0.0.1:${routerPort}`)

    // First run: creates a session with default model test-backend
    const first = await runCli(['run', '--prompt', 'first turn', '--json', '--config', configPath], runtimeDir)
    expect(first.code).toBe(0)
    const firstJson = JSON.parse(first.stdout.trim())
    const sessionId = firstJson.session_id
    expect(sessionId).toBeTruthy()
    expect(firstJson.resumed).toBe(false)

    // Now manually patch the session file to use test-heavy as the model
    // (simulating a session that was created with a different model)
    const sessDir = join(runtimeDir, 'sessions')
    const sessFile = join(sessDir, `${sessionId}.json`)
    const sessData = JSON.parse(readFileSync(sessFile, 'utf-8'))
    sessData.model = 'test-heavy'
    writeFileSync(sessFile, JSON.stringify(sessData, null, 2))

    // Resume: should restore test-heavy model
    const second = await runCli(['run', '--prompt', 'second turn', '--resume', sessionId, '--json', '--config', configPath], runtimeDir)
    expect(second.code).toBe(0)
    const secondJson = JSON.parse(second.stdout.trim())
    expect(secondJson.resumed).toBe(true)
    expect(secondJson.model).toBe('test-heavy')

    // Verify session transcript has all turns (first + second)
    const finalSession = JSON.parse(readFileSync(sessFile, 'utf-8'))
    // First run: user + assistant. Second run (resume): user + assistant.
    expect(finalSession.turns.length).toBe(4)
    expect(finalSession.turns[2].role).toBe('user')
    expect(finalSession.turns[2].content[0].text).toBe('second turn')
    expect(finalSession.turns[3].role).toBe('assistant')
  }, CLI_SUBPROCESS_TEST_TIMEOUT_MS)

  it('run --resume injects a persisted runtime recovery ledger', async () => {
    const runtimeDir = makeRuntimeDir()
    const routerPort = await getFreePort()
    const proxyPort = await getFreePort()
    const sessionsDir = join(runtimeDir, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(join(sessionsDir, 'ses-ledger-1.json'), JSON.stringify({
      version: 1,
      id: 'ses-ledger-1',
      model: 'test-backend',
      system: 'fixture-system',
      maxTokens: 4096,
      turns: [
        { role: 'user', content: [{ type: 'text', text: 'start blocked work' }], timestamp: Date.now() - 1 },
        { role: 'assistant', content: [{ type: 'text', text: 'Blocked report from prior run' }], timestamp: Date.now() },
      ],
      createdAt: Date.now() - 10,
      updatedAt: Date.now(),
      title: 'ledger session',
      runtimeRecoveryLedger: {
        schemaVersion: 1,
        updatedAt: '2026-06-17T00:00:01.000Z',
        checkpoints: [{
          id: 'blocked_task_checkpoint-1',
          kind: 'blocked_task_checkpoint',
          generatedAt: '2026-06-17T00:00:01.000Z',
          conversationId: 'ses-ledger-1',
          payload: {
            schema_version: 1,
            kind: 'blocked_task_checkpoint',
            generated_at: '2026-06-17T00:00:01.000Z',
            blocked_task: {
              task_id: 'task-1',
              step_id: 'prove-ledger',
              inspect_command: 'TaskGet taskId=task-1',
            },
          },
          inspectCommands: ['TaskGet taskId=task-1'],
        }],
      },
    }, null, 2))

    let requestText = ''
    await startFakeRouter(routerPort, (_req, body) => {
      const parsed = JSON.parse(body)
      requestText = JSON.stringify(parsed.messages).replace(/\\"/g, '"')
      return {
        id: 'fake-ledger-resume',
        object: 'chat.completion',
        model: parsed.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Recovered using ledger' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }
    })
    const configPath = makeConfig(runtimeDir, proxyPort, `http://127.0.0.1:${routerPort}`)

    const result = await runCli(
      ['run', '--resume', 'ses-ledger-1', '--prompt', 'continue', '--json', '--config', configPath],
      runtimeDir,
    )

    expect(result.code).toBe(0)
    expect(requestText).toContain('[Runtime recovery ledger]')
    expect(requestText).toContain('"kind": "runtime_recovery_ledger"')
    expect(requestText).toContain('"kind": "blocked_task_checkpoint"')
    expect(requestText).toContain('"TaskGet taskId=task-1"')
  }, CLI_SUBPROCESS_TEST_TIMEOUT_MS)

  it('run --resume last with --json when no prior session starts fresh', async () => {
    const runtimeDir = makeRuntimeDir()
    const routerPort = await getFreePort()
    const proxyPort = await getFreePort()
    await startFakeRouter(routerPort)
    const configPath = makeConfig(runtimeDir, proxyPort, `http://127.0.0.1:${routerPort}`)

    const result = await runCli(['run', '--prompt', 'fresh start', '--resume', 'last', '--json', '--config', configPath], runtimeDir)
    expect(result.code).toBe(0)
    const json = JSON.parse(result.stdout.trim())
    expect(json.resumed).toBe(false)
    expect(json.text).toContain('Hello from fake router')
  }, CLI_SUBPROCESS_TEST_TIMEOUT_MS)

  it('run --resume last skips a session owned by another live REPL client', async () => {
    const runtimeDir = makeRuntimeDir()
    const routerPort = await getFreePort()
    const proxyPort = await getFreePort()
    await startFakeRouter(routerPort)
    const configPath = makeConfig(runtimeDir, proxyPort, `http://127.0.0.1:${routerPort}`)

    const startResult = await runCli(['start', '--config', configPath], runtimeDir)
    expect(startResult.code).toBe(0)

    const runtimeMeta = JSON.parse(readFileSync(join(runtimeDir, 'runtime.json'), 'utf-8')) as {
      pid: number
      runtimeToken: string
    }

    writeSessionFixture(runtimeDir, 'live-owned', 2000)
    writeSessionFixture(runtimeDir, 'free-session', 1000)
    writeLiveRegistry(runtimeDir, {
      clientId: 'client-a',
      clientPid: process.pid,
      daemonPid: runtimeMeta.pid,
      runtimeToken: runtimeMeta.runtimeToken,
      host: '127.0.0.1',
      port: proxyPort,
      routerUrl: `http://127.0.0.1:${routerPort}`,
      startedAt: new Date().toISOString(),
      sessionId: 'live-owned',
    })

    const result = await runCli(['run', '--prompt', 'continue safely', '--resume', 'last', '--json', '--config', configPath], runtimeDir)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('skipped 1 live-owned session')

    const json = JSON.parse(result.stdout.trim())
    expect(json.resumed).toBe(true)
    expect(json.session_id).toBe('free-session')

    const resumedSession = JSON.parse(readFileSync(join(runtimeDir, 'sessions', 'free-session.json'), 'utf-8'))
    expect(resumedSession.turns.length).toBe(4)
    expect(resumedSession.turns[2].content[0].text).toBe('continue safely')

    const liveOwnedSession = JSON.parse(readFileSync(join(runtimeDir, 'sessions', 'live-owned.json'), 'utf-8'))
    expect(liveOwnedSession.turns.length).toBe(2)

    await runCli(['stop'], runtimeDir)
  }, CLI_SUBPROCESS_TEST_TIMEOUT_MS)

  it('run piped stdin works as prompt', async () => {
    const runtimeDir = makeRuntimeDir()
    const routerPort = await getFreePort()
    const proxyPort = await getFreePort()
    await startFakeRouter(routerPort)
    const configPath = makeConfig(runtimeDir, proxyPort, `http://127.0.0.1:${routerPort}`)

    const result = await runCli(['run', '--config', configPath], runtimeDir, {}, 'piped input text')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Hello from fake router')
  }, CLI_SUBPROCESS_TEST_TIMEOUT_MS)
})

// ─── Tool result transcript persistence ───

describe('run: tool_result transcript completeness', () => {
  it('run --auto-approve writes a user-declared path with isolated HOME/OWLCODA_HOME and no permissions.json', async () => {
    const runtimeDir = makeRuntimeDir()
    const isolatedHome = makeRuntimeDir()
    const outputDir = makeRuntimeDir()
    const outputPath = join(outputDir, 'report.md')
    const routerPort = await getFreePort()
    const proxyPort = await getFreePort()
    let callCount = 0

    await startFakeRouter(routerPort, (_req, body) => {
      callCount++
      const parsed = JSON.parse(body)
      if (callCount === 1) {
        return {
          id: 'fake-write-declared',
          object: 'chat.completion',
          model: parsed.model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_write_declared',
                type: 'function',
                function: { name: 'write', arguments: JSON.stringify({ path: outputPath, content: 'headless ok\n' }) },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }
      }

      expect(JSON.stringify(parsed.messages)).toContain('Wrote')
      return {
        id: 'fake-write-final',
        object: 'chat.completion',
        model: parsed.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Wrote declared output' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      }
    })
    const configPath = makeConfig(runtimeDir, proxyPort, `http://127.0.0.1:${routerPort}`)

    expect(existsSync(join(runtimeDir, 'permissions.json'))).toBe(false)
    expect(existsSync(join(isolatedHome, '.owlcoda', 'permissions.json'))).toBe(false)

    const result = await runCli(
      ['run', '--prompt', `Write the report to \`${outputPath}\`.`, '--auto-approve', '--json', '--config', configPath],
      runtimeDir,
      { HOME: isolatedHome },
      undefined,
      25_000,
    )

    expect(result.code).toBe(0)
    expect(readFileSync(outputPath, 'utf-8')).toBe('headless ok\n')
    expect(existsSync(join(runtimeDir, 'permissions.json'))).toBe(false)
    const json = JSON.parse(result.stdout.trim())
    expect(json.approval_policy).toBe('auto-approve-task-contract-writes')
    expect(json.tool_calls.some((call: { tool: string; output: string }) =>
      call.tool === 'write' && call.output.includes('Wrote'),
    )).toBe(true)
  }, CLI_SUBPROCESS_TEST_TIMEOUT_MS)

  it('run --auto-approve executes a workspace analysis script before writing a declared report', async () => {
    const runtimeDir = makeRuntimeDir()
    const isolatedHome = makeRuntimeDir()
    const outputDir = makeRuntimeDir()
    const outputPath = join(outputDir, 'research-report.md')
    const routerPort = await getFreePort()
    const proxyPort = await getFreePort()
    let callCount = 0

    await startFakeRouter(routerPort, (_req, body) => {
      callCount++
      const parsed = JSON.parse(body)
      if (callCount === 1) {
        return {
          id: 'fake-research-script',
          object: 'chat.completion',
          model: parsed.model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_research_script',
                type: 'function',
                function: {
                  name: 'bash',
                  arguments: JSON.stringify({
                    command: `cd "${REPO_ROOT}" && node scripts/check-imported-untracked.mjs`,
                  }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }
      }
      if (callCount === 2) {
        expect(JSON.stringify(parsed.messages)).toContain('build.imported_untracked')
        return {
          id: 'fake-research-write',
          object: 'chat.completion',
          model: parsed.model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_research_write',
                type: 'function',
                function: {
                  name: 'write',
                  arguments: JSON.stringify({ path: outputPath, content: 'research complete\n' }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        }
      }

      expect(JSON.stringify(parsed.messages)).toContain('Wrote')
      return {
        id: 'fake-research-final',
        object: 'chat.completion',
        model: parsed.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Research report completed' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 },
      }
    })
    const configPath = makeConfig(runtimeDir, proxyPort, `http://127.0.0.1:${routerPort}`)

    const result = await runCli(
      [
        'run',
        '--prompt',
        `Research the repository without modifying source files. Write the report to \`${outputPath}\`.`,
        '--auto-approve',
        '--json',
        '--config',
        configPath,
      ],
      runtimeDir,
      { HOME: isolatedHome },
      undefined,
      25_000,
    )

    expect(result.stderr).not.toContain('denied by headless approval policy')
    expect(readFileSync(outputPath, 'utf-8')).toBe('research complete\n')
    const json = JSON.parse(result.stdout.trim())
    expect(json.approval_denials).toEqual([])
    expect(json.tool_calls.map((call: { tool: string }) => call.tool)).toEqual(['bash', 'write'])
  }, CLI_SUBPROCESS_TEST_TIMEOUT_MS)

  it('run --auto-approve still rejects dangerous bash in isolated headless mode', async () => {
    const runtimeDir = makeRuntimeDir()
    const isolatedHome = makeRuntimeDir()
    const sentinelDir = makeRuntimeDir()
    const routerPort = await getFreePort()
    const proxyPort = await getFreePort()
    let callCount = 0

    await startFakeRouter(routerPort, (_req, body) => {
      callCount++
      const parsed = JSON.parse(body)
      if (callCount === 1) {
        return {
          id: 'fake-dangerous-bash',
          object: 'chat.completion',
          model: parsed.model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_dangerous_bash',
                type: 'function',
                function: { name: 'bash', arguments: JSON.stringify({ command: `rm -rf "${sentinelDir}"` }) },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }
      }

      expect(JSON.stringify(parsed.messages)).toContain('Tool execution denied by user.')
      return {
        id: 'fake-dangerous-final',
        object: 'chat.completion',
        model: parsed.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Dangerous command denied' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      }
    })
    const configPath = makeConfig(runtimeDir, proxyPort, `http://127.0.0.1:${routerPort}`)

    const result = await runCli(
      ['run', '--prompt', `Try deleting ${sentinelDir}.`, '--auto-approve', '--json', '--config', configPath],
      runtimeDir,
      { HOME: isolatedHome },
      undefined,
      25_000,
    )

    expect(result.code).toBe(1)
    expect(existsSync(sentinelDir)).toBe(true)
    expect(result.stderr).toContain('denied by headless approval policy')
    const json = JSON.parse(result.stdout.trim())
    expect(json.exit_code).toBe(1)
    expect(json.task_status).toBe('waiting_user')
    expect(json.approval_denials.some((denial: { toolName: string; reason: string; bashRiskLevel?: string }) =>
      denial.toolName === 'bash' && denial.reason === 'deny-bash-risk' && denial.bashRiskLevel === 'dangerous',
    )).toBe(true)
  }, CLI_SUBPROCESS_TEST_TIMEOUT_MS)

  it('run --json denies AskUserQuestion instead of blocking on stdin', async () => {
    const runtimeDir = makeRuntimeDir()
    const isolatedHome = makeRuntimeDir()
    const routerPort = await getFreePort()
    const proxyPort = await getFreePort()
    let callCount = 0

    await startFakeRouter(routerPort, (_req, body) => {
      callCount++
      const parsed = JSON.parse(body)
      if (callCount === 1) {
        return {
          id: 'fake-ask-user',
          object: 'chat.completion',
          model: parsed.model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_ask_user',
                type: 'function',
                function: {
                  name: 'AskUserQuestion',
                  arguments: JSON.stringify({
                    question: 'Proceed with the code change?',
                    options: [{ label: 'Proceed' }, { label: 'Stop' }],
                  }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }
      }

      expect(JSON.stringify(parsed.messages)).toContain('Tool execution denied by user.')
      return {
        id: 'fake-ask-user-final',
        object: 'chat.completion',
        model: parsed.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Question denied in headless mode; finishing without interaction.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      }
    })
    const configPath = makeConfig(runtimeDir, proxyPort, `http://127.0.0.1:${routerPort}`)

    const result = await runCli(
      ['run', '--prompt', 'ask before finishing', '--auto-approve', '--json', '--config', configPath],
      runtimeDir,
      { HOME: isolatedHome },
      undefined,
      25_000,
    )

    expect(result.code).toBe(1)
    expect(result.stdout).not.toContain('Enter number or type your answer')
    expect(result.stdout).not.toContain('Proceed with the code change?')
    expect(result.stderr).toContain('AskUserQuestion')
    expect(result.stderr).toContain('denied by headless approval policy')
    const json = JSON.parse(result.stdout.trim())
    expect(json.exit_code).toBe(1)
    expect(json.task_status).toBe('waiting_user')
    expect(json.text).toContain('Question denied in headless mode')
    expect(json.approval_denials).toContainEqual({
      toolName: 'AskUserQuestion',
      reason: 'deny-interactive',
    })
  }, CLI_SUBPROCESS_TEST_TIMEOUT_MS)

  it('run --auto-approve allows workspace-local test bash for code-change tasks', async () => {
    const runtimeDir = makeRuntimeDir()
    const isolatedHome = makeRuntimeDir()
    const routerPort = await getFreePort()
    const proxyPort = await getFreePort()
    let callCount = 0

    await startFakeRouter(routerPort, (_req, body) => {
      callCount++
      const parsed = JSON.parse(body)
      if (callCount === 1) {
        return {
          id: 'fake-workspace-test-bash',
          object: 'chat.completion',
          model: parsed.model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_workspace_test_bash',
                type: 'function',
                function: {
                  name: 'bash',
                  arguments: JSON.stringify({
                    command: `cd "${REPO_ROOT}" && python3 -m unittest --help 2>&1 | tail -n 1`,
                  }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }
      }

      expect(JSON.stringify(parsed.messages)).not.toContain('Tool execution denied by user.')
      return {
        id: 'fake-workspace-test-final',
        object: 'chat.completion',
        model: parsed.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Workspace test command was allowed' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      }
    })
    const configPath = makeConfig(runtimeDir, proxyPort, `http://127.0.0.1:${routerPort}`)

    const result = await runCli(
      ['run', '--prompt', 'Fix the failing tests by modifying source code in this repository.', '--auto-approve', '--json', '--config', configPath],
      runtimeDir,
      { HOME: isolatedHome },
      undefined,
      25_000,
    )

    expect(result.code).toBe(1)
    expect(result.stderr).not.toContain('denied by headless approval policy')
    const json = JSON.parse(result.stdout.trim())
    expect(json.exit_code).toBe(1)
    expect(json.task_status).toBe('drifted')
    expect(json.text).toContain('Workspace test command was allowed')
    expect(json.approval_denials).toEqual([])
    expect(json.tool_calls.some((call: { tool: string }) => call.tool === 'bash')).toBe(true)
  }, CLI_SUBPROCESS_TEST_TIMEOUT_MS)

  it('auto-resumes after a retryable runtime failure following tool results', async () => {
    const runtimeDir = makeRuntimeDir()
    const routerPort = await getFreePort()
    const proxyPort = await getFreePort()

    let callCount = 0
    await startFakeRouter(routerPort, (_req, body) => {
      callCount++
      const parsed = JSON.parse(body)
      if (callCount === 1) {
        return {
          id: 'fake-tool-before-failure',
          object: 'chat.completion',
          model: parsed.model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_runtime_retry',
                type: 'function',
                function: { name: 'bash', arguments: JSON.stringify({ command: 'echo retryable-tool-output' }) },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }
      }

      if (callCount >= 2 && callCount <= 3) {
        return {
          statusCode: 503,
          body: {
            error: {
              type: 'api_error',
              message: 'Server shutting down',
            },
          },
        }
      }

      expect(JSON.stringify(parsed.messages)).toContain('retryable-tool-output')
      return {
        id: 'fake-recovered',
        object: 'chat.completion',
        model: parsed.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Recovered after runtime failure' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      }
    })
    const configPath = makeConfig(runtimeDir, proxyPort, `http://127.0.0.1:${routerPort}`)
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    config.middleware = { retryMaxAttempts: 0, fallbackEnabled: false }
    writeFileSync(configPath, JSON.stringify(config, null, 2))

    const result = await runCli(
      ['run', '--prompt', 'run then survive one provider failure', '--auto-approve', '--json', '--config', configPath],
      runtimeDir,
      { OWLCODA_HEADLESS_RUNTIME_RESUME_RETRY_DELAY_MS: '0' },
      undefined,
      25_000,
    )

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('Continuing automatically')
    const json = JSON.parse(result.stdout.trim())
    expect(json.text).toContain('Recovered after runtime failure')
    expect(json.runtime_retries).toBe(1)
    expect(callCount).toBeGreaterThanOrEqual(4)
    expect(callCount).toBeLessThanOrEqual(5)

    const sessDir = join(runtimeDir, 'sessions')
    const files = readdirSync(sessDir).filter(f => f.endsWith('.json'))
    expect(files.length).toBe(1)
    const session = JSON.parse(readFileSync(join(sessDir, files[0]!), 'utf-8'))
    expect(session.turns.length).toBeGreaterThanOrEqual(4)
    expect(JSON.stringify(session.turns)).toContain('retryable-tool-output')
    expect(JSON.stringify(session.turns)).toContain('Recovered after runtime failure')
  }, CLI_SUBPROCESS_TEST_TIMEOUT_MS)

  it('tool loop persists assistant tool_use AND user tool_result to session', async () => {
    const runtimeDir = makeRuntimeDir()
    const routerPort = await getFreePort()
    const proxyPort = await getFreePort()

    let callCount = 0
    await startFakeRouter(routerPort, (_req, body) => {
      callCount++
      const parsed = JSON.parse(body)
      if (callCount === 1) {
        // First call: respond with tool_use
        return {
          id: 'fake-tool-1',
          object: 'chat.completion',
          model: parsed.model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_001',
                type: 'function',
                function: { name: 'Bash', arguments: JSON.stringify({ command: 'echo tool-output-xyz' }) },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }
      }
      // Second call: after tool result, respond with final text
      return {
        id: 'fake-tool-2',
        object: 'chat.completion',
        model: parsed.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Done processing tool output' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      }
    })
    const configPath = makeConfig(runtimeDir, proxyPort, `http://127.0.0.1:${routerPort}`)

    const result = await runCli(
      ['run', '--prompt', 'run a command', '--auto-approve', '--json', '--config', configPath],
      runtimeDir,
    )
    expect(result.code).toBe(0)
    const json = JSON.parse(result.stdout.trim())
    expect(json.text).toContain('Done processing tool output')
    expect(json.tool_calls.length).toBeGreaterThanOrEqual(1)
    expect(json.tool_calls[0].tool).toBe('Bash')

    // Verify session transcript completeness
    const sessDir = join(runtimeDir, 'sessions')
    const files = readdirSync(sessDir).filter(f => f.endsWith('.json'))
    expect(files.length).toBe(1)
    const session = JSON.parse(readFileSync(join(sessDir, files[0]!), 'utf-8'))

    // Expected transcript order (format uses 'turns', content is ContentBlock[]):
    // [0] user: "run a command"
    // [1] assistant: tool_use block
    // [2] user: tool_result block
    // [3] assistant: "Done processing tool output"
    expect(session.turns.length).toBe(4)
    expect(session.turns[0].role).toBe('user')
    expect(session.turns[0].content[0].text).toBe('run a command')
    expect(session.turns[1].role).toBe('assistant')
    // assistant tool_use content is ContentBlock[]
    expect(Array.isArray(session.turns[1].content)).toBe(true)
    expect(session.turns[2].role).toBe('user')
    // user tool_result content is tool_result blocks
    expect(Array.isArray(session.turns[2].content)).toBe(true)
    expect(session.turns[3].role).toBe('assistant')
  }, CLI_SUBPROCESS_TEST_TIMEOUT_MS)
})
