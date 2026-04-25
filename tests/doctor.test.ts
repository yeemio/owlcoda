import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runDoctor, formatDoctorReport, type DoctorReport, type CheckResult } from '../src/doctor.js'
import { assessReplacementReadiness } from '../src/replacement-readiness.js'

const mockFetch = vi.fn()
let origFetch: typeof globalThis.fetch

beforeAll(() => {
  origFetch = globalThis.fetch
  globalThis.fetch = mockFetch as unknown as typeof fetch
})

afterAll(() => {
  globalThis.fetch = origFetch
})

describe('doctor module', { timeout: 15000 }, () => {
  it('runDoctor returns a DoctorReport with expected structure', async () => {
    const report = await runDoctor()
    expect(report).toHaveProperty('checks')
    expect(report).toHaveProperty('passCount')
    expect(report).toHaveProperty('warnCount')
    expect(report).toHaveProperty('failCount')
    expect(report).toHaveProperty('skipCount')
    expect(report).toHaveProperty('replacement')
    expect(Array.isArray(report.checks)).toBe(true)
    expect(report.checks.length).toBeGreaterThanOrEqual(5) // at minimum: node, tsx, config, launch, runtime health
  })

  it('each check has name, status, and detail', async () => {
    const report = await runDoctor()
    for (const c of report.checks) {
      expect(c).toHaveProperty('name')
      expect(c).toHaveProperty('status')
      expect(c).toHaveProperty('detail')
      expect(['pass', 'warn', 'fail', 'skip']).toContain(c.status)
      expect(typeof c.name).toBe('string')
      expect(typeof c.detail).toBe('string')
    }
  })

  it('counts are consistent with checks array', async () => {
    const report = await runDoctor()
    const pass = report.checks.filter(c => c.status === 'pass').length
    const warn = report.checks.filter(c => c.status === 'warn').length
    const fail = report.checks.filter(c => c.status === 'fail').length
    const skip = report.checks.filter(c => c.status === 'skip').length
    expect(report.passCount).toBe(pass)
    expect(report.warnCount).toBe(warn)
    expect(report.failCount).toBe(fail)
    expect(report.skipCount).toBe(skip)
    expect(pass + warn + fail + skip).toBe(report.checks.length)
  })

  it('Node.js check always passes in test env (we need v18+)', async () => {
    const report = await runDoctor()
    const nodeCheck = report.checks.find(c => c.name === 'Node.js')
    expect(nodeCheck).toBeDefined()
    expect(['pass', 'warn']).toContain(nodeCheck!.status) // test env is at least v18
  })

  it('Config check works with default path', async () => {
    const report = await runDoctor()
    const configCheck = report.checks.find(c => c.name === 'Config')
    expect(configCheck).toBeDefined()
    // Config may pass or fail depending on whether config.json exists
    expect(['pass', 'fail']).toContain(configCheck!.status)
  })

  it('Launch mode check is present', async () => {
    const report = await runDoctor()
    const launchCheck = report.checks.find(c => c.name === 'Launch mode')
    expect(launchCheck).toBeDefined()
  })

  it('formatDoctorReport produces readable output', () => {
    const report: DoctorReport = {
      checks: [
        { name: 'Node.js', status: 'pass', detail: 'v22.0.0 (>= v20 required)' },
        { name: 'tsx runtime', status: 'pass', detail: 'v4.19.0' },
        { name: 'Config', status: 'fail', detail: 'cannot load — file not found' },
      ],
      passCount: 2,
      warnCount: 0,
      failCount: 1,
      skipCount: 0,
      replacement: {
        verdict: 'not_yet_replaceable',
        blockers: ['example blocker'],
        strengths: [],
      },
    }
    const output = formatDoctorReport(report)
    expect(output).toContain('owlcoda doctor')
    expect(output).toContain('Node.js')
    expect(output).toContain('Config')
    expect(output).toContain('2 passed')
    expect(output).toContain('1 failed')
    expect(output).toContain('🔧')
    expect(output).toContain('Setup status')
    expect(output).toContain('✗ example blocker')
  })

  it('formatDoctorReport shows success when no failures', () => {
    const report: DoctorReport = {
      checks: [
        { name: 'Node.js', status: 'pass', detail: 'v22.0.0' },
        { name: 'Config', status: 'warn', detail: 'no models' },
      ],
      passCount: 1,
      warnCount: 1,
      failCount: 0,
      skipCount: 0,
      replacement: {
        verdict: 'not_yet_replaceable',
        blockers: ['example blocker'],
        strengths: [],
      },
    }
    const output = formatDoctorReport(report)
    expect(output).toContain('🎉')
    expect(output).toContain('1 passed')
    expect(output).toContain('1 warnings')
  })

  it('doctor always emits explicit replacement verdict and strengths', async () => {
    const report = await runDoctor()
    expect(['replaceable', 'not_yet_replaceable']).toContain(report.replacement.verdict)
    expect(report.replacement.strengths.length).toBeGreaterThan(0)
  })

  it('replacement readiness prefers Local runtime checks over legacy Router naming', () => {
    const readiness = assessReplacementReadiness([
      { name: 'Local runtime', status: 'pass', detail: 'http://127.0.0.1:8041 — openai_models' },
      { name: 'Model: qwen', status: 'pass', detail: 'healthy' },
    ])

    expect(readiness.verdict).toBe('replaceable')
    expect(readiness.blockers).toEqual([])
    expect(readiness.strengths).toContain('local runtime healthy — local model routing operational')
    expect(readiness.strengths).toContain('1 model backend(s) healthy')
  })

  it('doctor command is wired into parseArgs', async () => {
    const { parseArgs } = await import('../src/cli-core.js')
    const result = parseArgs(['node', 'owlcoda', 'doctor'])
    expect(result.command).toBe('doctor')
  })

  it('SearXNG check is present', async () => {
    const report = await runDoctor()
    const searxng = report.checks.find(c => c.name === 'SearXNG')
    expect(searxng).toBeDefined()
    // In test environment SearXNG may or may not be running
    expect(['pass', 'warn']).toContain(searxng!.status)
  })

  it('Skills check is present', async () => {
    const report = await runDoctor()
    const skills = report.checks.find(c => c.name === 'Skills')
    expect(skills).toBeDefined()
    expect(['pass', 'warn']).toContain(skills!.status)
  })

  it('Training data check is present', async () => {
    const report = await runDoctor()
    const training = report.checks.find(c => c.name === 'Training data')
    expect(training).toBeDefined()
    expect(['pass', 'warn', 'skip']).toContain(training!.status)
  })

  it('has at least 8 checks with new data pipeline checks', async () => {
    const report = await runDoctor()
    // Original 6 + SearXNG + Skills + Training data = 9 minimum
    expect(report.checks.length).toBeGreaterThanOrEqual(8)
  })

  it('router check accepts owlmlx runtime status surface', async () => {
    mockFetch.mockReset()
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        inventory: { model_count: 1 },
        health: { readiness: 'ready' },
        backend: { healthy: true },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }))

    const dir = mkdtempSync(join(tmpdir(), 'owlcoda-doctor-'))
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({
      host: '127.0.0.1',
      port: 8019,
      routerUrl: 'http://127.0.0.1:8041',
      routerTimeoutMs: 5000,
      logLevel: 'info',
      responseModelStyle: 'platform',
      models: [],
      middleware: {},
      modelMap: {},
      defaultModel: '',
      reverseMapInResponse: false,
    }))

    try {
      const report = await runDoctor(configPath)
      const runtimeCheck = report.checks.find(c => c.name === 'Local runtime')
      expect(runtimeCheck).toBeDefined()
      expect(runtimeCheck!.status).toBe('pass')
      expect(runtimeCheck!.detail).toContain('runtime_status')
      expect(runtimeCheck!.detail).toContain('ready')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
