/**
 * Skill store — CRUD operations for learned skills on disk.
 * Storage: ~/.owlcoda/skills/<id>/SKILL.md + metadata.json
 */

import { readFile, writeFile, readdir, mkdir, rm, stat, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { getOwlcodaDir } from '../paths.js'
import type { SkillDocument, SkillMetadata } from './schema.js'
import { toMetadata, renderSkillMd, isValidSkillId } from './schema.js'
import { curatedToDocument } from './curated.js'

// ─── Paths ───

function getSkillsDir(): string {
  return join(getOwlcodaDir(), 'skills')
}

function getSkillDir(id: string): string {
  return join(getSkillsDir(), id)
}

function getMetadataPath(id: string): string {
  return join(getSkillDir(id), 'metadata.json')
}

function getSkillMdPath(id: string): string {
  return join(getSkillDir(id), 'SKILL.md')
}

// ─── Ensure directory ───

async function ensureSkillsDir(): Promise<void> {
  const dir = getSkillsDir()
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
}

// ─── CRUD ───

/**
 * Save a skill document to disk.
 */
export async function saveSkill(skill: SkillDocument): Promise<void> {
  if (!isValidSkillId(skill.id)) {
    throw new Error(`Invalid skill ID: "${skill.id}" (must be kebab-case, 3-80 chars)`)
  }

  await ensureSkillsDir()
  const dir = getSkillDir(skill.id)
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }

  // Write metadata.json (full document for programmatic access)
  await writeFile(getMetadataPath(skill.id), JSON.stringify(skill, null, 2), 'utf-8')

  // Write SKILL.md (human-readable, upstream-compatible)
  await writeFile(getSkillMdPath(skill.id), renderSkillMd(skill), 'utf-8')
}

/**
 * Load a skill document by ID.
 */
export async function loadSkill(id: string): Promise<SkillDocument | null> {
  if (!isValidSkillId(id)) return null

  const metaPath = getMetadataPath(id)
  if (existsSync(metaPath)) {
    try {
      const raw = await readFile(metaPath, 'utf-8')
      return JSON.parse(raw) as SkillDocument
    } catch {
      return null
    }
  }

  const skillMdPath = getSkillMdPath(id)
  if (!existsSync(skillMdPath)) return null

  try {
    const raw = await readFile(skillMdPath, 'utf-8')
    if (raw.trim().length === 0) return null
    return curatedToDocument(id, id, raw)
  } catch {
    return null
  }
}

/**
 * Delete a skill by ID.
 */
export async function deleteSkill(id: string): Promise<boolean> {
  const dir = getSkillDir(id)
  if (!existsSync(dir)) return false

  await rm(dir, { recursive: true, force: true })
  return true
}

/**
 * List all skill metadata (lightweight).
 */
export async function listSkills(): Promise<SkillMetadata[]> {
  const dir = getSkillsDir()
  if (!existsSync(dir)) return []

  const entries = await readdir(dir)
  const skills: SkillMetadata[] = []

  for (const entry of entries.sort()) {
    const entryPath = join(dir, entry)
    try {
      const s = await stat(entryPath)
      if (!s.isDirectory()) continue
      const doc = await loadSkill(entry)
      if (doc) skills.push(toMetadata(doc))
    } catch {
      continue
    }
  }

  return skills
}

/**
 * Check if a skill exists.
 */
export async function skillExists(id: string): Promise<boolean> {
  if (!isValidSkillId(id)) return false
  return existsSync(getMetadataPath(id)) || existsSync(getSkillMdPath(id))
}

/**
 * Increment use count for a skill.
 */
export async function recordSkillUse(id: string): Promise<void> {
  const skill = await loadSkill(id)
  if (!skill) return

  skill.useCount++
  skill.updatedAt = new Date().toISOString()
  await saveSkill(skill)
}

/**
 * Get total skill count.
 */
export async function getSkillCount(): Promise<number> {
  const dir = getSkillsDir()
  if (!existsSync(dir)) return 0

  const entries = await readdir(dir)
  let count = 0
  for (const entry of entries) {
    if (await loadSkill(entry)) count++
  }
  return count
}

/**
 * Evolve a skill — update an existing skill with new content, preserving lineage.
 * Increments version, updates content, and records parent if evolving to a new ID.
 */
