import { describe, it, expect } from 'vitest'
import {
  resolveClientHost,
  getBaseUrl,
  loadEffectiveConfig,
  buildDaemonArgs,
  healthzMatchesConfig,
  healthzMatchesRuntimeMeta,
  parseArgs,
  VERSION,
} from '../src/cli-core.js'
import type { OwlCodaConfig } from '../src/config.js'
import type { RuntimeMeta } from '../src/cli-core.js'
import type { HealthzResponse } from '../src/cli-core.js'
import { writeFileSync, mkdirSync, rmSync, mkdtempSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const TEST_DIR = join(import.meta.dirname, '_fixtures_cli')

function makeConfig(overrides?: Partial<OwlCodaConfig>): OwlCodaConfig {
  return {
    port: 8019, host: '127.0.0.1', routerUrl: 'http://127.0.0.1:8009',
    routerTimeoutMs: 600000, logLevel: 'info' as const,
    models: [], responseModelStyle: 'platform',
    catalogLoaded: false,
    modelMap: {}, defaultModel: '', reverseMapInResponse: true,
    ...overrides,
  }
}

// ─── resolveClientHost ───

describe('resolveClientHost', () => {
  it('returns 127.0.0.1 for 0.0.0.0', () => {
    expect(resolveClientHost('0.0.0.0')).toBe('127.0.0.1')
  })

  it('returns 127.0.0.1 for ::', () => {
    expect(resolveClientHost('::')).toBe('127.0.0.1')
  })

  it('returns 127.0.0.1 for :::', () => {
    expect(resolveClientHost(':::')).toBe('127.0.0.1')
  })

  it('returns 127.0.0.1 for empty string', () => {
    expect(resolveClientHost('')).toBe('127.0.0.1')
  })

  it('returns 127.0.0.1 as-is', () => {
    expect(resolveClientHost('127.0.0.1')).toBe('127.0.0.1')
  })

  it('returns explicit IP as-is', () => {
    expect(resolveClientHost('192.168.1.100')).toBe('192.168.1.100')
  })

  it('returns hostname as-is', () => {
    expect(resolveClientHost('myhost.local')).toBe('myhost.local')
  })
})

// ─── getBaseUrl ───

describe('getBaseUrl', () => {
  it('uses resolved client host for 0.0.0.0', () => {
    const config = makeConfig({ host: '0.0.0.0', port: 8020 })
    expect(getBaseUrl(config)).toBe('http://127.0.0.1:8020')
  })

  it('uses explicit host when set', () => {
    const config = makeConfig({ host: '192.168.1.50', port: 8019 })
    expect(getBaseUrl(config)).toBe('http://192.168.1.50:8019')
  })

  it('default 127.0.0.1:8019', () => {
    const config = makeConfig()
    expect(getBaseUrl(config)).toBe('http://127.0.0.1:8019')
  })
})

// ─── buildDaemonArgs ───

describe('buildDaemonArgs', () => {
  it('always includes server subcommand', () => {
    const args = buildDaemonArgs()
    expect(args).toContain('server')
  })

  it('forwards --config', () => {
    const args = buildDaemonArgs('/path/to/config.json')
    expect(args).toContain('--config')
    expect(args).toContain('/path/to/config.json')
  })

  it('forwards --port', () => {
    const args = buildDaemonArgs(undefined, 8020)
    expect(args).toContain('--port')
    expect(args).toContain('8020')
  })

  it('forwards --router', () => {
    const args = buildDaemonArgs(undefined, undefined, 'http://other:9009')
    expect(args).toContain('--router')
    expect(args).toContain('http://other:9009')
  })

  it('forwards all three together', () => {
    const args = buildDaemonArgs('/cfg.json', 9999, 'http://r:1')
    expect(args).toContain('server')
    expect(args).toContain('--config')
    expect(args).toContain('/cfg.json')
    expect(args).toContain('--port')
    expect(args).toContain('9999')
    expect(args).toContain('--router')
    expect(args).toContain('http://r:1')
  })
})

// ─── healthzMatchesConfig ───

describe('healthzMatchesConfig', () => {
  it('returns true when port, host, and routerUrl match', () => {
    const healthz: HealthzResponse = { status: 'ok', version: '0.3.3', pid: 100, runtimeToken: 'rt-1', host: '127.0.0.1', port: 8019, routerUrl: 'http://127.0.0.1:8009' }
    const config = makeConfig({ port: 8019, routerUrl: 'http://127.0.0.1:8009' })
    expect(healthzMatchesConfig(healthz, config)).toBe(true)
  })

  it('returns false when port differs', () => {
    const healthz: HealthzResponse = { status: 'ok', version: '0.3.3', pid: 100, runtimeToken: 'rt-1', host: '127.0.0.1', port: 8019, routerUrl: 'http://127.0.0.1:8009' }
    const config = makeConfig({ port: 8020, routerUrl: 'http://127.0.0.1:8009' })
    expect(healthzMatchesConfig(healthz, config)).toBe(false)
  })

  it('returns false when routerUrl differs', () => {
    const healthz: HealthzResponse = { status: 'ok', version: '0.3.3', pid: 100, runtimeToken: 'rt-1', host: '127.0.0.1', port: 8019, routerUrl: 'http://127.0.0.1:8009' }
    const config = makeConfig({ port: 8019, routerUrl: 'http://other:9009' })
    expect(healthzMatchesConfig(healthz, config)).toBe(false)
  })

  it('returns false when both differ', () => {
    const healthz: HealthzResponse = { status: 'ok', version: '0.3.3', pid: 100, runtimeToken: 'rt-1', host: '127.0.0.1', port: 8019, routerUrl: 'http://127.0.0.1:8009' }
    const config = makeConfig({ port: 9999, routerUrl: 'http://x:1' })
    expect(healthzMatchesConfig(healthz, config)).toBe(false)
  })

  it('returns true when wildcard hosts normalize to same client host', () => {
    const healthz: HealthzResponse = { status: 'ok', version: '0.3.3', pid: 100, runtimeToken: 'rt-1', host: '0.0.0.0', port: 8019, routerUrl: 'http://127.0.0.1:8009' }
    const config = makeConfig({ host: '::', port: 8019, routerUrl: 'http://127.0.0.1:8009' })
    expect(healthzMatchesConfig(healthz, config)).toBe(true)
  })

  it('returns false when host mismatch (explicit vs wildcard)', () => {
    const healthz: HealthzResponse = { status: 'ok', version: '0.3.3', pid: 100, runtimeToken: 'rt-1', host: '192.168.1.100', port: 8019, routerUrl: 'http://127.0.0.1:8009' }
    const config = makeConfig({ host: '0.0.0.0', port: 8019, routerUrl: 'http://127.0.0.1:8009' })
    expect(healthzMatchesConfig(healthz, config)).toBe(false)
  })

  it('returns true when both use same explicit host', () => {
    const healthz: HealthzResponse = { status: 'ok', version: '0.3.3', pid: 100, runtimeToken: 'rt-1', host: '10.0.0.5', port: 8019, routerUrl: 'http://127.0.0.1:8009' }
    const config = makeConfig({ host: '10.0.0.5', port: 8019, routerUrl: 'http://127.0.0.1:8009' })
    expect(healthzMatchesConfig(healthz, config)).toBe(true)
  })
})

// ─── healthzMatchesRuntimeMeta ───

describe('healthzMatchesRuntimeMeta', () => {
  const meta: RuntimeMeta = {
    pid: 4242,
    runtimeToken: 'rt-4242',
    host: '0.0.0.0',
    port: 8019,
    routerUrl: 'http://127.0.0.1:8009',
    version: '0.3.3',
    startedAt: '2026-04-02T00:00:00.000Z',
  }

  it('returns true when pid, token, and normalized config all match', () => {
    const healthz: HealthzResponse = {
      status: 'ok',
      version: '0.3.3',
      pid: 4242,
      runtimeToken: 'rt-4242',
      host: '::',
      port: 8019,
      routerUrl: 'http://127.0.0.1:8009',
    }
    expect(healthzMatchesRuntimeMeta(healthz, meta)).toBe(true)
  })

  it('returns false when pid differs', () => {
    const healthz: HealthzResponse = {
      status: 'ok',
      version: '0.3.3',
      pid: 9999,
      runtimeToken: 'rt-4242',
      host: '0.0.0.0',
      port: 8019,
      routerUrl: 'http://127.0.0.1:8009',
    }
    expect(healthzMatchesRuntimeMeta(healthz, meta)).toBe(false)
  })

  it('returns false when runtime token differs', () => {
    const healthz: HealthzResponse = {
      status: 'ok',
      version: '0.3.3',
      pid: 4242,
      runtimeToken: 'rt-other',
      host: '0.0.0.0',
      port: 8019,
      routerUrl: 'http://127.0.0.1:8009',
    }
    expect(healthzMatchesRuntimeMeta(healthz, meta)).toBe(false)
  })
})

// ─── loadEffectiveConfig ───

describe('loadEffectiveConfig', () => {
  beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }))
  afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }))

  it('applies port override', () => {
    const cfgFile = join(TEST_DIR, 'eff1.json')
    writeFileSync(cfgFile, JSON.stringify({ port: 8019 }))
    const config = loadEffectiveConfig(cfgFile, 9090)
    expect(config.port).toBe(9090)
  })

  it('applies routerUrl override', () => {
    const cfgFile = join(TEST_DIR, 'eff2.json')
    writeFileSync(cfgFile, JSON.stringify({ routerUrl: 'http://a:1' }))
    const config = loadEffectiveConfig(cfgFile, undefined, 'http://b:2')
    expect(config.routerUrl).toBe('http://b:2')
  })

  it('preserves file values when no overrides', () => {
    const cfgFile = join(TEST_DIR, 'eff3.json')
    writeFileSync(cfgFile, JSON.stringify({ port: 7777, routerUrl: 'http://c:3' }))
    const config = loadEffectiveConfig(cfgFile)
    expect(config.port).toBe(7777)
    expect(config.routerUrl).toBe('http://c:3')
  })
})

