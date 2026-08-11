/**
 * Daemon lifecycle management — spawn, verify, stop, coordinate OwlCoda background daemons.
 * Extracted from cli-core.ts for modularity.
 */

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, statSync, renameSync, writeSync, rmSync, type Stats } from 'node:fs'
import { getOwlcodaDaemonStartLockPath, getOwlcodaDir, getOwlcodaPidPath, getOwlcodaRuntimeMetaPath, getOwlcodaDaemonLogPath } from './paths.js'
import { VERSION } from './version.js'
import type { OwlCodaConfig } from './config.js'
import {
  type HealthzResponse,
  resolveClientHost,
  fetchHealthz,
  healthzMatchesConfig,
  healthzIdentifiesRuntimeMetaForRetirement,
  healthzMatchesRuntimeMeta,
  waitForVerifiedHealthz,
  waitForHealthzGone,
} from './healthz-client.js'
import { isPortAvailable } from './port-utils.js'
import { getActiveLiveReplClientsForRuntime } from './repl-lease.js'
import { isLaunchdServiceInstalled, kickstartLaunchdService } from './service-launchd.js'

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

export interface StaleDaemonVersionInfo {
  daemonVersion: string
  cliVersion: string
  activeClientCount: number
}

export interface EnsureProxyRunningResult {
  pid: number
  reused: boolean
  staleDaemon?: StaleDaemonVersionInfo
}

export type DaemonVersionPolicyAction =
  | 'reuse_current'
  | 'restart_idle_stale'
  | 'reuse_active_stale'

export interface DaemonVersionPolicyDecision {
  action: DaemonVersionPolicyAction
  stale: boolean
  daemonVersion?: string
  cliVersion: string
  activeClientCount: number
}

// ─── Directory management ───

export function ensureOwlcodaDir(): void {
  const owlcodaDir = getOwlcodaDir()
  if (!existsSync(owlcodaDir)) mkdirSync(owlcodaDir, { recursive: true, mode: 0o700 })
  restrictOwnedPathPermissions(owlcodaDir, 0o700, 'directory')
}

// ─── Runtime meta management ───

export function writeRuntimeMeta(meta: RuntimeMeta): void {
  ensureOwlcodaDir()
  const runtimeMetaPath = getOwlcodaRuntimeMetaPath()
  const temporaryPath = `${runtimeMetaPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryPath, JSON.stringify(meta, null, 2) + '\n', {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    })
    restrictOwnedPathPermissions(temporaryPath, 0o600, 'file')
    renameSync(temporaryPath, runtimeMetaPath)
    restrictOwnedPathPermissions(runtimeMetaPath, 0o600, 'file')
  } catch (error) {
    try { if (existsSync(temporaryPath)) unlinkSync(temporaryPath) } catch { /* preserve original error */ }
    throw error
  }
}

export function readRuntimeMeta(): RuntimeMeta | null {
  const runtimeMetaPath = getOwlcodaRuntimeMetaPath()
  if (!existsSync(runtimeMetaPath)) return null
  try {
    ensureOwlcodaDir()
    restrictOwnedPathPermissions(runtimeMetaPath, 0o600, 'file')
    return JSON.parse(readFileSync(runtimeMetaPath, 'utf-8')) as RuntimeMeta
  } catch {
    return null
  }
}

function restrictOwnedPathPermissions(
  path: string,
  mode: number,
  expectedType: 'directory' | 'file',
): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link at protected OwlCoda path: ${path}`)
  if (expectedType === 'directory' ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`Protected OwlCoda path is not a ${expectedType}: ${path}`)
  }
  const currentUid = process.getuid?.()
  if (currentUid === undefined) return
  if (stat.uid !== currentUid) throw new Error(`Protected OwlCoda path is not owned by the current user: ${path}`)
  chmodSync(path, mode)
  if ((lstatSync(path).mode & 0o777) !== mode) {
    throw new Error(`Unable to enforce protected OwlCoda path permissions: ${path}`)
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
  const healthz = await fetchHealthz(getMetaBaseUrl(meta), 2000, meta.runtimeToken)
  if (!healthz) return null
  if (!healthzMatchesRuntimeMeta(healthz, meta)) return null
  return healthz
}