export async function evolveSkill(
  existingId: string,
  updates: Partial<Pick<SkillDocument, 'name' | 'description' | 'procedure' | 'pitfalls' | 'verification' | 'tags' | 'whenToUse'>>,
  options?: { newId?: string },
): Promise<SkillDocument | null> {
  const existing = await loadSkill(existingId)
  if (!existing) return null

  const currentVersion = existing.version ?? 1
  const now = new Date().toISOString()

  if (options?.newId && options.newId !== existingId) {
    // Fork — create new skill linked to parent
    const evolved: SkillDocument = {
      ...existing,
      ...updates,
      id: options.newId,
      version: 1,
      parentId: existingId,
      createdAt: now,
      updatedAt: now,
      useCount: 0,
    }
    await saveSkill(evolved)
    return evolved
  }

  // In-place evolution — same ID, bump version
  const evolved: SkillDocument = {
    ...existing,
    ...updates,
    version: currentVersion + 1,
    updatedAt: now,
  }
  await saveSkill(evolved)
  return evolved
}

/**
 * Get version history for a skill (by following parentId chain).
 */
export async function getSkillLineage(id: string): Promise<SkillDocument[]> {
  const lineage: SkillDocument[] = []
  let currentId: string | undefined = id

  while (currentId) {
    const skill = await loadSkill(currentId)
    if (!skill) break
    lineage.push(skill)
    currentId = skill.parentId
  }

  return lineage
}

/**
 * Load learned skills from ~/.owlcoda/skills/ (user-synthesized).
 */
export async function loadLearnedSkills(): Promise<SkillDocument[]> {
  const dir = getSkillsDir()
  if (!existsSync(dir)) return []

  const entries = await readdir(dir)
  const skills: SkillDocument[] = []

  for (const entry of entries.sort()) {
    try {
      const skill = await loadSkill(entry)
      if (skill) skills.push(skill)
    } catch {
      continue
    }
  }

  return skills
}

/**
 * Load all full skill documents (for matching).
 * Merges curated skills (project's skills/), learned skills (~/.owlcoda/skills/),
 * and vendored third-party skills (.owlcoda/skills.json).
 * First-party (curated) skills win on ID collisions.
 * @param projectRoot — root directory of the current project (default: process.cwd())
 */
export async function loadAllSkills(projectRoot: string = process.cwd()): Promise<SkillDocument[]> {
  const { loadCuratedSkills } = await import('./curated.js')
  const { loadVendoredThirdPartySkills } = await import('./third-party.js')
  const [curated, learned, thirdParty] = await Promise.all([
    loadCuratedSkills(),
    loadLearnedSkills(),
    loadVendoredThirdPartySkills(projectRoot),
  ])

  // Merge: third-party lowest precedence, then learned, then curated (first-party wins)
  const byId = new Map<string, SkillDocument>()
  for (const skill of thirdParty) byId.set(skill.id, skill)   // lowest precedence
  for (const skill of learned) byId.set(skill.id, skill)
  for (const skill of curated) byId.set(skill.id, skill)      // first-party wins

  return [...byId.values()]
}

// ─── Export / Import ───

export interface SkillBundle {
  version: 1
  exportedAt: string
  source: string
  skills: SkillDocument[]
}

/**
 * Export skills as a portable JSON bundle.
 * @param ids — if provided, export only these skills. If empty, export all learned skills.
 */
export async function exportSkills(ids?: string[]): Promise<SkillBundle> {
  let skills: SkillDocument[]
  if (ids && ids.length > 0) {
    skills = []
    for (const id of ids) {
      const s = await loadSkill(id)
      if (s) skills.push(s)
    }
  } else {
    // Export learned skills only (curated are bundled with the project)
    skills = await loadLearnedSkills()
  }

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    source: 'owlcoda',
    skills,
  }
}

export interface ImportResult {
  imported: number
  skipped: number
  errors: string[]
}

/**
 * Import skills from a JSON bundle.
 * @param overwrite — if true, overwrite existing skills. Default: false (skip).
 */