// ─── parseArgs ───

describe('parseArgs', () => {
  it('defaults to launch command', () => {
    const result = parseArgs(['node', 'cli.js'])
    expect(result.command).toBe('launch')
  })

  it('parses start command', () => {
    const result = parseArgs(['node', 'cli.js', 'start'])
    expect(result.command).toBe('start')
  })

  it('parses server command', () => {
    const result = parseArgs(['node', 'cli.js', 'server'])
    expect(result.command).toBe('server')
  })

  it('parses --port', () => {
    const result = parseArgs(['node', 'cli.js', '--port', '9090'])
    expect(result.port).toBe(9090)
  })

  it('parses --config', () => {
    const result = parseArgs(['node', 'cli.js', '--config', '/a/b.json'])
    expect(result.configPath).toBe('/a/b.json')
  })

  it('parses --router', () => {
    const result = parseArgs(['node', 'cli.js', '--router', 'http://x:1'])
    expect(result.routerUrl).toBe('http://x:1')
  })

  it('parses --daemon-only', () => {
    const result = parseArgs(['node', 'cli.js', '--daemon-only'])
    expect(result.daemonOnly).toBe(true)
  })

  it('passes args after -- to passthroughArgs', () => {
    const result = parseArgs(['node', 'cli.js', '--', '-p', 'my prompt'])
    expect(result.passthroughArgs).toEqual(['-p', 'my prompt'])
  })

  it('parses run command', () => {
    const result = parseArgs(['node', 'cli.js', 'run'])
    expect(result.command).toBe('run')
  })

  it('parses --prompt', () => {
    const result = parseArgs(['node', 'cli.js', 'run', '--prompt', 'explain this'])
    expect(result.command).toBe('run')
    expect(result.prompt).toBe('explain this')
  })

  it('parses --json flag', () => {
    const result = parseArgs(['node', 'cli.js', 'run', '--json'])
    expect(result.jsonOutput).toBe(true)
  })

  it('parses --auto-approve flag', () => {
    const result = parseArgs(['node', 'cli.js', 'run', '--auto-approve'])
    expect(result.autoApprove).toBe(true)
  })

  it('parses --resume with explicit ID', () => {
    const result = parseArgs(['node', 'cli.js', '--resume', '20260101-abc123'])
    expect(result.resumeSession).toBe('20260101-abc123')
  })

  it('--resume without value defaults to "last"', () => {
    const result = parseArgs(['node', 'cli.js', '--resume'])
    expect(result.resumeSession).toBe('last')
  })

  it('new flags default to undefined/false', () => {
    const result = parseArgs(['node', 'cli.js'])
    expect(result.prompt).toBeUndefined()
    expect(result.jsonOutput).toBe(false)
    expect(result.autoApprove).toBe(false)
    expect(result.resumeSession).toBeUndefined()
  })

  it('parses sessions command', () => {
    const result = parseArgs(['node', 'cli.js', 'sessions'])
    expect(result.command).toBe('sessions')
  })

  it('subcommand args do not override command (training status bug)', () => {
    const r1 = parseArgs(['node', 'cli.js', 'training', 'status'])
    expect(r1.command).toBe('training')
    expect(r1.passthroughArgs).toContain('status')

    const r2 = parseArgs(['node', 'cli.js', 'skills', 'search', 'test'])
    expect(r2.command).toBe('skills')
    expect(r2.passthroughArgs).toEqual(['search', 'test'])

    const r3 = parseArgs(['node', 'cli.js', 'training', 'clear', '--json'])
    expect(r3.command).toBe('training')
    expect(r3.passthroughArgs).toContain('clear')
    expect(r3.jsonOutput).toBe(true)
  })
})