export function decideDaemonVersionPolicy(
  daemonVersion: string | undefined,
  activeClientCount: number,
  cliVersion: string = VERSION,
): DaemonVersionPolicyDecision {
  const normalizedDaemonVersion = daemonVersion?.trim()
  const safeActiveClientCount = Math.max(0, activeClientCount)
  if (!normalizedDaemonVersion || normalizedDaemonVersion === cliVersion) {
    return {
      action: 'reuse_current',
      stale: false,
      daemonVersion: normalizedDaemonVersion,
      cliVersion,
      activeClientCount: safeActiveClientCount,
    }
  }
  return {
    action: safeActiveClientCount > 0 ? 'reuse_active_stale' : 'restart_idle_stale',
    stale: true,
    daemonVersion: normalizedDaemonVersion,
    cliVersion,
    activeClientCount: safeActiveClientCount,
  }
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

/** Build the port-in-use error. When `holderPid` is non-null the port is held
 *  by an OwlCoda daemon (identified via /healthz, an OwlCoda-only endpoint) —
 *  surface it as a stale daemon with a stop hint instead of mislabeling it a
 *  "non-OwlCoda process" (the Windows orphan-daemon symptom). */
export function buildPortInUseMessage(port: number, baseUrl: string, holderPid: number | null): string {
  // Recovery pointers for the recurring ":9999 won't start" support case —
  // where to look (log) and how to inspect (service status). Kept to one short
  // line so the message stays a hint, not a noise wall.
  const recoveryHint = `Logs: ${getOwlcodaDaemonLogPath()} · status: \`owlcoda service status\`.`
  if (holderPid !== null) {
    return (
      `Port ${port} is held by a stale OwlCoda daemon (PID ${holderPid}) at ${baseUrl}. ` +
      'Run `owlcoda stop --force` to clear it, then start OwlCoda again. ' +
      recoveryHint
    )
  }
  return (
    `Port ${port} is already in use by a non-OwlCoda process at ${baseUrl}. ` +
    'If you believe this is a stale OwlCoda daemon, run `owlcoda stop --force`. ' +
    recoveryHint
  )
}

/** Injectable IO for forceStopOrphanDaemon (real impls by default; fakes in tests). */
export interface OrphanStopIO {
  fetchHealthz: (baseUrl: string, timeoutMs?: number, runtimeToken?: string) => Promise<HealthzResponse | null>
  readRuntimeMeta: () => RuntimeMeta | null
  signal: (pid: number, sig: NodeJS.Signals) => boolean
  waitGone: (baseUrl: string, timeoutMs?: number) => Promise<boolean>
  isAlive: (pid: number) => boolean
}

/** Stop an orphan OwlCoda daemon that has no PID file only when host-owned
 *  runtime metadata authenticates the detailed /healthz response. */
export async function forceStopOrphanDaemon(baseUrl: string, io: Partial<OrphanStopIO> = {}): Promise<number | null> {
  const fetchH = io.fetchHealthz ?? fetchHealthz
  const readMeta = io.readRuntimeMeta ?? readRuntimeMeta
  const signal = io.signal ?? safeSendSignal
  const waitGone = io.waitGone ?? waitForHealthzGone
  const alive = io.isAlive ?? isPidAlive
  const runtimeMeta = readMeta()
  if (!runtimeMeta) return null
  const healthz = await fetchH(baseUrl, 2000, runtimeMeta.runtimeToken)
  if (!healthz || !healthzIdentifiesRuntimeMetaForRetirement(healthz, runtimeMeta)) return null
  const pid = runtimeMeta.pid
  if (!signal(pid, 'SIGTERM')) {
    throw new Error(`failed to send SIGTERM to orphan OwlCoda daemon PID ${pid}`)
  }
  const gone = await waitGone(baseUrl, 3000)
  if (gone || !alive(pid)) return pid
  if (!signal(pid, 'SIGKILL')) {
    throw new Error(`failed to send SIGKILL to orphan OwlCoda daemon PID ${pid}`)
  }
  const killed = await waitGone(baseUrl, 2000)
  if (!killed && alive(pid)) {
    throw new Error(`orphan OwlCoda daemon PID ${pid} did not exit after SIGKILL`)
  }
  return pid
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

// ─── Daemon self-registration (launchd) ───

/**
 * True when this server was launched directly by launchd (the plist sets
 * OWLCODA_LAUNCHD=1) rather than spawned by spawnDaemon (which writes the
 * pid-file from the parent). Only the launchd case must self-register.
 */
export function shouldSelfRegisterDaemon(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['OWLCODA_LAUNCHD'] === '1'
}

/** Rotate the install seed before components that derive auth from the runtime identity are built. */
export function rotateLaunchdRuntimeToken(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!shouldSelfRegisterDaemon(env)) return null
  const installSeed = env['OWLCODA_RUNTIME_TOKEN']
  if (!installSeed) return null
  const processRuntimeToken = randomUUID()
  env['OWLCODA_RUNTIME_TOKEN'] = processRuntimeToken
  return processRuntimeToken
}

/**
 * Register this process's pid + runtime-meta so clients can discover a
 * launchd-managed daemon (there is no spawnDaemon parent to do it). The plist
 * provides an install-scoped seed, but each supervised process rotates it so a
 * recovered PID cannot inherit the previous runtime identity. The generated
 * token is written back to the environment before server healthz is served, so
 * healthzMatchesRuntimeMeta sees the same per-process identity.
 */
export function selfRegisterDaemon(
  config: OwlCodaConfig,
  pid: number = process.pid,
  env: NodeJS.ProcessEnv = process.env,
  options: { rotateToken?: boolean } = {},
): boolean {
  if (!shouldSelfRegisterDaemon(env)) return false
  const processRuntimeToken = options.rotateToken === false
    ? env['OWLCODA_RUNTIME_TOKEN'] ?? null
    : rotateLaunchdRuntimeToken(env)
  if (!processRuntimeToken) {
    console.error('[owlcoda] OWLCODA_LAUNCHD set but OWLCODA_RUNTIME_TOKEN missing — skipping self-registration')
    return false
  }
  writePid(pid)
  writeRuntimeMeta({
    pid,
    runtimeToken: processRuntimeToken,
    host: config.host,
    port: config.port,
    routerUrl: config.routerUrl,
    version: VERSION,
    startedAt: new Date().toISOString(),
  })
  return true
}

// ─── Daemon log capture (forensics) ───

const DAEMON_LOG_MAX_BYTES = 5 * 1024 * 1024 // 5 MB, then one backup generation

/**
 * If the daemon log has grown past maxBytes, move it aside to `<path>.1`
 * (single-generation rotation) so the next open('a') starts fresh. No-op when
 * the log is missing or under the cap. Best-effort — never blocks daemon start.
 */
export function rotateDaemonLogIfOversized(logPath: string, maxBytes = DAEMON_LOG_MAX_BYTES): void {
  try {
    if (!existsSync(logPath)) return
    if (statSync(logPath).size <= maxBytes) return
    renameSync(logPath, logPath + '.1')
  } catch {
    /* rotation is best-effort */
  }
}

/**
 * Resolve the stdio for spawning the daemon so its stdout/stderr land in
 * ~/.owlcoda/daemon.log — giving an uncaughtException/OOM crash a forensic
 * trail (today's stdio:'ignore' sends it to /dev/null). Returns the open fd so
 * the caller closes its copy after spawn (the detached child inherits its own).
 * Degrades to 'ignore' (today's behavior) if the log can't be opened — the
 * daemon must still start.
 */
export function openDaemonLogStdio(): { stdio: 'ignore' | ['ignore', number, number]; logFd?: number } {
  try {
    ensureOwlcodaDir()
    const logPath = getOwlcodaDaemonLogPath()
    rotateDaemonLogIfOversized(logPath)
    const logFd = openSync(logPath, 'a')
    return { stdio: ['ignore', logFd, logFd], logFd }
  } catch (err) {
    console.error(`[owlcoda] could not open daemon.log (daemon logs will be discarded): ${(err as Error).message}`)
    return { stdio: 'ignore' }
  }
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
  const { stdio, logFd } = openDaemonLogStdio()
  if (logFd !== undefined) {
    try {
      writeSync(logFd, `\n===== owlcoda daemon starting v${VERSION} @ ${new Date().toISOString()} =====\n`)
    } catch { /* banner is best-effort */ }
  }
  const child = spawn(process.execPath, fullArgs, {
    argv0: process.argv0,
    detached: true,
    stdio,
    env: {
      ...process.env,
      OWLCODA_RUNTIME_TOKEN: runtimeToken,
    },
  })
  // Parent closes its copy of the log fd; the detached child keeps its own.
  if (logFd !== undefined) { try { closeSync(logFd) } catch { /* already closed */ } }

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

// A cold start is a cross-process critical section: two CLI entry points must
// not both observe an available port and then race to publish pid/runtime meta.
const DAEMON_START_LOCK_TIMEOUT_MS = 15_000
const DAEMON_START_LOCK_RETRY_MS = 25
const DAEMON_START_LOCK_STALE_MS = 5_000

interface DaemonStartLockOwner {
  pid: number
  token: string
  acquiredAt: string
}

interface DaemonStartLock {
  path: string
  owner: DaemonStartLockOwner
}

interface DaemonStartLockSnapshot {
  stat: Stats
  owner: DaemonStartLockOwner | null
}

function readDaemonStartLockSnapshot(lockPath: string): DaemonStartLockSnapshot | null {
  let lockStat: Stats
  try {
    lockStat = lstatSync(lockPath)
  } catch (error) {
    const code = error instanceof Error && 'code' in error
      ? String((error as NodeJS.ErrnoException).code ?? '')
      : ''
    if (code === 'ENOENT') return null
    throw error
  }
  if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
    throw new Error(`Refusing unexpected daemon start lock path: ${lockPath}`)
  }

  let owner: DaemonStartLockOwner | null = null
  try {
    const rawOwner = JSON.parse(readFileSync(`${lockPath}/owner.json`, 'utf-8')) as Partial<DaemonStartLockOwner>
    if (Number.isInteger(rawOwner.pid) && typeof rawOwner.token === 'string' && typeof rawOwner.acquiredAt === 'string') {
      owner = rawOwner as DaemonStartLockOwner
    }
  } catch {
    // A process can die after mkdir and before publishing owner.json. The
    // directory remains reclaimable only after the stale age is reached.
  }
  return { stat: lockStat, owner }
}

function reclaimStaleDaemonStartLock(
  lockPath: string,
  snapshot: DaemonStartLockSnapshot,
): boolean {
  const reclaimPath = `${lockPath}.reclaim-${randomUUID()}`
  try {
    const current = readDaemonStartLockSnapshot(lockPath)
    if (!current || current.stat.ino !== snapshot.stat.ino || current.stat.mtimeMs !== snapshot.stat.mtimeMs) return false
    if (snapshot.owner) {
      if (!current.owner
        || current.owner.pid !== snapshot.owner.pid
        || current.owner.token !== snapshot.owner.token
        || current.owner.acquiredAt !== snapshot.owner.acquiredAt
        || isPidAlive(current.owner.pid)) {
        return false
      }
    }
    // Rename moves the exact stale directory out of the contested pathname in
    // one filesystem operation. A waiter can create a new lock afterward, but
    // it can never be removed by the cleanup of this old owner.
    renameSync(lockPath, reclaimPath)
    rmSync(reclaimPath, { recursive: true, force: true })
    return true
  } catch (error) {
    const code = error instanceof Error && 'code' in error
      ? String((error as NodeJS.ErrnoException).code ?? '')
      : ''
    if (code === 'ENOENT') return false
    throw error
  }
}

async function acquireDaemonStartLock(): Promise<DaemonStartLock> {
  ensureOwlcodaDir()
  const lockPath = getOwlcodaDaemonStartLockPath()
  const owner: DaemonStartLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  }
  const startedAt = Date.now()

  while (true) {
    try {
      mkdirSync(lockPath)
      writeFileSync(`${lockPath}/owner.json`, JSON.stringify(owner) + '\n', { flag: 'wx', mode: 0o600 })
      return { path: lockPath, owner }
    } catch (error) {
      const code = error instanceof Error && 'code' in error
        ? String((error as NodeJS.ErrnoException).code ?? '')
        : ''
      if (code !== 'EEXIST') throw error

      const snapshot = readDaemonStartLockSnapshot(lockPath)
      const lockAgeMs = snapshot ? Math.max(0, Date.now() - snapshot.stat.mtimeMs) : 0
      const ownerAlive = snapshot?.owner ? isPidAlive(snapshot.owner.pid) : false
      if (snapshot && !ownerAlive && lockAgeMs >= DAEMON_START_LOCK_STALE_MS && reclaimStaleDaemonStartLock(lockPath, snapshot)) {
        continue
      }
      if (Date.now() - startedAt >= DAEMON_START_LOCK_TIMEOUT_MS) {
        const ownerLabel = snapshot?.owner ? `PID ${snapshot.owner.pid}` : 'unknown owner'
        throw new Error(`Timed out acquiring OwlCoda daemon start lock (${ownerLabel})`)
      }
      await new Promise(resolve => setTimeout(resolve, DAEMON_START_LOCK_RETRY_MS))
    }
  }
}

