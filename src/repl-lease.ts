import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import type { SessionFile } from './native/session.js'
import { listSessions, loadSession } from './native/session.js'
import { getOwlcodaLiveReplLeasePath } from './paths.js'
import { resolveClientHost } from './healthz-client.js'

const LIVE_REPL_REGISTRY_VERSION = 2
const LIVE_REPL_REGISTRY_LOCK_TIMEOUT_MS = 2000
const LIVE_REPL_REGISTRY_LOCK_STALE_MS = 5000
const LIVE_REPL_REGISTRY_LOCK_RETRY_MS = 25
const REGISTRY_SLEEP_BUFFER = new SharedArrayBuffer(4)
const REGISTRY_SLEEP_VIEW = new Int32Array(REGISTRY_SLEEP_BUFFER)

export interface LiveReplClientLease {
  clientId: string
  clientPid: number
  daemonPid: number
  runtimeToken: string
  host: string
  port: number
  routerUrl: string
  startedAt: string
  sessionId?: string
}

export interface LiveReplRegistry {
  version: 2
  clients: LiveReplClientLease[]
}

export interface LiveReplRuntimeIdentity {
  host: string
  port: number
  routerUrl: string
  runtimeToken?: string
}

export interface SessionResumeResolution {
  requestedTarget: string
  resolvedTarget: string | null
  session: SessionFile | null
  reason: 'ok' | 'not_found' | 'no_target' | 'no_resumable_session' | 'owned_by_live_client'
  blockedBy?: LiveReplClientLease
  skippedLiveSessionIds: string[]
}

export interface LiveReplDetachResult {
  ok: boolean
  reason: 'removed' | 'not_found' | 'active_requires_force'
  client?: LiveReplClientLease
}

export interface LiveReplDetachManyResult {
  removedClients: LiveReplClientLease[]
  blockedClients: LiveReplClientLease[]
}

// Backward-compatible alias used by older callers/tests.
export type LiveReplLease = LiveReplClientLease

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function emptyRegistry(): LiveReplRegistry {
  return { version: LIVE_REPL_REGISTRY_VERSION, clients: [] }
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(REGISTRY_SLEEP_VIEW, 0, 0, ms)
  } catch {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      // Busy wait fallback if Atomics.wait is unavailable.
    }
  }
}

function getRegistryLockPath(): string {
  return `${getOwlcodaLiveReplLeasePath()}.lock`
}

function acquireRegistryLock(): void {
  const lockPath = getRegistryLockPath()
  const start = Date.now()
  while (true) {
    try {
      mkdirSync(lockPath)
      return
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code ?? '') : ''
      if (code !== 'EEXIST') throw error
      try {
        const stats = statSync(lockPath)
        if ((Date.now() - stats.mtimeMs) >= LIVE_REPL_REGISTRY_LOCK_STALE_MS) {
          rmSync(lockPath, { recursive: true, force: true })
          continue
        }
      } catch {
        continue
      }
      if ((Date.now() - start) >= LIVE_REPL_REGISTRY_LOCK_TIMEOUT_MS) {
        throw new Error('Timed out acquiring live REPL registry lock')
      }
      sleepSync(LIVE_REPL_REGISTRY_LOCK_RETRY_MS)
    }
  }
}

function releaseRegistryLock(): void {
  rmSync(getRegistryLockPath(), { recursive: true, force: true })
}

function withRegistryLock<T>(fn: () => T): T {
  acquireRegistryLock()
  try {
    return fn()
  } finally {
    releaseRegistryLock()
  }
}

function parseClientLease(raw: unknown, index: number): LiveReplClientLease | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  const clientPid = Number(data['clientPid'])
  const daemonPid = Number(data['daemonPid'])
  const port = Number(data['port'])
  const runtimeToken = String(data['runtimeToken'] ?? '').trim()
  const host = String(data['host'] ?? '').trim()
  const routerUrl = String(data['routerUrl'] ?? '').trim()
  const startedAt = String(data['startedAt'] ?? '').trim()
  if (!Number.isFinite(clientPid) || clientPid <= 0) return null
  if (!Number.isFinite(daemonPid) || daemonPid <= 0) return null
  if (!Number.isFinite(port) || port <= 0) return null
  if (!runtimeToken || !host || !routerUrl || !startedAt) return null

  const rawClientId = String(data['clientId'] ?? '').trim()
  const sessionId = typeof data['sessionId'] === 'string' && data['sessionId'].trim()
    ? data['sessionId'].trim()
    : undefined

  return {
    clientId: rawClientId || `legacy-${clientPid}-${Date.parse(startedAt) || index}`,
    clientPid,
    daemonPid,
    runtimeToken,
    host,
    port,
    routerUrl,
    startedAt,
    sessionId,
  }
}