// ─── Import safety ───

describe('import safety', () => {
  it('cli-core.ts exports VERSION', () => {
    expect(typeof VERSION).toBe('string')
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('importing cli-core.ts does not trigger main()', async () => {
    // If this test runs at all, the import didn't call process.exit or spawn processes
    const mod = await import('../src/cli-core.js')
    expect(typeof mod.main).toBe('function')
    expect(typeof mod.resolveClientHost).toBe('function')
    expect(typeof mod.parseArgs).toBe('function')
  })

  it('importing cli.ts entry shell does not execute main()', async () => {
    const mod = await import('../src/cli.js')
    expect(mod).toBeDefined()
  })

  it('isDirectCliEntry treats a symlinked bin path as direct execution', async () => {
    const mod = await import('../src/cli.js')
    const cliPath = join(import.meta.dirname, '..', 'src', 'cli.ts')
    const tempDir = mkdtempSync(join(tmpdir(), 'owlcoda-cli-'))
    const symlinkPath = join(tempDir, 'owlcoda')
    symlinkSync(cliPath, symlinkPath)

    expect(mod.isDirectCliEntry(pathToFileURL(cliPath).href, symlinkPath)).toBe(true)
  })

  it('isDirectCliEntry stays false for unrelated argv[1]', async () => {
    const mod = await import('../src/cli.js')
    const cliPath = join(import.meta.dirname, '..', 'src', 'cli.ts')
    expect(mod.isDirectCliEntry(pathToFileURL(cliPath).href, '/tmp/not-owlcoda.js')).toBe(false)
  })
})

import { beforeAll, afterAll } from 'vitest'
