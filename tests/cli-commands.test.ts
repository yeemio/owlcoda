/**
 * CLI command integration tests — doctor, config, init, version, help, logs.
 * These spawn the real CLI and verify output, no mocks.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = join(import.meta.dirname, '..')
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli.ts')

const runtimeDirs = new Set<string>()

function makeRuntimeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'owlcoda-cmd-'))
  runtimeDirs.add(dir)
  return dir
}

async function runCli(
  args: string[],
  runtimeDir: string,
  timeoutMs: number = 10000,
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

describe('CLI commands integration', { timeout: 30000 }, () => {
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

  it('doctor runs all checks', async () => {
    const runtimeDir = makeRuntimeDir()
    const result = await runCli(['doctor'], runtimeDir, 15000)
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
    const result = await runCli(['--dry-run'], runtimeDir, 15000)
    // Should show config + doctor output
    expect(result.stderr).toContain('owlcoda config')
    expect(result.stderr).toContain('owlcoda doctor')
    expect(result.stderr).toContain('Dry run')
  })
})
