/**
 * Curated skills loader — reads SKILL.md files from the project's skills/ directory
 * and converts them to SkillDocument format for the matcher index.
 *
 * Curated skills use YAML frontmatter:
 *   ---
 *   name: Skill Name
 *   description: Short description
 *   when_to_use: When to apply this skill
 *   ---
 *   # Markdown body
 *
 * The skill ID is derived from the leaf directory name (e.g., skills/debugging/root-cause-tracing → "root-cause-tracing").
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SkillDocument } from './schema.js'

// ─── Project root ───

function getProjectRoot(): string {
  // src/skills/curated.ts → ../../ = project root
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

/** Exported for testing */
export function getCuratedSkillsDir(): string {
  return join(getProjectRoot(), 'skills')
}

// ─── YAML frontmatter parser ───

interface SkillFrontmatter {
  name?: string
  description?: string
  when_to_use?: string
  version?: string
  languages?: string
}

/**
 * Parse YAML-style frontmatter from a SKILL.md file.
 * Returns { frontmatter, body }.
 */
export function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
  if (!match) {
    return { frontmatter: {}, body: content }
  }

  const yaml = match[1]!
  const body = match[2]!
  const frontmatter: SkillFrontmatter = {}

  for (const line of yaml.split('\n')) {
    const kv = line.match(/^(\w[\w_]*):\s*(.+)$/)
    if (kv) {
      const key = kv[1]! as keyof SkillFrontmatter
      frontmatter[key] = kv[2]!.trim()
    }
  }

  return { frontmatter, body }
}

// ─── Extract tags from body ───

/**
 * Extract meaningful tags from the skill's markdown body and path.
 */
function extractTags(id: string, relPath: string, frontmatter: SkillFrontmatter, body: string): string[] {
  const tags = new Set<string>()

  // Category from path (e.g., "debugging", "collaboration", "testing")
  const parts = relPath.split('/')
  if (parts.length > 1) {
    tags.add(parts[0]!)
  }

  // ID segments
  for (const seg of id.split('-')) {
    if (seg.length > 2) tags.add(seg)
  }

  // Languages
  if (frontmatter.languages && frontmatter.languages !== 'all') {
    for (const lang of frontmatter.languages.split(/[,\s]+/)) {
      if (lang.length > 1) tags.add(lang.toLowerCase())
    }
  }

  // Section headers as tags
  const headers = body.match(/^#+\s+(.+)$/gm) ?? []
  for (const h of headers) {
    const text = h.replace(/^#+\s+/, '').toLowerCase()
    for (const word of text.split(/\s+/)) {
      if (word.length > 3) tags.add(word)
    }
  }

  return [...tags].slice(0, 20)
}

/**
 * Extract pitfalls from common markdown patterns (Red Flags, Anti-patterns, Common Mistakes, etc.)
 */
function extractPitfalls(body: string): Array<{ description: string; mitigation: string }> {
  const pitfalls: Array<{ description: string; mitigation: string }> = []
  const pitfallHeaders = /^##\s+(Red Flags?|Anti.?[Pp]atterns?|Common (?:Mistakes?|Rationalizations?)|Pitfalls?|Warning|Don'?t|Never|Avoid)/gmi
  const sections = body.split(/^## /m)

  for (const section of sections) {
    const firstLine = section.split('\n')[0]?.trim() ?? ''
    if (!pitfallHeaders.test('## ' + firstLine)) continue
    // Reset regex lastIndex
    pitfallHeaders.lastIndex = 0

    // Extract bullet points as pitfalls
    const bullets = section.match(/^[-*]\s+.+$/gm) ?? []
    for (const bullet of bullets.slice(0, 5)) {
      const text = bullet.replace(/^[-*]\s+/, '').trim()
      pitfalls.push({ description: text, mitigation: '' })
    }
  }

  return pitfalls.slice(0, 10)
}

// ─── Convert to SkillDocument ───

/**
 * Convert a curated SKILL.md to SkillDocument format.
 */
export function curatedToDocument(
  id: string,
  relPath: string,
  content: string,
): SkillDocument {
  const { frontmatter, body } = parseFrontmatter(content)
  const name = frontmatter.name ?? id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  const description = frontmatter.description ?? ''
  const whenToUse = frontmatter.when_to_use ?? ''
  const tags = extractTags(id, relPath, frontmatter, body)

  // Extract top-level sections as procedure steps
  // Include more body text for better TF-IDF matching
  const sections = body.split(/^## /m).filter(Boolean)
  const procedure = sections.slice(0, 10).map((section, i) => {
    const firstLine = section.split('\n')[0]?.trim() ?? ''
    const rest = section.split('\n').slice(1).join('\n').trim()
    return {
      order: i + 1,
      action: firstLine,
      detail: rest.slice(0, 500) || undefined,
    }
  })

  // Extract pitfalls from common markdown patterns
  const pitfalls = extractPitfalls(body)

  return {
    id,
    name,
    description,
    procedure,
    pitfalls,
    verification: [],
    tags,
    whenToUse,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    useCount: 0,
    synthesisMode: 'manual',
    version: 1,
  }
}

// ─── Recursive SKILL.md finder ───

/**
 * Recursively find all SKILL.md files under a directory.
 * Returns array of { id, relPath, fullPath }.
 */
async function findSkillFiles(
  baseDir: string,
  currentDir: string = baseDir,
): Promise<Array<{ id: string; relPath: string; fullPath: string }>> {
  if (!existsSync(currentDir)) return []

  const results: Array<{ id: string; relPath: string; fullPath: string }> = []
  const entries = await readdir(currentDir)

  for (const entry of entries.sort()) {
    const fullPath = join(currentDir, entry)
    const s = await stat(fullPath)

    if (s.isDirectory()) {
      // Check if this directory has a SKILL.md
      const skillMd = join(fullPath, 'SKILL.md')
      if (existsSync(skillMd)) {
        const id = basename(fullPath)
        const relFromBase = fullPath.slice(baseDir.length + 1)
        results.push({ id, relPath: relFromBase, fullPath: skillMd })
      }
      // Recurse into subdirectories
      const nested = await findSkillFiles(baseDir, fullPath)
      results.push(...nested)
    }
  }

  return results
}

// ─── Public API ───

/**
 * Load all curated skills from the project's skills/ directory.
 * Returns SkillDocument[] ready for the matcher index.
 */
export async function loadCuratedSkills(): Promise<SkillDocument[]> {
  const dir = getCuratedSkillsDir()
  if (!existsSync(dir)) return []

  const files = await findSkillFiles(dir)
  const skills: SkillDocument[] = []
  const seen = new Set<string>()

  for (const { id, relPath, fullPath } of files) {
    // Skip duplicate IDs (first occurrence wins)
    if (seen.has(id)) continue
    seen.add(id)

    try {
      const content = await readFile(fullPath, 'utf-8')
      if (content.trim().length === 0) continue
      skills.push(curatedToDocument(id, relPath, content))
    } catch {
      continue
    }
  }

  return skills
}
