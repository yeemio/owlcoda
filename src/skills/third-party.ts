import { join, basename, relative, resolve, sep } from 'node:path'
import { existsSync, readFileSync, mkdtempSync, rmSync, readdirSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { SkillDocument } from './schema.js'
import { isValidSkillId } from './schema.js'
import { readManifest, writeManifest, isPathGitignored } from './manifest.js'
import { verifyTreeIntegrity, vendorSkillDir, computeTreeIntegrity } from './vendor.js'
import { logWarn } from '../logger.js'
import { curatedToDocument, loadCuratedSkills } from './curated.js'
import { resolveAndFetch, defaultGitRunner, type GitRunner } from './git-source.js'
import { scanForConflicts, hasRejectableConflict } from './conflict-scan.js'
import { loadLearnedSkills } from './store.js'
import { recordSkillGrant } from './grant-telemetry.js'

function listMarkdownFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === '.git' || entry === 'node_modules') continue
      const full = join(dir, entry)
      // lstatSync (not statSync): never recurse into / hash a symlink (cycle/escape DoS).
      const s = lstatSync(full)
      if (s.isDirectory()) walk(full)
      else if (s.isFile() && entry.toLowerCase().endsWith('.md')) out.push(full)
    }
  }
  walk(root)
  return out
}

function resolveManagedSkillDir(projectRoot: string, vendoredPath: string): string | null {
  const skillsRoot = resolve(projectRoot, '.owlcoda', 'skills')
  const target = resolve(projectRoot, vendoredPath)
  // A managed skill must live in a per-skill SUBDIR. Reject the managed root
  // itself (== skillsRoot) — otherwise remove would rmSync the whole tree and
  // wipe every sibling skill — as well as anything outside it (traversal).
  if (target === skillsRoot || !target.startsWith(skillsRoot + sep)) return null
  return target
}

/** Load third-party skills listed in `.owlcoda/skills.json`, verifying integrity. */
export async function loadVendoredThirdPartySkills(projectRoot: string): Promise<SkillDocument[]> {
  let manifest
  try { manifest = readManifest(projectRoot) } catch (e) {
    logWarn('skills', `Bad third-party manifest, skipping: ${e instanceof Error ? e.message : e}`)
    return []
  }
  const out: SkillDocument[] = []
  for (const entry of manifest.skills) {
    const dir = resolveManagedSkillDir(projectRoot, entry.vendoredPath)
    if (!dir) {
      logWarn('skills', `Third-party skill vendoredPath escapes managed dir, refusing to load: ${entry.id}`)
      continue
    }
    const skillMd = join(dir, 'SKILL.md')
    if (!existsSync(skillMd)) {
      logWarn('skills', `Third-party skill missing vendored copy: ${entry.id}`); continue
    }
    if (!verifyTreeIntegrity(dir, entry.integrity)) {
      logWarn('skills', `Third-party skill integrity mismatch, refusing to load: ${entry.id}`); continue
    }
    const doc = curatedToDocument(entry.id, entry.id, readFileSync(skillMd, 'utf8'))
    doc.origin = 'third-party'
    doc.provenance = { source: entry.source, pinnedRef: entry.pinnedRef, integrity: entry.integrity }
    out.push(doc)
  }
  return out
}

export interface AddOptions {
  projectRoot: string
  url: string
  ref: string
  skill?: string
  id?: string
  force?: boolean
}
export interface AddResult { ok: boolean; id?: string; reason?: string; warnings: string[] }

