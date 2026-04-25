/**
 * Tests for src/daemon.ts — daemon lifecycle, PID management, buildDaemonArgs.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildDaemonArgs,
  getBaseUrl,
  getMetaBaseUrl,
} from '../src/daemon.js'

// ─── buildDaemonArgs ───

describe('buildDaemonArgs', () => {
  it('produces minimal args when no overrides', () => {
    const args = buildDaemonArgs()
    expect(args).toContain('server')
    expect(args.length).toBeGreaterThanOrEqual(2)
  })

  it('includes --config when configPath provided', () => {
    const args = buildDaemonArgs('/tmp/test.toml')
    expect(args).toContain('--config')
    expect(args).toContain('/tmp/test.toml')
  })

  it('includes --port when port provided', () => {
    const args = buildDaemonArgs(undefined, 9999)
    expect(args).toContain('--port')
    expect(args).toContain('9999')
  })

  it('includes --router when routerUrl provided', () => {
    const args = buildDaemonArgs(undefined, undefined, 'http://localhost:11435/v1')
    expect(args).toContain('--router')
    expect(args).toContain('http://localhost:11435/v1')
  })

  it('includes all flags together', () => {
    const args = buildDaemonArgs('/tmp/c.toml', 8888, 'http://r:1234/v1')
    expect(args).toContain('--config')
    expect(args).toContain('/tmp/c.toml')
    expect(args).toContain('--port')
    expect(args).toContain('8888')
    expect(args).toContain('--router')
    expect(args).toContain('http://r:1234/v1')
  })
})

// ─── getBaseUrl / getMetaBaseUrl ───

describe('getBaseUrl', () => {
  it('builds URL from config host and port', () => {
    const config = { host: '127.0.0.1', port: 8019, routerUrl: 'x', models: new Map() }
    expect(getBaseUrl(config as any)).toBe('http://127.0.0.1:8019')
  })

  it('resolves wildcard host to 127.0.0.1', () => {
    const config = { host: '0.0.0.0', port: 8019, routerUrl: 'x', models: new Map() }
    expect(getBaseUrl(config as any)).toBe('http://127.0.0.1:8019')
  })
})

describe('getMetaBaseUrl', () => {
  it('builds URL from meta host and port', () => {
    expect(getMetaBaseUrl({ host: '127.0.0.1', port: 8019 })).toBe('http://127.0.0.1:8019')
  })

  it('resolves wildcard meta host', () => {
    expect(getMetaBaseUrl({ host: '::', port: 8019 })).toBe('http://127.0.0.1:8019')
  })
})

// ─── Module exports completeness ───

describe('daemon module exports', () => {
  it('exports all expected functions', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'daemon.ts'), 'utf-8')
    const expectedExports = [
      'writeRuntimeMeta', 'readRuntimeMeta', 'removeRuntimeMeta',
      'isPidAlive', 'readPid', 'writePid', 'removePid',
      'getMetaBaseUrl',
      'safeSendSignal',
      'buildDaemonArgs', 'spawnDaemon', 'getBaseUrl',
    ]
    const expectedAsyncExports = [
      'verifyManagedDaemon', 'stopAndWait', 'ensureProxyRunning',
    ]
    for (const fn of expectedExports) {
      expect(src).toContain(`export function ${fn}`)
    }
    for (const fn of expectedAsyncExports) {
      expect(src).toContain(`export async function ${fn}`)
    }
  })

  it('exports RuntimeMeta interface', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'daemon.ts'), 'utf-8')
    expect(src).toContain('export interface RuntimeMeta')
  })
})

// ─── SSE metrics endpoint declaration ───

describe('server SSE metrics endpoint', () => {
  it('server.ts declares /events/metrics SSE route', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf-8')
    expect(src).toContain("'/events/metrics'")
    expect(src).toContain('text/event-stream')
  })

  it('server.ts includes pricingNote in /v1/usage', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf-8')
    expect(src).toContain('pricingNote')
    expect(src).toContain('estimated_cloud_rates')
  })
})
