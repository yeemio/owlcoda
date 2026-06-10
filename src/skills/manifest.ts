import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

export interface ThirdPartySkillEntry {
  id: string
  source: string
  requestedRef: string
  pinnedRef: string
  skillPath?: string
  integrity: string
  vendoredPath: string
  origin: 'third-party'
  addedAt: string
}

export interface SkillManifest {
  version: 1
  skills: ThirdPartySkillEntry[]
}

export function manifestPath(projectRoot: string): string {
  return join(projectRoot, '.owlcoda', 'skills.json')
}

export function readManifest(projectRoot: string): SkillManifest {
  const p = manifestPath(projectRoot)
  if (!existsSync(p)) return { version: 1, skills: [] }
  const raw = JSON.parse(readFileSync(p, 'utf8'))
  if (raw?.version !== 1 || !Array.isArray(raw.skills)) {
    throw new Error(`Invalid skills.json at ${p}: expected {version:1, skills:[]}`)
  }
  return raw as SkillManifest
}

export function writeManifest(projectRoot: string, m: SkillManifest): void {
  const p = manifestPath(projectRoot)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(m, null, 2) + '\n')
}

/** True if `relPath` is gitignored under projectRoot. False if not ignored or not a git repo. */
export function isPathGitignored(projectRoot: string, relPath: string): boolean {
  try {
    execFileSync('git', ['-C', projectRoot, 'check-ignore', '-q', relPath], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