export async function importSkills(bundle: SkillBundle, overwrite: boolean = false): Promise<ImportResult> {
  if (bundle.version !== 1) {
    return { imported: 0, skipped: 0, errors: [`Unsupported bundle version: ${bundle.version}`] }
  }
  if (!Array.isArray(bundle.skills)) {
    return { imported: 0, skipped: 0, errors: ['Invalid bundle: "skills" must be an array'] }
  }

  const result: ImportResult = { imported: 0, skipped: 0, errors: [] }

  for (const skill of bundle.skills) {
    try {
      if (!isValidSkillId(skill.id)) {
        result.errors.push(`Invalid skill ID: "${skill.id}"`)
        continue
      }

      const exists = await skillExists(skill.id)
      if (exists && !overwrite) {
        result.skipped++
        continue
      }

      await saveSkill(skill)
      result.imported++
    } catch (err) {
      result.errors.push(`Failed to import "${skill.id}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return result
}

/**
 * Import skills from a JSON bundle, a Claude-style SKILL.md file, or a
 * directory containing SKILL.md. Directory imports preserve references,
 * scripts, and assets alongside normalized OwlCoda metadata.
 */
export async function importSkillsFromPath(inputPath: string, overwrite: boolean = false): Promise<ImportResult> {
  const sourcePath = resolve(inputPath)

  try {
    const s = await stat(sourcePath)

    if (s.isDirectory()) {
      return importSkillPackageDir(sourcePath, overwrite)
    }

    if (s.isFile() && basename(sourcePath).toLowerCase() === 'skill.md') {
      return importSkillPackageDir(dirname(sourcePath), overwrite)
    }

    const raw = await readFile(sourcePath, 'utf-8')
    return importSkills(JSON.parse(raw) as SkillBundle, overwrite)
  } catch (err) {
    return {
      imported: 0,
      skipped: 0,
      errors: [`Failed to import "${inputPath}": ${err instanceof Error ? err.message : String(err)}`],
    }
  }
}

async function importSkillPackageDir(sourceDir: string, overwrite: boolean): Promise<ImportResult> {
  const id = basename(sourceDir)
  if (!isValidSkillId(id)) {
    return { imported: 0, skipped: 0, errors: [`Invalid skill ID: "${id}"`] }
  }

  const skillMdPath = join(sourceDir, 'SKILL.md')
  if (!existsSync(skillMdPath)) {
    return { imported: 0, skipped: 0, errors: [`Missing SKILL.md in "${sourceDir}"`] }
  }

  const raw = await readFile(skillMdPath, 'utf-8')
  if (raw.trim().length === 0) {
    return { imported: 0, skipped: 0, errors: [`Empty SKILL.md in "${sourceDir}"`] }
  }

  const destDir = getSkillDir(id)
  const sourceIsInstalled = resolve(sourceDir) === resolve(destDir)
  const metadataExists = existsSync(getMetadataPath(id))
  const exists = await skillExists(id)

  if (exists && !overwrite && !(sourceIsInstalled && !metadataExists)) {
    return { imported: 0, skipped: 1, errors: [] }
  }

  const skill = curatedToDocument(id, id, raw)
  await ensureSkillsDir()

  if (!sourceIsInstalled) {
    if (overwrite) {
      await rm(destDir, { recursive: true, force: true })
    }

    const sourceRoot = resolve(sourceDir)
    await cp(sourceDir, destDir, {
      recursive: true,
      filter: src => {
        const rel = resolve(src).slice(sourceRoot.length + 1)
        return !rel.split(/[\\/]/).some(part => part === '.git' || part === 'node_modules')
      },
    })
  }

  await saveSkill(skill)
  return { imported: 1, skipped: 0, errors: [] }
}

// ─── Cleanup ───

export interface CleanupConfig {
  /** Max days since last use before marking stale (default: 90) */
  staleDays: number
  /** Min useCount to be exempt from cleanup (default: 3) */
  minUseCount: number
  /** Actually delete — if false, just report (default: false) */
  dryRun: boolean
}

export interface CleanupResult {
  stale: string[]
  unused: string[]
  removed: string[]
  kept: number
}

/**
 * Identify and optionally remove stale/unused learned skills.
 * Only operates on learned skills (~/.owlcoda/skills/), not curated skills.
 */
export async function cleanupSkills(config: Partial<CleanupConfig> = {}): Promise<CleanupResult> {
  const { staleDays = 90, minUseCount = 3, dryRun = true } = config
  const skills = await loadLearnedSkills()
  const now = Date.now()
  const staleThreshold = staleDays * 24 * 60 * 60 * 1000

  const stale: string[] = []
  const unused: string[] = []
  const removed: string[] = []

  for (const skill of skills) {
    const updatedAt = new Date(skill.updatedAt).getTime()
    const age = now - updatedAt
    const isStale = age > staleThreshold
    const isUnused = (skill.useCount ?? 0) === 0

    if (isStale && isUnused) {
      stale.push(skill.id)
      unused.push(skill.id)
      if (!dryRun) {
        await deleteSkill(skill.id)
        removed.push(skill.id)
      }
    } else if (isStale && (skill.useCount ?? 0) < minUseCount) {
      stale.push(skill.id)
      if (!dryRun) {
        await deleteSkill(skill.id)
        removed.push(skill.id)
      }
    } else if (isUnused) {
      unused.push(skill.id)
    }
  }

  return {
    stale,
    unused,
    removed,
    kept: skills.length - removed.length,
  }
}
