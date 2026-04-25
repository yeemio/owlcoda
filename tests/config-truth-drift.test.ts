/**
 * Tests for config truth drift fixes:
 *   1. paths.ts — unified config root with ~/.owlcoda canonical path
 *   2. admin.ts — reload-config applies all reloadable fields (models, responseModelStyle)
 *   3. health-monitor.ts — cloud endpoint models not marked unhealthy
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Fix 1: paths.ts — config root resolution ───

describe('paths.ts — unified config root', () => {
  const pathsSrc = readFileSync(join(__dirname, '..', 'src', 'paths.ts'), 'utf-8')

  it('uses ~/.owlcoda as the canonical config root', () => {
    const owlcodaIdx = pathsSrc.indexOf("'.owlcoda'")
    expect(owlcodaIdx).toBeGreaterThan(-1)
  })

  it('uses existsSync for config.json detection', () => {
    expect(pathsSrc).toContain('existsSync')
    expect(pathsSrc).toContain("'config.json'")
  })

  it('respects OWLCODA_HOME env override', () => {
    expect(pathsSrc).toContain("process.env['OWLCODA_HOME']")
  })

  it('exports getOwlcodaDirLabel for display', () => {
    expect(pathsSrc).toContain('export function getOwlcodaDirLabel')
  })
})

// ─── Fix 2: admin.ts — reload-config applies all reloadable fields ───

describe('admin.ts — reload-config uses shared applyReloadableFields', () => {
  const adminSrc = readFileSync(join(__dirname, '..', 'src', 'routes', 'admin.ts'), 'utf-8')
  const watcherSrc = readFileSync(join(__dirname, '..', 'src', 'config-watcher.ts'), 'utf-8')

  it('admin imports applyReloadableFields from config-watcher', () => {
    expect(adminSrc).toContain("import { applyReloadableFields } from '../config-watcher.js'")
  })

  it('handleReloadConfig calls applyReloadableFields', () => {
    expect(adminSrc).toContain('applyReloadableFields(config, parsed)')
  })

  it('config-watcher exports applyReloadableFields', () => {
    expect(watcherSrc).toContain('export function applyReloadableFields')
  })

  it('applyReloadableFields handles models', () => {
    expect(watcherSrc).toContain("applied.push(`models (${raw.models.length} entries)`)")
  })

  it('applyReloadableFields handles responseModelStyle', () => {
    expect(watcherSrc).toContain("applied.push('responseModelStyle')")
  })
})

// ─── Fix 3: health-monitor.ts — cloud endpoint models ───

describe('health-monitor.ts — cloud endpoint models not probed through local-runtime visibility surfaces', () => {
  const healthSrc = readFileSync(join(__dirname, '..', 'src', 'health-monitor.ts'), 'utf-8')

  it('skips probe for endpoint models', () => {
    // Should check model.endpoint and skip the probeModel call
    expect(healthSrc).toContain('if (model.endpoint)')
    expect(healthSrc).toContain('continue')
  })

  it('marks endpoint models as unknown (passive health)', () => {
    // Endpoint models get status: unknown, not unhealthy
    expect(healthSrc).toContain("status: 'unknown'")
  })

  it('only probes runtime-backed models through the shared runtime probe', () => {
    expect(healthSrc).toContain('probeRuntimeSurface(routerUrl, 5000)')
  })
})

// ─── Functional test: applyReloadableFields behavior ───

describe('applyReloadableFields — functional', () => {
  // Dynamic import to test actual behavior
  let applyReloadableFields: (config: any, raw: Record<string, unknown>) => string[]

  beforeEach(async () => {
    const mod = await import('../src/config-watcher.js')
    applyReloadableFields = mod.applyReloadableFields
  })

  it('applies models from raw config', () => {
    const config: any = {
      models: [],
      routerTimeoutMs: 5000,
      logLevel: 'info',
      middleware: {},
    }

    const raw = {
      models: [
        { id: 'test-model', backendModel: 'test-backend', provider: 'generic', default: true },
      ],
    }

    const applied = applyReloadableFields(config, raw)
    expect(applied).toContain('models (1 entries)')
    expect(config.models).toHaveLength(1)
    expect(config.models[0].id).toBe('test-model')
  })

  it('applies responseModelStyle', () => {
    const config: any = { responseModelStyle: 'upstream', middleware: {} }
    const raw = { responseModelStyle: 'platform' }
    const applied = applyReloadableFields(config, raw)
    expect(applied).toContain('responseModelStyle')
    expect(config.responseModelStyle).toBe('platform')
  })

  it('applies all fields admin previously missed', () => {
    const config: any = {
      models: [],
      routerTimeoutMs: 5000,
      logLevel: 'info',
      responseModelStyle: 'upstream',
      middleware: {},
      adminToken: 'old',
    }

    const raw = {
      routerTimeoutMs: 10000,
      logLevel: 'debug',
      responseModelStyle: 'platform',
      models: [{ id: 'm1', backendModel: 'b1', provider: 'generic', default: true }],
      adminToken: 'new-token',
    }

    const applied = applyReloadableFields(config, raw)
    expect(applied).toContain('routerTimeoutMs')
    expect(applied).toContain('logLevel')
    expect(applied).toContain('responseModelStyle')
    expect(applied).toContain('models (1 entries)')
    expect(applied).toContain('adminToken')
    expect(config.routerTimeoutMs).toBe(10000)
    expect(config.logLevel).toBe('debug')
    expect(config.responseModelStyle).toBe('platform')
    expect(config.models).toHaveLength(1)
    expect(config.adminToken).toBe('new-token')
  })
})

// ─── Functional test: health monitor skips cloud endpoints ───

describe('health-monitor — functional endpoint skip', () => {
  let resetHealthCache: () => void
  let startHealthMonitor: (config: any, interval?: number) => void
  let getModelHealth: (id: string) => any
  let stopHealthMonitor: () => void

  beforeEach(async () => {
    const mod = await import('../src/health-monitor.js')
    resetHealthCache = mod.resetHealthCache
    startHealthMonitor = mod.startHealthMonitor
    getModelHealth = mod.getModelHealth
    stopHealthMonitor = mod.stopHealthMonitor
    resetHealthCache()
  })

  afterEach(() => {
    stopHealthMonitor()
  })

  it('endpoint model gets status unknown, not unhealthy', async () => {
    const config = {
      routerUrl: 'http://127.0.0.1:99999', // deliberately unreachable
      models: [
        {
          id: 'cloud-model',
          backendModel: 'SomeCloudModel',
          provider: 'anthropic',
          endpoint: 'https://api.example.com/anthropic',
        },
      ],
    }

    // Start monitor with very long interval (we just want the initial check)
    startHealthMonitor(config, 999_999)

    // Wait a bit for the initial async check
    await new Promise(r => setTimeout(r, 200))

    const health = getModelHealth('cloud-model')
    // Cloud endpoint model should be 'unknown' (passive), NOT 'unhealthy'
    expect(health.status).toBe('unknown')
    expect(health.latencyMs).toBe(0) // no actual probe
  })
})