function releaseDaemonStartLock(lock: DaemonStartLock): void {
  try {
    const rawOwner = JSON.parse(readFileSync(`${lock.path}/owner.json`, 'utf-8')) as Partial<DaemonStartLockOwner>
    if (rawOwner.pid !== lock.owner.pid || rawOwner.token !== lock.owner.token) return
    rmSync(lock.path, { recursive: true, force: true })
  } catch {
    // The lock may already have been reclaimed after an abrupt owner exit.
  }
}

async function withDaemonStartLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = await acquireDaemonStartLock()
  try {
    return await fn()
  } finally {
    releaseDaemonStartLock(lock)
  }
}

// ─── launchd-aware coordination (P2-b) ───

export interface LaunchdProxyDeps {
  fetchHealthz: (baseUrl: string, runtimeToken?: string) => Promise<HealthzResponse | null>
  matchesConfig: (healthz: HealthzResponse, config: OwlCodaConfig) => boolean
  readMeta: () => RuntimeMeta | null
  activeClients: (meta: RuntimeMeta) => number
  decide: (daemonVersion: string, activeClientCount: number) => DaemonVersionPolicyDecision
  kickstart: () => void
  waitReady: (
    baseUrl: string,
    matcher: (healthz: HealthzResponse) => boolean,
    runtimeToken?: string | (() => string | undefined),
  ) => Promise<HealthzResponse | null>
}

