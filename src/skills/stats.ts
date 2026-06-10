/**
 * Skill injection statistics — tracks match counts, hit rates, timing.
 * In-memory counters, reset on process restart.
 */

export interface SkillHit {
  id: string
  count: number
  lastHit: string // ISO timestamp
}

export interface SkillStats {
  totalQueries: number
  hits: number
  misses: number
  hitRate: number
  avgMatchMs: number
  topSkills: SkillHit[]
  lastQueryAt: string | null
}

// ─── Internal counters ───

let totalQueries = 0
let hits = 0
let misses = 0
let totalMatchMs = 0
let lastQueryAt: string | null = null
const skillHits = new Map<string, { count: number; lastHit: string }>()

/**
 * Record a skill injection attempt.
 */
export function recordInjection(matchedIds: string[], matchMs: number): void {
  totalQueries++
  totalMatchMs += matchMs
  lastQueryAt = new Date().toISOString()

  if (matchedIds.length > 0) {
    hits++
    for (const id of matchedIds) {
      const existing = skillHits.get(id)
      if (existing) {
        existing.count++
        existing.lastHit = lastQueryAt
      } else {
        skillHits.set(id, { count: 1, lastHit: lastQueryAt })
      }
    }
  } else {
    misses++
  }
}

/**
 * Get current skill injection stats.
 */
export function getSkillStats(): SkillStats {
  const topSkills: SkillHit[] = [...skillHits.entries()]
    .map(([id, { count, lastHit }]) => ({ id, count, lastHit }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  return {
    totalQueries,
    hits,
    misses,
    hitRate: totalQueries > 0 ? hits / totalQueries : 0,
    avgMatchMs: totalQueries > 0 ? Math.round(totalMatchMs / totalQueries * 100) / 100 : 0,
    topSkills,
    lastQueryAt,
  }
}

/**
 * Reset all stats (for testing).
 */
export function resetSkillStats(): void {
  totalQueries = 0
  hits = 0
  misses = 0
  totalMatchMs = 0
  lastQueryAt = null
  skillHits.clear()
}
