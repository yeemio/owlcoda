/**
 * Daemon lifecycle management — spawn, verify, stop, coordinate OwlCoda background daemons.
 * Extracted from cli-core.ts for modularity.
 */

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { getOwlcodaDir, getOwlcodaPidPath, getOwlcodaRuntimeMetaPath } from './paths.js'
import { VERSION } from './version.js'
import type { OwlCodaConfig } from './config.js'
import {
  type HealthzResponse,
  resolveClientHost,
  fetchHealthz,
  healthzMatchesConfig,
  healthzMatchesRuntimeMeta,
  waitForVerifiedHealthz,
  waitForHealthzGone,
} from './healthz-client.js'
import { isPortAvailable } from './port-utils.js'

// ─── Runtime Meta ───

export interface RuntimeMeta {
  pid: number
  runtimeToken: string
  host: string
  port: number
  routerUrl: string
  version: string
  startedAt: string
}

// ─── Directory management ───

export function ensureOwlcodaDir(): void {
  const owlcodaDir = getOwlcodaDir()
  if (!existsSync(owlcodaDir)) mkdirSync(owlcodaDir, { recursive: true })
}

// ─── Runtime meta management ───

export function writeRuntimeMeta(meta: RuntimeMeta): void {
  ensureOwlcodaDir()
  writeFileSync(getOwlcodaRuntimeMetaPath(), JSON.stringify(meta, null, 2) + '\n', 'utf-8')
}

export function readRuntimeMeta(): RuntimeMeta | null {
  const runtimeMetaPath = getOwlcodaRuntimeMetaPath()
  if (!existsSync(runtimeMetaPath)) return null
  try {
    return JSON.parse(readFileSync(runtimeMetaPath, 'utf-8')) as RuntimeMeta
  } catch {
    return null
  }
}

export function removeRuntimeMeta(): void {
  const runtimeMetaPath = getOwlcodaRuntimeMetaPath()
  try { if (existsSync(runtimeMetaPath)) unlinkSync(runtimeMetaPath) } catch { /* ok */ }
}

// ─── PID management ───

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function readPid(): number | null {
  const pidFile = getOwlcodaPidPath()
  if (!existsSync(pidFile)) return null
  try {
    const raw = readFileSync(pidFile, 'utf-8').trim()
    const pid = parseInt(raw, 10)
    return isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

export function writePid(pid: number): void {
  ensureOwlcodaDir()
  writeFileSync(getOwlcodaPidPath(), String(pid), 'utf-8')
}

export function removePid(): void {
  const pidFile = getOwlcodaPidPath()
  try { if (existsSync(pidFile)) unlinkSync(pidFile) } catch { /* ok */ }
}

// ─── Daemon identity verification ───

export function getMetaBaseUrl(meta: Pick<RuntimeMeta, 'host' | 'port'>): string {
  return `http://${resolveClientHost(meta.host)}:${meta.port}`
}

export async function verifyManagedDaemon(meta: RuntimeMeta): Promise<HealthzResponse | null> {
  if (!isPidAlive(meta.pid)) return null
  const healthz = await fetchHealthz(getMetaBaseUrl(meta))
  if (!healthz) return null
  if (!healthzMatchesRuntimeMeta(healthz, meta)) return null
  return healthz
}

// ─── Daemon lifecycle ───

export function safeSendSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch (err) {
    // Return-false path used to be silent. If the signal couldn't be
    // delivered (permission denied / pid already reaped / wrong pid)
    // the caller loses track of an orphaned daemon that will silently
    // survive. Log to stderr so operators can see which process-lifecycle
    // expectation slipped. Stays return-false so callers can still branch
    // on "did it actually land" without change.
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`[daemon] safeSendSignal: failed to send ${signal} to pid ${pid}: ${reason}`)
    return false
  }
}

export async function stopAndWait(pid: number, baseUrl: string): Promise<void> {
  safeSendSignal(pid, 'SIGTERM')
  const gone = await waitForHealthzGone(baseUrl)
  if (!gone) {
    throw new Error(`Timed out waiting for OwlCoda daemon ${pid} to release ${baseUrl}`)
  }
  removePid()
  removeRuntimeMeta()
}

export function buildDaemonArgs(configPath?: string, port?: number, routerUrl?: string): string[] {
  const args = [process.argv[1]!, 'server']
  if (configPath) args.push('--config', configPath)
  if (port !== undefined) args.push('--port', String(port))
  if (routerUrl) args.push('--router', routerUrl)
  return args
}

export function spawnDaemon(
  config: OwlCodaConfig,
  configPath?: string,
  port?: number,
  routerUrl?: string,
): {
  pid: number
  runtimeToken: string
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
} {
  const childArgs = buildDaemonArgs(configPath, port, routerUrl)
  const runtimeToken = randomUUID()
  const fullArgs = [...process.execArgv, ...childArgs]
  const child = spawn(process.execPath, fullArgs, {
    argv0: process.argv0,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      OWLCODA_RUNTIME_TOKEN: runtimeToken,
    },
  })

  if (child.pid === undefined) {
    console.error('Failed to start background proxy')
    process.exit(1)
  }

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    child.once('error', () => resolve({ code: 1, signal: null }))
  })

  child.unref()
  const pid = child.pid
  writePid(pid)
  writeRuntimeMeta({
    pid,
    runtimeToken,
    host: config.host,
    port: config.port,
    routerUrl: config.routerUrl,
    version: VERSION,
    startedAt: new Date().toISOString(),
  })
  return { pid, runtimeToken, exitPromise }
}