const defaultLaunchdProxyDeps: LaunchdProxyDeps = {
  fetchHealthz: (baseUrl, runtimeToken) => fetchHealthz(baseUrl, 2000, runtimeToken),
  matchesConfig: (healthz, config) => healthzMatchesConfig(healthz, config),
  readMeta: () => readRuntimeMeta(),
  activeClients: (meta) => getActiveLiveReplClientsForRuntime(meta).length,
  decide: (daemonVersion, activeClientCount) => decideDaemonVersionPolicy(daemonVersion, activeClientCount),
  kickstart: () => kickstartLaunchdService(),
  waitReady: (baseUrl, matcher, runtimeToken) => waitForVerifiedHealthz(baseUrl, matcher, 5000, runtimeToken),
}

/**
 * Coordinate the daemon when launchd owns its lifecycle (service installed).
 * launchd's KeepAlive keeps the daemon up and W4a self-registration makes it
 * discoverable, so we must NOT spawnDaemon a second detached process racing the
 * KeepAlive respawn for the port. Reuse a healthy+current daemon; otherwise
 * kickstart via launchctl (which also picks up a rebuilt binary) and wait.
 * IO is injected so the decision flow is unit-testable without a live daemon.
 */
export async function ensureLaunchdProxyRunning(
  config: OwlCodaConfig,
  baseUrl: string,
  log: (message: string) => void,
  deps: LaunchdProxyDeps = defaultLaunchdProxyDeps,
): Promise<EnsureProxyRunningResult> {
  const meta = deps.readMeta()
  const healthz = await deps.fetchHealthz(baseUrl, meta?.runtimeToken)
  if (healthz && meta && healthzMatchesRuntimeMeta(healthz, meta) && deps.matchesConfig(healthz, config)) {
    const activeClientCount = meta ? deps.activeClients(meta) : 0
    const decision = deps.decide(healthz.version ?? meta?.version ?? VERSION, activeClientCount)
    if (decision.action === 'reuse_active_stale') {
      applyActiveStaleDaemonPolicy(meta.pid, baseUrl, decision)
      return {
        pid: meta.pid,
        reused: true,
        staleDaemon: {
          daemonVersion: decision.daemonVersion!,
          cliVersion: decision.cliVersion,
          activeClientCount: decision.activeClientCount,
        },
      }
    }
    if (decision.action !== 'restart_idle_stale') {
      return { pid: meta.pid, reused: true }
    }
    log(
      `launchd daemon is v${decision.daemonVersion}, CLI is v${decision.cliVersion}; ` +
      'no active live REPL clients — kickstarting to pick up the new version',
    )
  } else if (!healthz) {
    log('launchd-managed daemon not responding — kickstarting')
  } else {
    log('launchd-managed daemon config differs — kickstarting')
  }

  deps.kickstart()
  const ready = await deps.waitReady(baseUrl, (h) => {
    const currentMeta = deps.readMeta()
    return Boolean(
      currentMeta
      && ['ok', 'healthy', 'degraded', 'unhealthy'].includes(h.status)
      && healthzMatchesRuntimeMeta(h, currentMeta)
      && deps.matchesConfig(h, config),
    )
  }, () => deps.readMeta()?.runtimeToken)
  if (ready && typeof ready.pid === 'number') return { pid: ready.pid, reused: false }
  throw new Error(`launchd-managed OwlCoda daemon failed to become ready at ${baseUrl}`)
}

