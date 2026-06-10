/**
 * CLI integration tests for `owlcoda training` against a synthetic
 * OWLCODA_HOME. Spawns the real CLI to prove the report/export bugs from
 * 2026-04-26 are fixed end-to-end (not just at the helper layer).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = join(import.meta.dirname, '..')
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli.ts')

const runtimeDirs = new Set<string>()

function makeRuntimeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'owlcoda-training-cli-'))
  mkdirSync(join(dir, 'training'), { recursive: true })
  runtimeDirs.add(dir)
  return dir
}

function seed(dir: string, opts: { lines?: number; manifest?: Record<string, unknown> } = {}): void {
  const { lines = 3, manifest = {
    totalCollected: lines, totalSkipped: 12, averageQuality: 78,
    lastCollectedAt: '2026-04-23T06:24:16.221Z', qualitySum: lines * 78,
  }} = opts
  writeFileSync(join(dir, 'training', 'manifest.json'), JSON.stringify(manifest))
  let body = ''
  for (let i = 0; i < lines; i++) {
    body += JSON.stringify({ messages: [
      { role: 'user', content: `q${i}` },
      { role: 'assistant', content: `a${i}` },
    ]}) + '\n'
  }
  writeFileSync(join(dir, 'training', 'collected.jsonl'), body)
}

async function runCli(
  args: string[],
  runtimeDir: string,
  timeoutMs: number = 15000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI_ENTRY, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        OWLCODA_HOME: runtimeDir,
        OWLCODA_TRAINING_COLLECTION: '0',
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
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  runtimeDirs.clear()
})

describe('owlcoda training (CLI integration)', () => {
  it('status --json reports the seeded collected dataset', async () => {
    const dir = makeRuntimeDir()
    seed(dir, { lines: 5 })

    const result = await runCli(['training', 'status', '--json'], dir)
    expect(result.code).toBe(0)
    const json = JSON.parse(result.stdout)
    expect(json.totalCollected).toBe(5)
    expect(json.lineCount).toBe(5)
    expect(json.path).toContain('collected.jsonl')
  })

  it('report (default) reflects collected dataset, not 0 sessions', async () => {
    const dir = makeRuntimeDir()
    seed(dir, { lines: 7 })

    const result = await runCli(['training', 'report', '--json'], dir)
    expect(result.code).toBe(0)
    const json = JSON.parse(result.stdout)
    // Regression guard: previously this said totalSessions: 0 because it
    // scanned ~/.owlcoda/sessions/*.json instead of collected.jsonl.
    expect(json.source).toBe('collected')
    expect(json.totalCollected).toBe(7)
    expect(json.lineCount).toBe(7)
  })

  it('report --from-sessions still routes to historical analyzer', async () => {
    const dir = makeRuntimeDir()
    // No sessions seeded — historical mode should report "No sessions
    // directory found" and exit 0, NOT crash.
    const result = await runCli(['training', 'report', '--from-sessions'], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/No sessions directory found|Quality Report/)
  })

  it('export jsonl --limit N --sanitize reads collected dataset and exits 0', async () => {
    const dir = makeRuntimeDir()
    seed(dir, { lines: 10 })

    const result = await runCli(['training', 'export', 'jsonl', '--limit', '3', '--sanitize'], dir)
    expect(result.code).toBe(0)
    const lines = result.stdout.split('\n').filter(l => l.trim())
    expect(lines.length).toBe(3)
    for (const l of lines) {
      const parsed = JSON.parse(l)
      expect(Array.isArray(parsed.messages)).toBe(true)
    }
  })

  it('export jsonl does not crash on entries lacking SessionMeta.messageCount', async () => {
    // Direct regression for the original bug:
    //   "Cannot read properties of undefined (reading 'messageCount')"
    // Collected entries are bare {messages:[...]} objects with no SessionMeta.
    const dir = makeRuntimeDir()
    seed(dir, { lines: 4 })

    const result = await runCli(['training', 'export', 'jsonl', '--limit', '2'], dir)
    expect(result.code).toBe(0)
    expect(result.stderr).not.toMatch(/messageCount/)
    const lines = result.stdout.split('\n').filter(l => l.trim())
    expect(lines.length).toBe(2)
  })

  it('export sharegpt without --from-sessions errors with explicit hint', async () => {
    const dir = makeRuntimeDir()
    seed(dir, { lines: 2 })

    const result = await runCli(['training', 'export', 'sharegpt', '--limit', '1'], dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/--from-sessions/)
  })

  it('export jsonl when no collected data → fails fast with hint, no silent empty', async () => {
    const dir = makeRuntimeDir()
    // Don't seed.
    const result = await runCli(['training', 'export', 'jsonl', '--limit', '1'], dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/No collected training data found/)
  })

  it('path prints the resolved collected.jsonl path', async () => {
    const dir = makeRuntimeDir()
    const result = await runCli(['training', 'path'], dir)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(join(dir, 'training', 'collected.jsonl'))
  }, 15_000)
})
