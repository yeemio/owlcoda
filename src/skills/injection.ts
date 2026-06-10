/**
 * Skill injection — matches incoming messages against learned skills
 * and injects relevant skills into the system prompt.
 */

import type { SkillDocument } from './schema.js'
import { renderSkillMd } from './schema.js'
import { loadAllSkills, recordSkillUse } from './store.js'
import { buildIndex, matchSkills } from './matcher.js'
import type { SkillIndex, MatchResult } from './matcher.js'
import { logWarn } from '../logger.js'
import { recordInjection } from './stats.js'
import { logDebug, logInfo } from '../logger.js'
import { isLazySkillsEnabled, buildSkillCatalog } from './lazy-skills.js'

// ─── Cached index (per projectRoot) ───

const indexCache = new Map<string, { index: SkillIndex; builtAt: number }>()
const INDEX_TTL_MS = 60_000 // rebuild index every 60s

/**
 * Get or rebuild the skill index for the given project root.
 */
export async function getSkillIndex(projectRoot: string): Promise<SkillIndex> {
  const now = Date.now()
  const hit = indexCache.get(projectRoot)
  if (hit && now - hit.builtAt < INDEX_TTL_MS) return hit.index
  const skills = await loadAllSkills(projectRoot)
  const index = buildIndex(skills)
  indexCache.set(projectRoot, { index, builtAt: now })
  return index
}

/**
 * Force index rebuild (e.g., after skill save/delete).
 * If projectRoot is provided, only that project's cache is cleared.
 * If not provided, clears all cached indices.
 */
export function invalidateSkillIndex(projectRoot?: string): void {
  if (projectRoot) indexCache.delete(projectRoot)
  else indexCache.clear()
}

/**
 * Extract user text from Anthropic messages for matching.
 */
export function extractUserQuery(messages: unknown[]): string {
  const texts: string[] = []
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    const m = msg as Record<string, unknown>
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') {
      texts.push(m.content)
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
          texts.push(String((block as Record<string, unknown>).text ?? ''))
        }
      }
    }
  }
  // Use last 3 user messages for matching (most recent context)
  return texts.slice(-3).join('\n')
}

/**
 * Match and inject skills into system prompt.
 * Returns the augmented system prompt and matched skill IDs.
 */
export async function injectSkills(
  system: unknown,
  messages: unknown[],
  options: { projectRoot: string; topK?: number; threshold?: number; disabled?: boolean; lazy?: boolean },
): Promise<{ system: unknown; matchedSkills: MatchResult[]; injectedIds: string[] }> {
  if (options.disabled) {
    return { system, matchedSkills: [], injectedIds: [] }
  }

  const t0 = Date.now()
  const index = await getSkillIndex(options.projectRoot)
  if (index.docCount === 0) {
    const ms = Date.now() - t0
    recordInjection([], ms)
    logDebug('skills', 'No skills in index', { matchMs: ms })
    return { system, matchedSkills: [], injectedIds: [] }
  }

  // Lazy mode: inject a name-only catalog of ALL skills (cheap, cacheable) and
  // let the model pull a body on demand via the Skill tool. Opt-in; default off
  // (eager top-K matching below is unchanged). No query/matching needed.
  if (options.lazy ?? isLazySkillsEnabled()) {
    const all = [...index.skills.values()]
    const catalog = buildSkillCatalog(all.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      ...(s.whenToUse ? { whenToUse: s.whenToUse } : {}),
    })))
    const block = ['', '<skill_catalog>', catalog, '</skill_catalog>'].join('\n')
    const ms = Date.now() - t0
    recordInjection([], ms)
    logInfo('skills', 'Lazy skill catalog injected', { count: all.length, matchMs: ms })
    return {
      system: augmentSystem(system, block),
      matchedSkills: [],
      injectedIds: all.length > 0 ? ['skill-catalog'] : [],
    }
  }

  const query = extractUserQuery(messages)
  if (!query) {
    const ms = Date.now() - t0
    recordInjection([], ms)
    logDebug('skills', 'Empty query — skip matching', { matchMs: ms })
    return { system, matchedSkills: [], injectedIds: [] }
  }

  const { topK = 2, threshold = 0.1 } = options
  const matches = matchSkills(query, index, { topK, threshold })
  const ms = Date.now() - t0
  const matchedIds = matches.map(m => m.skill.id)
  recordInjection(matchedIds, ms)

  const querySummary = query.length > 80 ? query.slice(0, 80) + '…' : query

  if (matches.length === 0) {
    logDebug('skills', 'No match', { query: querySummary, matchMs: ms, docCount: index.docCount })
    return { system, matchedSkills: matches, injectedIds: [] }
  }

  logInfo('skills', 'Injected', {
    query: querySummary,
    matched: matchedIds,
    scores: matches.map(m => Math.round(m.score * 1000) / 1000),
    matchMs: ms,
  })

  // Build skill injection block
  const skillBlock = buildSkillBlock(matches.map(m => m.skill))
  const injectedIds = matchedIds

  // Record usage
  for (const id of injectedIds) {
    await recordSkillUse(id).catch(e => logWarn('skill-inject', `Failed to record skill use for ${id}: ${e}`))
  }

  // Augment system prompt
  const augmented = augmentSystem(system, skillBlock)

  return { system: augmented, matchedSkills: matches, injectedIds }
}

/**
 * Build the skill injection block to append to system prompt.
 */
function buildSkillBlock(skills: SkillDocument[]): string {
  const lines = [
    '',
    '<learned_skills>',
    `The following ${skills.length} skill(s) were auto-matched from your skill library:`,
    '',
  ]

  for (const skill of skills) {
    lines.push(`--- Skill: ${skill.name} ---`)
    lines.push(renderSkillMd(skill))
    lines.push('')
  }

  lines.push('</learned_skills>')
  return lines.join('\n')
}

/**
 * Augment the system prompt with skill injection.
 * Handles string, array (Anthropic content blocks), or undefined system.
 */
function augmentSystem(system: unknown, skillBlock: string): unknown {
  if (typeof system === 'string') {
    return system + '\n' + skillBlock
  }

  if (Array.isArray(system)) {
    // Anthropic system can be array of content blocks
    return [...system, { type: 'text', text: skillBlock }]
  }

  // No system prompt — create one with just the skills
  return skillBlock.trim()
}

// ─── Testing helpers ───

export function _resetIndex(): void {
  invalidateSkillIndex()
}
