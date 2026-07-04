/**
 * Request audit log — structured ring buffer of recent requests with filtering.
 * Complements capture.ts (full exchange data) with lightweight summary entries.
 */

export interface AuditEntry {
  id: string
  timestamp: string
  method: string
  path: string
  model: string
  statusCode: number
  durationMs: number
  remoteAddress?: string
  userAgent?: string
  apiKeyFingerprint?: string
  clientId?: string
  inputTokens?: number
  outputTokens?: number
  error?: string
}

const MAX_ENTRIES = 500
const entries: AuditEntry[] = []
let entryCounter = 0

/**
 * Record a request in the audit log.
 */
export function auditRequest(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void {
  entryCounter++
  const auditEntry: AuditEntry = {
    id: `req-${entryCounter}`,
    timestamp: new Date().toISOString(),
    ...entry,
  }
  entries.push(auditEntry)
  if (entries.length > MAX_ENTRIES) {
    entries.shift()
  }
}

export interface AuditFilter {
  model?: string
  path?: string
  minStatus?: number
  maxStatus?: number
  minDurationMs?: number
  limit?: number
}

/**
 * Query the audit log with optional filters.
 */
export function queryAudit(filter: AuditFilter = {}): AuditEntry[] {
  let result = [...entries]

  if (filter.model) {
    result = result.filter(e => e.model === filter.model)
  }
  if (filter.path) {
    result = result.filter(e => e.path === filter.path)
  }
  if (filter.minStatus !== undefined) {
    result = result.filter(e => e.statusCode >= filter.minStatus!)
  }
  if (filter.maxStatus !== undefined) {
    result = result.filter(e => e.statusCode <= filter.maxStatus!)
  }
  if (filter.minDurationMs !== undefined) {
    result = result.filter(e => e.durationMs >= filter.minDurationMs!)
  }

  // Return most recent first
  result.reverse()

  if (filter.limit) {
    result = result.slice(0, filter.limit)
  }

  return result
}

/**
 * Get audit log summary statistics.
 */
export interface AuditSummary {
  totalEntries: number
  uniqueModels: string[]
  uniquePaths: string[]
  errorCount: number
  avgDurationMs: number
  statusCounts: Record<string, number>
  authFailureCount: number
  gatewaySuccessRate: number
  authFailureSources: AuditAuthFailureSource[]
}

export interface AuditAuthFailureSource {
  sourceKey: string
  authFailureCount: number
  statusCounts: Record<string, number>
  remoteAddress?: string
  userAgent?: string
  apiKeyFingerprint?: string
  clientId?: string
  latestAt: string
}

export function getAuditSummary(): AuditSummary {
  const models = new Set<string>()
  const paths = new Set<string>()
  let errorCount = 0
  let authFailureCount = 0
  let totalDuration = 0
  const statusCounts: Record<string, number> = {}
  const authSources = new Map<string, AuditAuthFailureSource>()

  for (const e of entries) {
    models.add(e.model)
    paths.add(e.path)
    if (e.statusCode >= 400) errorCount++
    if (e.statusCode === 401 || e.statusCode === 403) {
      authFailureCount++
      const sourceKey = auditSourceKey(e)
      const source = authSources.get(sourceKey) ?? {
        sourceKey,
        authFailureCount: 0,
        statusCounts: {},
        ...(e.remoteAddress ? { remoteAddress: e.remoteAddress } : {}),
        ...(e.userAgent ? { userAgent: e.userAgent } : {}),
        ...(e.apiKeyFingerprint ? { apiKeyFingerprint: e.apiKeyFingerprint } : {}),
        ...(e.clientId ? { clientId: e.clientId } : {}),
        latestAt: e.timestamp,
      }
      source.authFailureCount += 1
      source.statusCounts[String(e.statusCode)] = (source.statusCounts[String(e.statusCode)] ?? 0) + 1
      if (e.timestamp > source.latestAt) source.latestAt = e.timestamp
      authSources.set(sourceKey, source)
    }
    const statusKey = String(e.statusCode)
    statusCounts[statusKey] = (statusCounts[statusKey] ?? 0) + 1
    totalDuration += e.durationMs
  }

  return {
    totalEntries: entries.length,
    uniqueModels: [...models],
    uniquePaths: [...paths],
    errorCount,
    avgDurationMs: entries.length > 0 ? Math.round(totalDuration / entries.length) : 0,
    statusCounts,
    authFailureCount,
    gatewaySuccessRate: entries.length > 0 ? Math.round(((entries.length - errorCount) / entries.length) * 1000) / 1000 : 1,
    authFailureSources: [...authSources.values()]
      .sort((a, b) => b.authFailureCount - a.authFailureCount || b.latestAt.localeCompare(a.latestAt))
      .slice(0, 10),
  }
}

function auditSourceKey(entry: Pick<AuditEntry, 'apiKeyFingerprint' | 'userAgent' | 'remoteAddress' | 'clientId'>): string {
  const parts = [
    `key=${entry.apiKeyFingerprint ?? 'unknown'}`,
    `ua=${entry.userAgent ?? 'unknown'}`,
    `remote=${entry.remoteAddress ?? 'unknown'}`,
  ]
  if (entry.clientId) parts.push(`client=${entry.clientId}`)
  return parts.join(' ')
}

/**
 * Format audit entries for display.
 */
export function formatAuditEntries(auditEntries: AuditEntry[], maxLines = 20): string {
  if (auditEntries.length === 0) return 'No audit entries.'

  const lines: string[] = [`Recent requests (${auditEntries.length} shown):`]
  for (const e of auditEntries.slice(0, maxLines)) {
    const ts = e.timestamp.slice(11, 19)
    const status = e.statusCode >= 400 ? `❌ ${e.statusCode}` : `✓ ${e.statusCode}`
    const source = e.statusCode === 401 || e.statusCode === 403
      ? ` ${auditSourceKey(e)}`
      : ''
    lines.push(`  ${ts} ${e.method} ${e.path} → ${status} (${e.durationMs}ms) [${e.model}]${source}`)
  }
  if (auditEntries.length > maxLines) {
    lines.push(`  ... and ${auditEntries.length - maxLines} more`)
  }
  return lines.join('\n')
}

/**
 * Reset audit log (for testing).
 */
export function resetAudit(): void {
  entries.length = 0
  entryCounter = 0
}
