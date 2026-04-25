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
export function getAuditSummary(): {
  totalEntries: number
  uniqueModels: string[]
  uniquePaths: string[]
  errorCount: number
  avgDurationMs: number
} {
  const models = new Set<string>()
  const paths = new Set<string>()
  let errorCount = 0
  let totalDuration = 0

  for (const e of entries) {
    models.add(e.model)
    paths.add(e.path)
    if (e.statusCode >= 400) errorCount++
    totalDuration += e.durationMs
  }

  return {
    totalEntries: entries.length,
    uniqueModels: [...models],
    uniquePaths: [...paths],
    errorCount,
    avgDurationMs: entries.length > 0 ? Math.round(totalDuration / entries.length) : 0,
  }
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
    lines.push(`  ${ts} ${e.method} ${e.path} → ${status} (${e.durationMs}ms) [${e.model}]`)
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