export async function addThirdPartySkill(
  opts: AddOptions,
  deps: { gitRunner?: GitRunner } = {},
): Promise<AddResult> {
  const warnings: string[] = []
  const tmp = mkdtempSync(join(tmpdir(), 'owlcoda-skill-add-'))
  try {
    const { pinnedRef } = await resolveAndFetch(
      { url: opts.url, ref: opts.ref, dest: tmp },
      deps.gitRunner ?? defaultGitRunner,
    )
    // Fix 2: reject traversal --skill subpath before resolving paths
    if (opts.skill && (opts.skill.split(/[\\/]/).includes('..') || opts.skill.startsWith('/'))) {
      return { ok: false, reason: `Invalid --skill subpath "${opts.skill}" (no .. or absolute)`, warnings }
    }

    const skillDir = opts.skill ? join(tmp, opts.skill) : tmp
    const skillMd = join(skillDir, 'SKILL.md')
    if (!existsSync(skillMd)) return { ok: false, reason: `No SKILL.md at ${opts.skill ?? '<repo root>'}`, warnings }

    const id = opts.id ?? basename(opts.skill ?? opts.url.replace(/\.git$/, ''))
    if (!isValidSkillId(id)) return { ok: false, reason: `Invalid skill id "${id}" (kebab-case, no dots)`, warnings }

    // Fix 1: tree-wide conflict scan — class-5 bypass in any *.md is a hard reject (BEFORE vendoring).
    const conflictFiles: string[] = []
    for (const md of listMarkdownFiles(skillDir)) {
      if (hasRejectableConflict(scanForConflicts(readFileSync(md, 'utf8')))) {
        conflictFiles.push(relative(skillDir, md))
      }
    }
    if (conflictFiles.length) {
      return { ok: false, reason: `bypass-instruction conflict in: ${conflictFiles.join(', ')}`, warnings }
    }

    // Id-collision checks. NOTE: loadCuratedSkills() with NO arg = package-bundled first-party.
    const [curated, learned] = await Promise.all([loadCuratedSkills(), loadLearnedSkills()])
    if (curated.some(s => s.id === id)) return { ok: false, reason: `id "${id}" collides with a first-party skill`, warnings }
    if (learned.some(s => s.id === id)) return { ok: false, reason: `id "${id}" collides with a learned skill`, warnings }
    const manifest = readManifest(opts.projectRoot)
    if (manifest.skills.some(s => s.id === id) && !opts.force) {
      return { ok: false, reason: `id "${id}" already in manifest (use --force to re-pin)`, warnings }
    }

    // Vendor + integrity.
    const vendoredRel = join('.owlcoda', 'skills', id)
    const vendoredAbs = join(opts.projectRoot, vendoredRel)
    vendorSkillDir(skillDir, vendoredAbs)

    // Fix 3: clean up vendored dir if manifest write fails (avoid orphan).
    try {
      const integrity = computeTreeIntegrity(vendoredAbs)

      if (isPathGitignored(opts.projectRoot, vendoredRel)) {
        warnings.push(`.owlcoda is gitignored — this install is local-only and will not appear in a reviewable diff.`)
      }

      const entry = {
        id, source: opts.url, requestedRef: opts.ref, pinnedRef,
        skillPath: opts.skill, integrity, vendoredPath: vendoredRel,
        origin: 'third-party' as const, addedAt: new Date().toISOString(),
      }
      const next = { version: 1 as const, skills: [...manifest.skills.filter(s => s.id !== id), entry] }
      writeManifest(opts.projectRoot, next)
      recordSkillGrant(entry)
      return { ok: true, id, warnings }
    } catch (e) {
      rmSync(vendoredAbs, { recursive: true, force: true })
      throw e
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

export function listThirdPartySkills(projectRoot: string) {
  return readManifest(projectRoot).skills
}

export async function removeThirdPartySkill(projectRoot: string, id: string): Promise<boolean> {
  const m = readManifest(projectRoot)
  const entry = m.skills.find(s => s.id === id)
  if (!entry) return false

  // Fix 4: guard against out-of-tree vendoredPath (traversal attack).
  const target = resolveManagedSkillDir(projectRoot, entry.vendoredPath)
  if (!target) {
    // Refuse to delete outside the managed dir; still drop the manifest entry.
    writeManifest(projectRoot, { version: 1, skills: m.skills.filter(s => s.id !== id) })
    return true
  }

  rmSync(target, { recursive: true, force: true })
  writeManifest(projectRoot, { version: 1, skills: m.skills.filter(s => s.id !== id) })
  return true
}