/**
 * Unified daemon coordination — used by both start and launch.
 * 1. Check existing daemon via PID + healthz identity
 * 2. If matching config + matching version → reuse
 * 3. If matching config but stale version → restart only when no live REPL clients are attached
 * 4. If config mismatch → safe stop + restart
 * 5. If nothing running → start fresh
 * 6. Wait for healthz ready before returning
 */
export async function ensureProxyRunning(
  config: OwlCodaConfig,
  configPath?: string,
  port?: number,
  routerUrl?: string,
  options: { quiet?: boolean } = {},
): Promise<EnsureProxyRunningResult> {
  return await withDaemonStartLock(() => ensureProxyRunningUnlocked(config, configPath, port, routerUrl, options))
}

async function ensureProxyRunningUnlocked(
  config: OwlCodaConfig,
  configPath?: string,
  port?: number,
  routerUrl?: string,
  options: { quiet?: boolean } = {},
): Promise<EnsureProxyRunningResult> {
  const baseUrl = getBaseUrl(config)
  const log = (message: string): void => {
    if (!options.quiet) console.error(message)
  }

  // launchd owns the daemon lifecycle when its service is installed (opt-in):
  // reuse or kickstart, never spawn a competing detached daemon that would race
  // the KeepAlive respawn for the port. No-op for users who never installed it.
  if (isLaunchdServiceInstalled()) {
    return await ensureLaunchdProxyRunning(config, baseUrl, log)
  }

  // 1. Check PID file + identity
  const existingPid = readPid()
  if (existingPid !== null) {
    const meta = readRuntimeMeta()
    if (!isPidAlive(existingPid)) {
      removePid()
      removeRuntimeMeta()
    } else if (meta && meta.pid === existingPid) {
      const healthz = await fetchHealthz(getMetaBaseUrl(meta), 2000, meta.runtimeToken)
      if (healthz && healthzMatchesRuntimeMeta(healthz, meta) && healthzMatchesConfig(healthz, config)) {
        const activeClientCount = getActiveLiveReplClientsForRuntime(meta).length
        const versionDecision = decideDaemonVersionPolicy(healthz.version ?? meta.version, activeClientCount)
        if (versionDecision.action === 'restart_idle_stale') {
          log(
            `Existing daemon (PID ${existingPid}) is v${versionDecision.daemonVersion}, ` +
            `CLI is v${versionDecision.cliVersion}; no active live REPL clients — restarting`,
          )
          await stopAndWait(existingPid, getMetaBaseUrl(meta))
        } else if (versionDecision.action === 'reuse_active_stale') {
          applyActiveStaleDaemonPolicy(existingPid, baseUrl, versionDecision)
          return {
            pid: existingPid,
            reused: true,
            staleDaemon: {
              daemonVersion: versionDecision.daemonVersion!,
              cliVersion: versionDecision.cliVersion,
              activeClientCount: versionDecision.activeClientCount,
            },
          }
        } else {
          return { pid: existingPid, reused: true }
        }
      } else if (healthz && healthzMatchesRuntimeMeta(healthz, meta)) {
        log(`Existing daemon (PID ${existingPid}) config mismatch — restarting`)
        await stopAndWait(existingPid, getMetaBaseUrl(meta))
      } else if (healthz && healthzIdentifiesRuntimeMetaForRetirement(healthz, meta)) {
        log(`Existing daemon (PID ${existingPid}) uses a legacy raw-token health identity — retiring it before reuse`)
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

  // 2. Recover a missing pid file only from host-owned runtime metadata.
  // Public /healthz deliberately contains no process identity, so an
  // unauthenticated response can never authorize signaling or lease recovery.
  const orphanMeta = readRuntimeMeta()
  const orphanHealthz = await fetchHealthz(baseUrl, 2000, orphanMeta?.runtimeToken)
  const verifiedOrphan = Boolean(
    orphanMeta
    && orphanHealthz
    && healthzMatchesRuntimeMeta(orphanHealthz, orphanMeta),
  )
  const legacyOrphan = Boolean(
    orphanMeta
    && orphanHealthz
    && !verifiedOrphan
    && healthzIdentifiesRuntimeMetaForRetirement(orphanHealthz, orphanMeta),
  )
  if (verifiedOrphan && orphanMeta && orphanHealthz) {
    if (healthzMatchesConfig(orphanHealthz, config, { requireConfigFingerprint: true })) {
      log(`Found authenticated OwlCoda proxy at ${baseUrl} with a missing PID file`)
      const activeClientCount = getActiveLiveReplClientsForRuntime(orphanMeta).length
      const versionDecision = decideDaemonVersionPolicy(orphanHealthz.version, activeClientCount)
      if (versionDecision.action === 'restart_idle_stale') {
        log(
          `Authenticated daemon (PID ${orphanMeta.pid}) is v${versionDecision.daemonVersion}, ` +
          `CLI is v${versionDecision.cliVersion}; no active live REPL clients — restarting`,
        )
        safeSendSignal(orphanMeta.pid, 'SIGTERM')
        await waitForHealthzGone(baseUrl, 1000)
      } else {
        writePid(orphanMeta.pid)
        if (versionDecision.action === 'reuse_active_stale') {
          applyActiveStaleDaemonPolicy(orphanMeta.pid, baseUrl, versionDecision)
          return {
            pid: orphanMeta.pid,
            reused: true,
            staleDaemon: {
              daemonVersion: versionDecision.daemonVersion!,
              cliVersion: versionDecision.cliVersion,
              activeClientCount: versionDecision.activeClientCount,
            },
          }
        }
        return { pid: orphanMeta.pid, reused: true }
      }
    } else {
      log(`Authenticated OwlCoda proxy at ${baseUrl} has a different config — restarting`)
      safeSendSignal(orphanMeta.pid, 'SIGTERM')
      await waitForHealthzGone(baseUrl, 1000)
    }
  } else if (legacyOrphan && orphanMeta) {
    log(`Found legacy raw-token OwlCoda daemon at ${baseUrl} — retiring it before reuse`)
    await stopAndWait(orphanMeta.pid, baseUrl)
  } else if (orphanHealthz) {
    log(`A service answers ${baseUrl}/healthz, but no matching host-owned runtime identity is available; refusing to signal or claim it`)
  }

  const targetPortAvailable = await isPortAvailable(config.port, resolveClientHost(config.host))
  if (!targetPortAvailable) {
    // Identify the holder before blaming a "non-OwlCoda process": /healthz is
    // OwlCoda-only, so any response proves a stale / config-mismatched OwlCoda
    // daemon holds the port (common on Windows after a lost PID file).
    const portHolder = orphanMeta
      ? await fetchHealthz(baseUrl, 2000, orphanMeta.runtimeToken)
      : orphanHealthz
    const verifiedPid = orphanMeta && portHolder && healthzIdentifiesRuntimeMetaForRetirement(portHolder, orphanMeta)
      ? orphanMeta.pid
      : null
    throw new Error(buildPortInUseMessage(config.port, baseUrl, verifiedPid))
  }

  // 3. Start fresh
  const { pid, runtimeToken, exitPromise } = spawnDaemon(config, configPath, port, routerUrl)

  // 4. Wait for the exact daemon we spawned to become ready
  const readyState = await Promise.race([
    waitForVerifiedHealthz(
      baseUrl,
      healthz => healthzMatchesRuntimeMeta(healthz, {
        pid,
        runtimeToken,
        host: config.host,
        port: config.port,
        routerUrl: config.routerUrl,
      }),
      5000,
      runtimeToken,
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

function formatActiveStaleDaemonWarning(
  pid: number,
  baseUrl: string,
  decision: DaemonVersionPolicyDecision,
): string {
  const noun = decision.activeClientCount === 1 ? 'client is' : 'clients are'
  return `⚠ OwlCoda daemon PID ${pid} on ${baseUrl} is v${decision.daemonVersion}, ` +
    `but this CLI is v${decision.cliVersion}. ${decision.activeClientCount} active live REPL ${noun} attached, ` +
    'so OwlCoda will not restart it automatically. Close those clients, or run `owlcoda stop --force && owlcoda` to align.'
}

/**
 * 2026-05-28: version-drift hard-block.
 *
 * Previously this was a warn-and-continue path: the CLI would emit the
 * stale-daemon warning and proceed to reuse the mismatched daemon. In
 * practice that produced subtle inconsistencies — the CLI runs the
 * latest agent / classifier / wrapper code, but HTTP error
 * classification (e.g. detailLooksLikeRateLimit from a66383e) lives in
 * the daemon process, so a stale daemon silently disabled retry logic
 * even though the CLI thought it was active. Dogfood across the
 * 0.14.36 → 0.14.39 release window made this drift visible only in
 * post-mortem audit-log inspection.
 *
 * New behaviour: refuse to proceed. The user must either close the
 * active REPL clients (daemon auto-restarts on next start) or
 * `owlcoda stop --force && owlcoda` to align. An escape hatch
 * `OWLCODA_ALLOW_VERSION_DRIFT=1` is provided for emergency cases
 * (e.g. interactive long-running session a user explicitly wants to
 * keep going on a frozen daemon).
 */
export function applyActiveStaleDaemonPolicy(
  pid: number,
  baseUrl: string,
  decision: DaemonVersionPolicyDecision,
): void {
  console.error(formatActiveStaleDaemonWarning(pid, baseUrl, decision))
  if (process.env.OWLCODA_ALLOW_VERSION_DRIFT === '1') {
    console.error(
      'OWLCODA_ALLOW_VERSION_DRIFT=1 set — continuing with mismatched daemon ' +
      '(proceed at your own risk; HTTP error classification / model registry / ' +
      'shared state may behave per the older daemon version).',
    )
    return
  }
  console.error(
    'Refusing to start with version-drifted daemon. Close active REPL clients ' +
    'or run `owlcoda stop --force && owlcoda` to align. ' +
    'Set OWLCODA_ALLOW_VERSION_DRIFT=1 to bypass this check.',
  )
  process.exit(2)
}

function formatDaemonExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `signal ${signal}`
  if (code !== null) return `exit code ${code}`
  return 'unknown exit'
}