function normalizeRegistry(raw: unknown): LiveReplRegistry | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>

  if (Array.isArray(data['clients'])) {
    const clients = data['clients']
      .map((entry, index) => parseClientLease(entry, index))
      .filter((entry): entry is LiveReplClientLease => entry !== null)
    return {
      version: LIVE_REPL_REGISTRY_VERSION,
      clients: dedupeClients(clients),
    }
  }

  const legacy = parseClientLease(raw, 0)
  if (!legacy) return null
  return {
    version: LIVE_REPL_REGISTRY_VERSION,
    clients: [legacy],
  }
}

function dedupeClients(clients: LiveReplClientLease[]): LiveReplClientLease[] {
  const deduped = new Map<string, LiveReplClientLease>()
  for (const client of clients) {
    deduped.set(client.clientId, client)
  }
  return [...deduped.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

function registryEquals(a: LiveReplRegistry, b: LiveReplRegistry): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function readRegistryFile(): LiveReplRegistry | null {
  const leasePath = getOwlcodaLiveReplLeasePath()
  if (!existsSync(leasePath)) return null
  try {
    const raw = JSON.parse(readFileSync(leasePath, 'utf-8')) as unknown
    return normalizeRegistry(raw)
  } catch {
    return null
  }
}

function writeRegistryFile(registry: LiveReplRegistry): void {
  const leasePath = getOwlcodaLiveReplLeasePath()
  if (registry.clients.length === 0) {
    try {
      if (existsSync(leasePath)) unlinkSync(leasePath)
    } catch {
      // best effort
    }
    return
  }
  const tempPath = `${leasePath}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(tempPath, JSON.stringify(registry, null, 2) + '\n', 'utf-8')
    renameSync(tempPath, leasePath)
  } finally {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath)
    } catch {
      // best effort
    }
  }
}

function loadActiveRegistryUnlocked(): LiveReplRegistry {
  const registry = readRegistryFile() ?? emptyRegistry()
  const pruned = {
    version: LIVE_REPL_REGISTRY_VERSION,
    clients: registry.clients.filter(client => isPidAlive(client.clientPid)),
  } satisfies LiveReplRegistry
  if (!registryEquals(registry, pruned)) {
    writeRegistryFile(pruned)
  }
  return pruned
}

function mutateActiveRegistry<T>(mutator: (registry: LiveReplRegistry) => { registry: LiveReplRegistry; value: T }): T {
  return withRegistryLock(() => {
    const registry = loadActiveRegistryUnlocked()
    const result = mutator(registry)
    const nextRegistry = {
      version: LIVE_REPL_REGISTRY_VERSION,
      clients: dedupeClients(result.registry.clients),
    } satisfies LiveReplRegistry
    if (!registryEquals(registry, nextRegistry)) {
      writeRegistryFile(nextRegistry)
    }
    return result.value
  })
}

function matchesRuntime(
  client: Pick<LiveReplClientLease, 'host' | 'port' | 'routerUrl' | 'runtimeToken'>,
  runtime?: LiveReplRuntimeIdentity,
): boolean {
  if (!runtime) return true
  if (resolveClientHost(client.host) !== resolveClientHost(runtime.host)) return false
  if (client.port !== runtime.port) return false
  if (client.routerUrl !== runtime.routerUrl) return false
  if (runtime.runtimeToken && client.runtimeToken !== runtime.runtimeToken) return false
  return true
}

function formatClientSessionSuffix(client: Pick<LiveReplClientLease, 'sessionId'>): string {
  return client.sessionId ? `, session ${client.sessionId}` : ''
}

export function createLiveReplClientId(): string {
  return `client-${randomUUID()}`
}

export function writeLiveReplLease(lease: LiveReplLease): void {
  upsertLiveReplClient(lease)
}

export function writeLiveReplRegistry(registry: LiveReplRegistry): void {
  withRegistryLock(() => {
    writeRegistryFile({
      version: LIVE_REPL_REGISTRY_VERSION,
      clients: dedupeClients(registry.clients),
    })
  })
}

export function readLiveReplRegistry(): LiveReplRegistry | null {
  return withRegistryLock(() => loadActiveRegistryUnlocked())
}

export function readLiveReplLease(): LiveReplLease | null {
  return withRegistryLock(() => loadActiveRegistryUnlocked().clients[0] ?? null)
}

export function removeLiveReplLease(): void {
  withRegistryLock(() => {
    writeRegistryFile(emptyRegistry())
  })
}

export function removeLiveReplClient(clientId: string): void {
  mutateActiveRegistry((registry) => ({
    registry: {
      version: LIVE_REPL_REGISTRY_VERSION,
      clients: registry.clients.filter(client => client.clientId !== clientId),
    },
    value: undefined,
  }))
}

export function removeLiveReplClientIfOwned(clientId: string, clientPid?: number): void {
  mutateActiveRegistry((registry) => ({
    registry: {
      version: LIVE_REPL_REGISTRY_VERSION,
      clients: registry.clients.filter((client) => {
        if (client.clientId !== clientId) return true
        if (clientPid !== undefined && client.clientPid !== clientPid) return true
        return false
      }),
    },
    value: undefined,
  }))
}

// Backward-compatible wrapper for older call sites that only know PID ownership.
export function removeLiveReplLeaseIfOwned(clientPid: number): void {
  mutateActiveRegistry((registry) => ({
    registry: {
      version: LIVE_REPL_REGISTRY_VERSION,
      clients: registry.clients.filter(client => client.clientPid !== clientPid),
    },
    value: undefined,
  }))
}

export function upsertLiveReplClient(lease: LiveReplClientLease): LiveReplRegistry {
  return mutateActiveRegistry((registry) => {
    const nextClients = registry.clients.filter((client) => {
      if (client.clientId === lease.clientId) return false
      return !(client.clientPid === lease.clientPid && matchesRuntime(client, lease))
    })
    nextClients.push({ ...lease })
    const nextRegistry = {
      version: LIVE_REPL_REGISTRY_VERSION,
      clients: nextClients,
    } satisfies LiveReplRegistry
    return { registry: nextRegistry, value: { ...nextRegistry, clients: dedupeClients(nextClients) } }
  })
}

export function updateLiveReplClientSession(clientId: string, sessionId: string | undefined): boolean {
  return mutateActiveRegistry((registry) => {
    const trimmedSessionId = sessionId?.trim() || undefined
    let updated = false
    const nextClients = registry.clients.map((client) => {
      if (client.clientId !== clientId) return client
      updated = true
      if (trimmedSessionId === client.sessionId) return client
      if (!trimmedSessionId) {
        const { sessionId: _removed, ...rest } = client
        return rest
      }
      return { ...client, sessionId: trimmedSessionId }
    })
    return {
      registry: {
        version: LIVE_REPL_REGISTRY_VERSION,
        clients: nextClients,
      },
      value: updated,
    }
  })
}

export function detachLiveReplClient(clientId: string, opts?: { force?: boolean }): LiveReplDetachResult {
  return mutateActiveRegistry<LiveReplDetachResult>((registry) => {
    const client = registry.clients.find(entry => entry.clientId === clientId)
    if (!client) {
      return {
        registry,
        value: {
          ok: false,
          reason: 'not_found',
        } satisfies LiveReplDetachResult,
      }
    }
    if (!opts?.force && isPidAlive(client.clientPid)) {
      return {
        registry,
        value: {
          ok: false,
          reason: 'active_requires_force',
          client,
        } satisfies LiveReplDetachResult,
      }
    }
    return {
      registry: {
        version: LIVE_REPL_REGISTRY_VERSION,
        clients: registry.clients.filter(entry => entry.clientId !== clientId),
      },
      value: {
        ok: true,
        reason: 'removed',
        client,
      } satisfies LiveReplDetachResult,
    }
  })
}

export function detachLiveReplClientsForRuntime(
  runtime: LiveReplRuntimeIdentity,
  opts?: { force?: boolean },
): LiveReplDetachManyResult {
  return mutateActiveRegistry<LiveReplDetachManyResult>((registry) => {
    const removedClients: LiveReplClientLease[] = []
    const blockedClients: LiveReplClientLease[] = []
    const clients: LiveReplClientLease[] = []
    for (const client of registry.clients) {
      if (!matchesRuntime(client, runtime)) {
        clients.push(client)
        continue
      }
      if (!opts?.force && isPidAlive(client.clientPid)) {
        blockedClients.push(client)
        clients.push(client)
        continue
      }
      removedClients.push(client)
    }
    return {
      registry: {
        version: LIVE_REPL_REGISTRY_VERSION,
        clients,
      },
      value: { removedClients, blockedClients } satisfies LiveReplDetachManyResult,
    }
  })
}

export function listActiveLiveReplClients(runtime?: LiveReplRuntimeIdentity): LiveReplClientLease[] {
  return withRegistryLock(() => loadActiveRegistryUnlocked().clients.filter(client => matchesRuntime(client, runtime)))
}

export function getActiveLiveReplLease(): LiveReplLease | null {
  return listActiveLiveReplClients()[0] ?? null
}

export function getActiveLiveReplClientsForRuntime(runtime: LiveReplRuntimeIdentity): LiveReplClientLease[] {
  return listActiveLiveReplClients(runtime)
}

export function liveReplLeaseMatchesConfig(
  lease: Pick<LiveReplClientLease, 'host' | 'port' | 'routerUrl'>,
  config: { host: string; port: number; routerUrl: string },
): boolean {
  return resolveClientHost(lease.host) === resolveClientHost(config.host)
    && lease.port === config.port
    && lease.routerUrl === config.routerUrl
}

export function formatLiveReplLeaseTarget(
  lease: Pick<LiveReplClientLease, 'host' | 'port'>,
): string {
  return `http://${resolveClientHost(lease.host)}:${lease.port}`
}

export function formatLiveReplClientSummary(
  client: Pick<LiveReplClientLease, 'clientId' | 'clientPid' | 'startedAt' | 'sessionId'>,
): string {
  return `PID ${client.clientPid} (${client.clientId})${formatClientSessionSuffix(client)}, started ${client.startedAt}`
}

export function formatLiveReplClientAdminSummary(
  client: Pick<LiveReplClientLease, 'clientId' | 'clientPid' | 'daemonPid' | 'host' | 'port' | 'startedAt' | 'sessionId'>,
): string {
  return `${formatLiveReplClientSummary(client)}, daemon ${client.daemonPid}, target ${formatLiveReplLeaseTarget(client)}`
}

// ─── Admin view: enriched client record for `owlcoda clients` ─────
//
// The raw `LiveReplClientLease` is the on-disk shape. The admin view
// adds derived fields that are cheap to compute but expensive to
// re-derive in every consumer: process liveness, formatted target,
// age since start, and optional session title/updatedAt (best-effort
// — enriched only when the session file is readable; missing sessions
// don't error, they just leave sessionTitle undefined).
//
// The schemaVersion lets `--json` consumers gate on a known shape;
// bump it when fields change semantics.

export const LIVE_REPL_CLIENT_ADMIN_SCHEMA_VERSION = 2

export interface LiveReplClientAdminView extends LiveReplClientLease {
  /** Result of `process.kill(clientPid, 0)` at enrich time. */
  alive: boolean
  /** "http://host:port" pre-formatted for display/copy. */
  target: string
  /** Wall-clock seconds since startedAt (>=0). -1 if startedAt is unparseable. */
  ageSeconds: number
  /** Session title if the session file is readable, undefined otherwise. */
  sessionTitle?: string
  /** ISO timestamp of the session's last update if readable. */
  sessionUpdatedAt?: string
}

/**
 * Produce the admin view for a single client. Caller passes `now` to
 * get a stable ageSeconds across a multi-client snapshot (avoids
 * drift from per-client Date.now() calls).
 */
export function enrichLiveReplClientForAdmin(
  client: LiveReplClientLease,
  now: number = Date.now(),
): LiveReplClientAdminView {
  const startedMs = Date.parse(client.startedAt)
  const ageSeconds = Number.isFinite(startedMs)
    ? Math.max(0, Math.floor((now - startedMs) / 1000))
    : -1

  let sessionTitle: string | undefined
  let sessionUpdatedAt: string | undefined
  if (client.sessionId) {
    try {
      const session = loadSession(client.sessionId)
      if (session) {
        sessionTitle = session.title
        sessionUpdatedAt = new Date(session.updatedAt).toISOString()
      }
    } catch {
      // best-effort enrichment — missing/corrupt session file shouldn't
      // break the admin view or leak an error into JSON output
    }
  }

  return {
    ...client,
    alive: isPidAlive(client.clientPid),
    target: formatLiveReplLeaseTarget(client),
    ageSeconds,
    ...(sessionTitle !== undefined && { sessionTitle }),
    ...(sessionUpdatedAt !== undefined && { sessionUpdatedAt }),
  }
}

/**
 * Human-readable age: "42s", "5m 12s", "2h 18m", "3d". Keeps output
 * compact — reserved callers format their own precision if needed.
 */
export function formatLiveReplClientAge(ageSeconds: number): string {
  if (ageSeconds < 0) return 'unknown'
  if (ageSeconds < 60) return `${ageSeconds}s`
  if (ageSeconds < 3600) {
    const m = Math.floor(ageSeconds / 60)
    const s = ageSeconds % 60
    return s > 0 ? `${m}m ${s}s` : `${m}m`
  }
  if (ageSeconds < 86400) {
    const h = Math.floor(ageSeconds / 3600)
    const m = Math.floor((ageSeconds % 3600) / 60)
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }
  return `${Math.floor(ageSeconds / 86400)}d`
}

/**
 * Multi-line human detail block for a single client. Used by
 * `owlcoda clients` default text output. Intentionally verbose —
 * the one-line summary (`formatLiveReplClientAdminSummary`) stays
 * for compact contexts (detach messages).
 *
 *   [n] client <clientId>  alive|stale  started <age> ago
 *       PID <clientPid>    daemon <daemonPid>
 *       target <url>       router <routerUrl>
 *       session <id> — "title" (updated <age>)
 */
export function formatLiveReplClientDetail(
  view: LiveReplClientAdminView,
  index?: number,
): string {
  const header = index !== undefined
    ? `[${index}] client ${view.clientId}`
    : `client ${view.clientId}`
  const aliveMark = view.alive ? 'alive' : 'stale'
  const age = formatLiveReplClientAge(view.ageSeconds)

  const lines: string[] = [
    `${header}  ${aliveMark}  started ${age} ago`,
    `    PID ${view.clientPid}    daemon ${view.daemonPid}`,
    `    target ${view.target}    router ${view.routerUrl}`,
  ]
  if (view.sessionId) {
    // Truncate UUID-shaped ids (conv-xxxx-xxxx-... or similar long ids)
    // for readability, but leave short human-friendly labels alone so
    // the operator can still grep / copy them directly.
    const shortId = view.sessionId.length > 16
      ? view.sessionId.slice(0, 16) + '…'
      : view.sessionId
    const titlePart = view.sessionTitle ? ` — "${view.sessionTitle}"` : ''
    lines.push(`    session ${shortId}${titlePart}`)
  } else {
    lines.push(`    session none`)
  }
  return lines.join('\n')
}

export function resolveLiveReplResumeTarget(
  requestedTarget: string | undefined,
  opts?: {
    currentClientId?: string
    runtime?: LiveReplRuntimeIdentity
  },
): SessionResumeResolution {
  const target = requestedTarget?.trim() || ''
  if (!target) {
    return {
      requestedTarget: target,
      resolvedTarget: null,
      session: null,
      reason: 'no_target',
      skippedLiveSessionIds: [],
    }
  }

  const blockedOwners = new Map<string, LiveReplClientLease>()
  for (const client of listActiveLiveReplClients(opts?.runtime)) {
    if (client.clientId === opts?.currentClientId) continue
    if (!client.sessionId) continue
    blockedOwners.set(client.sessionId, client)
  }

  if (target === 'last') {
    const sessions = listSessions()
    const skippedLiveSessionIds: string[] = []
    for (const session of sessions) {
      if (blockedOwners.has(session.id)) {
        skippedLiveSessionIds.push(session.id)
        continue
      }
      return {
        requestedTarget: target,
        resolvedTarget: session.id,
        session,
        reason: 'ok',
        skippedLiveSessionIds,
      }
    }
    return {
      requestedTarget: target,
      resolvedTarget: null,
      session: null,
      reason: 'no_resumable_session',
      skippedLiveSessionIds,
    }
  }

  const session = loadSession(target)
  if (!session) {
    return {
      requestedTarget: target,
      resolvedTarget: null,
      session: null,
      reason: 'not_found',
      skippedLiveSessionIds: [],
    }
  }

  const blockedBy = blockedOwners.get(session.id)
  if (blockedBy) {
    return {
      requestedTarget: target,
      resolvedTarget: null,
      session: null,
      reason: 'owned_by_live_client',
      blockedBy,
      skippedLiveSessionIds: [session.id],
    }
  }

  return {
    requestedTarget: target,
    resolvedTarget: session.id,
    session,
    reason: 'ok',
    skippedLiveSessionIds: [],
  }
}
