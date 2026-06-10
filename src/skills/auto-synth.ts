/**
 * Auto-synthesis — automatically synthesize skills from complex sessions.
 * Triggered when a session ends with sufficient complexity.
 *
 * This is a built-in behavior, not a plugin. It runs inline when
 * session persistence detects a session with tool calls above threshold.
 */

import type { Session } from '../history/sessions.js'
import { analyzeSession } from './trace-analyzer.js'
import { isWorthSynthesizing, synthesizeTemplate } from './synthesizer.js'
import { saveSkill, skillExists, loadAllSkills } from './store.js'
import { invalidateSkillIndex } from './injection.js'
import { buildIndex, matchSkills } from './matcher.js'
import type { SkillDocument } from './schema.js'
import { onSessionEndCollect } from '../data/collector.js'
import { logWarn } from '../logger.js'

// ─── Types ───

export interface AutoSynthResult {
  /** Whether synthesis was attempted */
  attempted: boolean
  /** Whether a new skill was saved */
  saved: boolean
  /** The skill (if synthesized) */
  skill?: SkillDocument
  /** Reason if not attempted */
  reason?: string
}

// ─── Configuration ───

export interface AutoSynthConfig {
  /** Enable/disable auto-synthesis */
  enabled: boolean
  /** Minimum tool calls to trigger */
  minToolCalls: number
  /** Minimum complexity score to trigger */
  minComplexity: number
  /** Minimum messages in session */
  minMessages: number
  /** Skip if skill with same ID already exists */
  skipDuplicates: boolean
}

const DEFAULT_CONFIG: AutoSynthConfig = {
  enabled: true,
  minToolCalls: 3,
  minComplexity: 20,
  minMessages: 6,
  skipDuplicates: true,
}

let config: AutoSynthConfig = { ...DEFAULT_CONFIG }

/**
 * Configure auto-synthesis behavior.
 */
export function configureAutoSynth(overrides: Partial<AutoSynthConfig>): void {
  config = { ...config, ...overrides }
}

/**
 * Get current auto-synthesis configuration.
 */
export function getAutoSynthConfig(): Readonly<AutoSynthConfig> {
  return { ...config }
}

/**
 * Reset configuration to defaults.
 */
export function resetAutoSynthConfig(): void {
  config = { ...DEFAULT_CONFIG }
}

// ─── Similarity detection ───

const SIMILARITY_THRESHOLD = 0.7 // Skills above this similarity are considered duplicates

/**
 * Check if a skill is semantically similar to any existing skill.
 * Returns the similar skill if found, null otherwise.
 */
export async function findSimilarSkill(candidate: SkillDocument): Promise<SkillDocument | null> {
  const existing = await loadAllSkills()
  if (existing.length === 0) return null

  const index = buildIndex(existing)
  // Build query text from the candidate's content
  const queryText = [
    candidate.name,
    candidate.description,
    candidate.whenToUse,
    ...candidate.tags,
    ...candidate.procedure.map(s => s.action),
  ].join(' ')

  const matches = matchSkills(queryText, index, { topK: 1, threshold: SIMILARITY_THRESHOLD, boostUsage: false })
  if (matches.length > 0) {
    return matches[0].skill
  }
  return null
}

// ─── Core logic ───

/**
 * Evaluate a session for auto-synthesis. Called when a session ends.
 * This is designed to be fast and non-blocking — template mode only.
 */
export async function evaluateSession(session: Session): Promise<AutoSynthResult> {
  if (!config.enabled) {
    return { attempted: false, saved: false, reason: 'Auto-synthesis disabled' }
  }

  // Quick pre-check: enough messages?
  if (session.messages.length < config.minMessages) {
    return { attempted: false, saved: false, reason: `Too few messages (${session.messages.length} < ${config.minMessages})` }
  }

  // Analyze the session
  const trace = analyzeSession(session)

  // Check thresholds
  if (trace.toolCalls.length < config.minToolCalls) {
    return { attempted: false, saved: false, reason: `Too few tool calls (${trace.toolCalls.length} < ${config.minToolCalls})` }
  }

  if (trace.complexity < config.minComplexity) {
    return { attempted: false, saved: false, reason: `Complexity too low (${trace.complexity} < ${config.minComplexity})` }
  }

  // Worth synthesizing?
  const check = isWorthSynthesizing(trace)
  if (!check.worth) {
    return { attempted: false, saved: false, reason: check.reason }
  }

  // Synthesize (template mode for speed)
  const result = synthesizeTemplate(trace)

  // Check for duplicates — exact ID match
  if (config.skipDuplicates) {
    const exists = await skillExists(result.skill.id)
    if (exists) {
      return { attempted: true, saved: false, skill: result.skill, reason: `Skill '${result.skill.id}' already exists` }
    }
  }

  // Check for semantic duplicates — content similarity
  if (config.skipDuplicates) {
    const similar = await findSimilarSkill(result.skill)
    if (similar) {
      return { attempted: true, saved: false, skill: result.skill, reason: `Too similar to existing skill '${similar.id}' — skipped` }
    }
  }

  // Save
  await saveSkill(result.skill)
  invalidateSkillIndex()

  return { attempted: true, saved: true, skill: result.skill }
}

// ─── Plugin hook integration ───

/**
 * Add onSessionEnd hook to the plugin system.
 * This extends the existing plugin types with a session end event.
 */
export interface SessionEndHookContext {
  sessionId: string
  messageCount: number
  model: string
  durationSec: number
}

/**
 * Run auto-synthesis as a fire-and-forget operation.
 * Logs results but never throws.
 */
export async function onSessionEnd(session: Session): Promise<AutoSynthResult> {
  // Fire training data collection in parallel (non-blocking)
  onSessionEndCollect(session).catch(e => logWarn('auto-synth', `Failed to collect training data: ${e}`))

  try {
    const result = await evaluateSession(session)
    if (result.saved && result.skill) {
      console.error(`[auto-synth] New skill learned: ${result.skill.id} (from session ${session.meta.id})`)
    }
    return result
  } catch (err) {
    console.error(`[auto-synth] Error: ${err instanceof Error ? err.message : err}`)
    return { attempted: false, saved: false, reason: `Error: ${err instanceof Error ? err.message : 'unknown'}` }
  }
}