export function getBaseUrl(config: { host: string; port: number }): string {
  return `http://${resolveClientHost(config.host)}:${config.port}`
}

/**
 * Unified daemon coordination — used by both start and launch.
 * 1. Check existing daemon via PID + healthz identity
 * 2. If matching config → reuse
 * 3. If mismatch → safe stop + restart
 * 4. If nothing running → start fresh
 * 5. Wait for healthz ready before returning
 */
export async function ensureProxyRunning(
  config: OwlCodaConfig,
  configPath?: string,
  port?: number,
  routerUrl?: string,
  options: { quiet?: boolean } = {},
): Promise<{ pid: number; reused: boolean }> {
  const baseUrl = getBaseUrl(config)
  const log = (message: string): void => {
    if (!options.quiet) console.error(message)
  }

  // 1. Check PID file + identity
  const existingPid = readPid()
  if (existingPid !== null) {
    const meta = readRuntimeMeta()
    if (!isPidAlive(existingPid)) {
      removePid()
      removeRuntimeMeta()
    } else if (meta && meta.pid === existingPid) {
      const healthz = await verifyManagedDaemon(meta)
      if (healthz && healthzMatchesConfig(healthz, config)) {
        return { pid: existingPid, reused: true }
      }
      if (healthz) {
        log(`Existing daemon (PID ${existingPid}) config mismatch — restarting`)
        await stopAndWait(existingPid, getMetaBaseUrl(meta))
      } else {
        log(`PID ${existingPid} alive but runtime metadata no longer matches a live OwlCoda daemon — clearing stale state`)
        removePid()
        removeRuntimeMeta()
      }
    } else {
      log(`PID ${existingPid} alive but runtime metadata missing or mismatched — clearing stale state without signaling`)
      removePid()
      removeRuntimeMeta()
    }
  }

  // 2. Probe target address for orphan daemon
  const orphanHealthz = await fetchHealthz(baseUrl)
  if (orphanHealthz && healthzMatchesConfig(orphanHealthz, config)) {
    log(`Found matching OwlCoda proxy at ${baseUrl} (no PID file)`)
    // Synthesize runtime.json from the orphan's healthz so downstream
    // readRuntimeMeta() calls succeed. Without this heal step the CLI
    // immediately errored with "Failed to resolve live REPL lease
    // metadata" and exited — user couldn't resume a session whenever
    // the daemon was alive but its runtime.json had been removed (e.g.
    // after a stop + fresh owlcoda, or a disk-level cleanup). A daemon
    // with a null runtimeToken can't be a trusted lease target, so we
    // fall through to the restart path for that case.
    if (orphanHealthz.runtimeToken !== null) {
      writeRuntimeMeta({
        pid: orphanHealthz.pid,
        runtimeToken: orphanHealthz.runtimeToken,
        host: orphanHealthz.host,
        port: orphanHealthz.port,
        routerUrl: orphanHealthz.routerUrl,
        version: orphanHealthz.version,
        startedAt: new Date().toISOString(),
      })
      return { pid: orphanHealthz.pid, reused: true }
    }
    log('Orphan daemon has no runtimeToken — cannot claim lease, restarting.')
    safeSendSignal(orphanHealthz.pid, 'SIGTERM')
    await waitForHealthzGone(baseUrl, 1000)
  }

  const targetPortAvailable = await isPortAvailable(config.port, resolveClientHost(config.host))
  if (!targetPortAvailable) {
    throw new Error(`Port ${config.port} is already in use by a non-OwlCoda process at ${baseUrl}`)
  }

  // 3. Start fresh
  const { pid, runtimeToken, exitPromise } = spawnDaemon(config, configPath, port, routerUrl)

  // 4. Wait for the exact daemon we spawned to become ready
  const readyState = await Promise.race([
    waitForVerifiedHealthz(
      baseUrl,
      healthz => ['ok', 'healthy', 'degraded', 'unhealthy'].includes(healthz.status) && healthz.pid === pid && healthz.runtimeToken === runtimeToken,
    ).then((healthz) => ({ kind: 'ready' as const, healthz })),
    exitPromise.then((exit) => ({ kind: 'exit' as const, exit })),
  ])

  if (readyState.kind === 'ready' && readyState.healthz) {
    return { pid, reused: false }
  }

  if (readyState.kind === 'exit') {
    removePid()
    removeRuntimeMeta()
    throw new Error(`OwlCoda daemon exited before becoming ready at ${baseUrl} (${formatDaemonExit(readyState.exit.code, readyState.exit.signal)})`)
  }

  safeSendSignal(pid, 'SIGTERM')
  await waitForHealthzGone(baseUrl, 1000)
  removePid()
  removeRuntimeMeta()
  throw new Error(`OwlCoda daemon failed to become ready at ${baseUrl}`)
}

function formatDaemonExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `signal ${signal}`
  if (code !== null) return `exit code ${code}`
  return 'unknown exit'
}
