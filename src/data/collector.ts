/**
 * Training data collector — auto-collects high-quality sessions.
 *
 * On session end, scores quality. If above threshold, appends JSONL
 * to ~/.owlcoda/training/collected.jsonl and updates manifest.
 *
 * Part of L3 data pipeline.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Session } from '../history/sessions.js'
import { scoreSession } from './quality.js'
import { sessionToJsonl } from './export.js'
import { sanitizeText } from './sanitize.js'

// ─── Types ───

export interface CollectorConfig {
  /** Master switch — defaults to false (opt-in). Override at runtime via
   *  config.trainingCollection or env OWLCODA_TRAINING_COLLECTION=1 */
  enabled: boolean
  /** Min quality score to collect (default: 60) */
  minQuality: number
  /** Min messages to consider (default: 4) */
  minMessages: number
  /** Max collected file size in bytes before rotation (default: 50MB) */
  maxFileSize: number
  /** Output directory (default: ~/.owlcoda/training) */
  outputDir: string
}

export interface CollectResult {
  collected: boolean
  quality: number
  reason?: string
  path?: string
}

export interface CollectorManifest {
  totalCollected: number
  totalSkipped: number
  lastCollectedAt: string
  averageQuality: number
  qualitySum: number
}

// ─── Config ───

const DEFAULT_CONFIG: CollectorConfig = {
  enabled: false,
  minQuality: 60,
  minMessages: 4,
  maxFileSize: 50 * 1024 * 1024, // 50MB
  outputDir: join(process.env.OWLCODA_HOME ?? join(process.env.HOME ?? '/tmp', '.owlcoda'), 'training'),
}

let config: CollectorConfig = { ...DEFAULT_CONFIG }

export function configureCollector(overrides: Partial<CollectorConfig>): void {
  config = { ...config, ...overrides }
}

export function getCollectorConfig(): Readonly<CollectorConfig> {
  return { ...config }
}

export function resetCollectorConfig(): void {
  config = { ...DEFAULT_CONFIG }
}

/** Authoritative gate — env var wins over config to allow ad-hoc enable/disable
 *  without restart. Returns true only when collection is explicitly enabled. */
export function isTrainingCollectionEnabled(): boolean {
  const envOverride = process.env.OWLCODA_TRAINING_COLLECTION
  if (envOverride === '1' || envOverride === 'true') return true
  if (envOverride === '0' || envOverride === 'false') return false
  return config.enabled === true
}

// ─── Manifest ───

async function loadManifest(dir: string): Promise<CollectorManifest> {
  try {
    const raw = await readFile(join(dir, 'manifest.json'), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return { totalCollected: 0, totalSkipped: 0, lastCollectedAt: '', averageQuality: 0, qualitySum: 0 }
  }
}

async function saveManifest(dir: string, manifest: CollectorManifest): Promise<void> {
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
}

// ─── Core ───

/**
 * Evaluate and optionally collect a session for training.
 * Appends to collected.jsonl if quality threshold is met.
 */
export async function collectSession(session: Session): Promise<CollectResult> {
  // Master gate — opt-in only. Skips quality scoring entirely when off.
  if (!isTrainingCollectionEnabled()) {
    return { collected: false, quality: 0, reason: 'Training data collection is disabled (set config.trainingCollection=true or OWLCODA_TRAINING_COLLECTION=1 to enable)' }
  }

  // Pre-check
  if (session.messages.length < config.minMessages) {
    return { collected: false, quality: 0, reason: `Too few messages (${session.messages.length} < ${config.minMessages})` }
  }

  // Score
  const quality = scoreSession(session)

  if (quality.overall < config.minQuality) {
    // Update manifest skip count
    try {
      await mkdir(config.outputDir, { recursive: true })
      const manifest = await loadManifest(config.outputDir)
      manifest.totalSkipped++
      await saveManifest(config.outputDir, manifest)
    } catch { /* non-fatal */ }

    return { collected: false, quality: quality.overall, reason: `Quality too low (${quality.overall} < ${config.minQuality})` }
  }

  // Convert to JSONL with PII sanitization
  const line = sessionToJsonl(session.messages)
  if (!line) {
    return { collected: false, quality: quality.overall, reason: 'Could not convert to JSONL (insufficient content)' }
  }
  const sanitizedLine = sanitizeText(line).text

  // Append
  await mkdir(config.outputDir, { recursive: true })
  const filePath = join(config.outputDir, 'collected.jsonl')
  await appendFile(filePath, sanitizedLine + '\n')

  // Update manifest
  const manifest = await loadManifest(config.outputDir)
  manifest.totalCollected++
  manifest.qualitySum += quality.overall
  manifest.averageQuality = Math.round(manifest.qualitySum / manifest.totalCollected)
  manifest.lastCollectedAt = new Date().toISOString()
  await saveManifest(config.outputDir, manifest)

  return { collected: true, quality: quality.overall, path: filePath }
}

/**
 * Fire-and-forget wrapper — logs but never throws.
 */
export async function onSessionEndCollect(session: Session): Promise<CollectResult> {
  try {
    const result = await collectSession(session)
    if (result.collected) {
      console.error(`[collector] Session ${session.meta.id} collected (quality: ${result.quality})`)
    }
    return result
  } catch (err) {
    console.error(`[collector] Error: ${err instanceof Error ? err.message : err}`)
    return { collected: false, quality: 0, reason: `Error: ${err instanceof Error ? err.message : 'unknown'}` }
  }
}
