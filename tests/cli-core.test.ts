/**
 * Tests for cli-core.ts pure functions — parseArgs, printHelp, version, config loading.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs, printHelp, VERSION, loadEffectiveConfig, doLaunch, doUi } from '../src/cli-core.js'

describe('parseArgs', () => {
  const parse = (args: string[]) => parseArgs(['node', 'owlcoda', ...args])

  it('defaults to launch command with empty args', () => {
    const result = parse([])
    expect(result.command).toBe('launch')
    expect(result.passthroughArgs).toEqual([])
  })

  // ─── Commands ───

  it('parses --help', () => {
    expect(parse(['--help']).command).toBe('help')
  })

  it('parses -h', () => {
    expect(parse(['-h']).command).toBe('help')
  })

  it('parses --version', () => {
    expect(parse(['--version']).command).toBe('version')
  })

  it('parses -v', () => {
    expect(parse(['-v']).command).toBe('version')
  })

  const commands = [
    'server', 'start', 'stop', 'status', 'clients', 'run', 'serve',
    'doctor', 'ui', 'sessions', 'init', 'config', 'logs', 'completions',
    'models', 'benchmark', 'export', 'inspect', 'validate',
    'health', 'audit', 'cache', 'skills', 'training',
  ]

  for (const cmd of commands) {
    it(`parses "${cmd}" command`, () => {
      expect(parse([cmd]).command).toBe(cmd)
    })
  }

  // ─── Options ───

  it('parses --port with value', () => {
    const result = parse(['--port', '9000'])
    expect(result.port).toBe(9000)
  })

  it('parses --config / -c', () => {
    expect(parse(['--config', '/my/config.json']).configPath).toBe('/my/config.json')
    expect(parse(['-c', '/my/config.json']).configPath).toBe('/my/config.json')
  })

  it('parses --router / -r', () => {
    expect(parse(['--router', 'http://localhost:1234']).routerUrl).toBe('http://localhost:1234')
    expect(parse(['-r', 'http://localhost:1234']).routerUrl).toBe('http://localhost:1234')
  })

  it('parses --model / -m', () => {
    expect(parse(['--model', 'gpt-4']).model).toBe('gpt-4')
    expect(parse(['-m', 'gpt-4']).model).toBe('gpt-4')
  })

  it('parses --daemon-only', () => {
    expect(parse(['--daemon-only']).daemonOnly).toBe(true)
  })

  it('parses --prompt', () => {
    expect(parse(['--prompt', 'hello world']).prompt).toBe('hello world')
  })

  it('parses --json', () => {
    expect(parse(['--json']).jsonOutput).toBe(true)
  })

  it('parses --auto-approve', () => {
    expect(parse(['--auto-approve']).autoApprove).toBe(true)
  })

  it('parses --resume with value', () => {
    expect(parse(['--resume', 'abc-123']).resumeSession).toBe('abc-123')
  })

  it('parses --resume without value defaults to "last"', () => {
    expect(parse(['--resume']).resumeSession).toBe('last')
  })

  it('parses --force', () => {
    expect(parse(['--force']).force).toBe(true)
  })

  it('parses --dry-run', () => {
    expect(parse(['--dry-run']).dryRun).toBe(true)
  })

  it('parses admin alias as ui', () => {
    expect(parse(['admin']).command).toBe('ui')
  })

  it('parses --print-url', () => {
    const result = parse(['ui', '--print-url'])
    expect(result.command).toBe('ui')
    expect(result.printUrl).toBe(true)
  })

  it('parses --route, --select, and --view', () => {
    const result = parse(['ui', '--route', 'catalog', '--select', 'gpt-4.1', '--view', 'issues'])
    expect(result.command).toBe('ui')
    expect(result.route).toBe('catalog')
    expect(result.select).toBe('gpt-4.1')
    expect(result.view).toBe('issues')
  })

  it('parses --route start', () => {
    const result = parse(['ui', '--route', 'start'])
    expect(result.command).toBe('ui')
    expect(result.route).toBe('start')
  })

  // ─── Combined ───

  it('combines command with options', () => {
    const result = parse(['start', '--port', '8080', '--router', 'http://r:5000'])
    expect(result.command).toBe('start')
    expect(result.port).toBe(8080)
    expect(result.routerUrl).toBe('http://r:5000')
  })

  it('passes subcommand args after explicit command', () => {
    const result = parse(['training', 'status'])
    expect(result.command).toBe('training')
    expect(result.passthroughArgs).toEqual(['status'])
  })

  it('passes skills subcommand args', () => {
    const result = parse(['skills', 'show', 'my-skill'])
    expect(result.command).toBe('skills')
    expect(result.passthroughArgs).toEqual(['show', 'my-skill'])
  })

  // ─── -- separator ───

  it('treats everything after -- as passthroughArgs', () => {
    const result = parse(['start', '--', '--extra', 'flag'])
    expect(result.command).toBe('start')
    expect(result.passthroughArgs).toEqual(['--extra', 'flag'])
  })

  it('collects unknown args as passthroughArgs', () => {
    const result = parse(['--some-unknown-flag'])
    expect(result.passthroughArgs).toContain('--some-unknown-flag')
  })

  // ─── Multiple flags ───

  it('parses all flags together', () => {
    const result = parse([
      'run',
      '--model', 'test-model',
      '--prompt', 'test prompt',
      '--json',
      '--auto-approve',
    ])
    expect(result.command).toBe('run')
    expect(result.model).toBe('test-model')
    expect(result.prompt).toBe('test prompt')
    expect(result.jsonOutput).toBe(true)
    expect(result.autoApprove).toBe(true)
  })
})

describe('printHelp', () => {
  it('prints help text to stderr', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    printHelp()
    expect(spy).toHaveBeenCalledTimes(1)
    const output = spy.mock.calls[0]![0] as string
    expect(output).toContain('owlcoda')
    expect(output).toContain('Usage:')
    expect(output).toContain('Options:')
    expect(output).toContain('owlcoda clients')
    expect(output).toContain('owlcoda ui')
    expect(output).toContain('owlcoda admin')
    expect(output).toContain('--print-url')
    expect(output).toContain('--route')
    expect(output).toContain('--select')
    spy.mockRestore()
  })
})

describe('doLaunch', () => {
  const originalCwd = process.cwd()
  let workdir: string
  let configPath: string

  beforeEach(() => {
    workdir = mkdtempSync('/tmp/owlcoda-launch-')
    process.chdir(workdir)
    configPath = join(workdir, 'config.json')
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(workdir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function writeConfig(extra: Record<string, unknown> = {}) {
    writeFileSync(configPath, JSON.stringify({
      port: 18119,
      host: '127.0.0.1',
      routerUrl: 'http://127.0.0.1:18009',
      models: [
        {
          id: 'local-model',
          backendModel: 'local-backend',
          aliases: ['local'],
          default: true,
        },
      ],
      ...extra,
    }))
  }

  function launchDeps(overrides: Record<string, unknown> = {}) {
    return {
      runPreflight: vi.fn(async () => ({
        router: { name: 'Local runtime', url: 'http://127.0.0.1:18009', status: 'missing', detail: 'missing' },
        backends: [],
        overall: 'blocked',
        canProceed: false,
        summary: 'blocked',
      })),
      ensureProxyRunning: vi.fn(async () => ({ pid: 42, reused: false })),
      readRuntimeMeta: vi.fn(() => ({
        pid: 42,
        host: '127.0.0.1',
        port: 18119,
        routerUrl: 'http://127.0.0.1:18009',
        runtimeToken: 'runtime-token',
        version: '0.1.2',
        startedAt: '2026-04-25T00:00:00.000Z',
      })),
      getBaseUrl: vi.fn(() => 'http://127.0.0.1:18119'),
      doUi: vi.fn(async () => ({
        url: 'http://127.0.0.1:18119/admin/?token=t#/start',
        bundleAvailable: true,
        openedBrowser: false,
        context: { route: 'start' },
      })),
      createLiveReplClientId: vi.fn(() => 'client-1'),
      upsertLiveReplClient: vi.fn(),
      removeLiveReplClientIfOwned: vi.fn(),
      startNativeRepl: vi.fn(async () => {}),
      ...overrides,
    } as any
  }

  it('hands off to admin start when local preflight blocks first-run launch', async () => {
    writeConfig()
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const deps = launchDeps()

    await doLaunch(configPath, undefined, undefined, undefined, undefined, deps)

    expect(deps.runPreflight).toHaveBeenCalledTimes(1)
    expect(deps.doUi).toHaveBeenCalledWith(configPath, undefined, undefined, { route: 'start', openBrowser: true })
    expect(deps.ensureProxyRunning).not.toHaveBeenCalled()
    expect(deps.startNativeRepl).not.toHaveBeenCalled()
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Starting OwlCoda Admin'))
  })

  it('skips local preflight for direct endpoint model launch', async () => {
    writeConfig({
      models: [
        {
          id: 'cloud-model',
          backendModel: 'provider/model',
          aliases: ['cloud'],
          default: true,
          endpoint: 'https://example.test/v1/chat/completions',
          apiKey: 'test-key',
        },
      ],
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const deps = launchDeps()

    await doLaunch(configPath, undefined, undefined, undefined, undefined, deps)

    expect(deps.runPreflight).not.toHaveBeenCalled()
    expect(deps.ensureProxyRunning).toHaveBeenCalledTimes(1)
    expect(deps.startNativeRepl).toHaveBeenCalledWith(expect.objectContaining({
      apiBaseUrl: 'http://127.0.0.1:18119',
      model: 'cloud-model',
    }))
    expect(deps.doUi).not.toHaveBeenCalled()
  })
})

describe('doUi', () => {
  const originalCwd = process.cwd()
  let workdir: string

  beforeEach(() => {
    workdir = mkdtempSync('/tmp/owlcoda-ui-')
    process.chdir(workdir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(workdir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('prints only the admin URL in --print-url mode', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await doUi(undefined, undefined, undefined, { printUrl: true }, {
      ensureProxyRunning: vi.fn(async () => ({ pid: 1, reused: true })),
      readRuntimeMeta: vi.fn(() => ({ host: '127.0.0.1', port: 8019 })),
      getMetaBaseUrl: vi.fn(() => 'http://127.0.0.1:8019'),
      getBaseUrl: vi.fn(() => 'http://127.0.0.1:8019'),
      openUrlInBrowser: vi.fn(() => true),
      now: () => 1234,
      getAdminBundleStatus: () => ({ bundleDir: join(workdir, 'dist', 'admin'), indexPath: join(workdir, 'dist', 'admin', 'index.html'), available: false }),
    } as any)

    expect(result.url).toContain('/admin/?token=')
    expect(result.openedBrowser).toBe(false)
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('/admin/?token='))
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Admin bundle is not built yet'))
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('auth failed'))
  })

  it('opens the browser and prints URL when bundle exists', async () => {
    mkdirSync(join(workdir, 'dist', 'admin'), { recursive: true })
    writeFileSync(join(workdir, 'dist', 'admin', 'index.html'), '<!doctype html><title>admin</title>')

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const opener = vi.fn(() => true)

    const result = await doUi(undefined, undefined, undefined, { openBrowser: true }, {
      ensureProxyRunning: vi.fn(async () => ({ pid: 1, reused: true })),
      readRuntimeMeta: vi.fn(() => ({ host: '127.0.0.1', port: 8019 })),
      getMetaBaseUrl: vi.fn(() => 'http://127.0.0.1:8019'),
      getBaseUrl: vi.fn(() => 'http://127.0.0.1:8019'),
      openUrlInBrowser: opener,
      now: () => 5678,
      getAdminBundleStatus: () => ({
        bundleDir: join(workdir, 'dist', 'admin'),
        indexPath: join(workdir, 'dist', 'admin', 'index.html'),
        available: true,
      }),
    } as any)

    expect(result.bundleAvailable).toBe(true)
    expect(result.openedBrowser).toBe(true)
    expect(opener).toHaveBeenCalledWith(expect.stringContaining('/admin/?token='))
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Opened OwlCoda Admin'))
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Admin URL:'))
  })

  it('prints URL by default without opening a browser', async () => {
    mkdirSync(join(workdir, 'dist', 'admin'), { recursive: true })
    writeFileSync(join(workdir, 'dist', 'admin', 'index.html'), '<!doctype html><title>admin</title>')

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const opener = vi.fn(() => true)

    const result = await doUi(undefined, undefined, undefined, {}, {
      ensureProxyRunning: vi.fn(async () => ({ pid: 1, reused: true })),
      readRuntimeMeta: vi.fn(() => ({ host: '127.0.0.1', port: 8019 })),
      getMetaBaseUrl: vi.fn(() => 'http://127.0.0.1:8019'),
      getBaseUrl: vi.fn(() => 'http://127.0.0.1:8019'),
      openUrlInBrowser: opener,
      now: () => 2468,
      getAdminBundleStatus: () => ({
        bundleDir: join(workdir, 'dist', 'admin'),
        indexPath: join(workdir, 'dist', 'admin', 'index.html'),
        available: true,
      }),
    } as any)

    expect(result.openedBrowser).toBe(false)
    expect(opener).not.toHaveBeenCalled()
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('/admin/?token='))
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Browser auto-open is disabled by default'))
  })

  it('builds handoff URL with route/select/view context', async () => {
    mkdirSync(join(workdir, 'dist', 'admin'), { recursive: true })
    writeFileSync(join(workdir, 'dist', 'admin', 'index.html'), '<!doctype html><title>admin</title>')
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)

    const result = await doUi(undefined, undefined, undefined, {
      printUrl: true,
      route: 'aliases',
      select: 'kimi-code',
      view: 'issues',
    }, {
      ensureProxyRunning: vi.fn(async () => ({ pid: 1, reused: true })),
      readRuntimeMeta: vi.fn(() => ({ host: '127.0.0.1', port: 8019 })),
      getMetaBaseUrl: vi.fn(() => 'http://127.0.0.1:8019'),
      getBaseUrl: vi.fn(() => 'http://127.0.0.1:8019'),
      openUrlInBrowser: vi.fn(() => true),
      now: () => 9999,
      getAdminBundleStatus: () => ({
        bundleDir: join(workdir, 'dist', 'admin'),
        indexPath: join(workdir, 'dist', 'admin', 'index.html'),
        available: true,
      }),
    } as any)

    expect(result.context).toEqual({ route: 'aliases', select: 'kimi-code', view: 'issues' })
    expect(result.url).toContain('#/aliases?select=kimi-code&view=issues')
  })
})

describe('VERSION', () => {
  it('is a semver string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('loadEffectiveConfig', () => {
  it('returns a config object with overridden port', () => {
    const config = loadEffectiveConfig(undefined, 9999)
    expect(config.port).toBe(9999)
  })

  it('returns a config object with overridden routerUrl', () => {
    const config = loadEffectiveConfig(undefined, undefined, 'http://custom:5000')
    expect(config.routerUrl).toBe('http://custom:5000')
  })

  it('returns default values when no overrides', () => {
    const config = loadEffectiveConfig()
    expect(typeof config.port).toBe('number')
    expect(typeof config.routerUrl).toBe('string')
    expect(Array.isArray(config.models)).toBe(true)
  })
})
