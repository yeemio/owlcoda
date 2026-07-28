import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export type ProjectFileInstructionKind =
  | 'AGENTS.override.md'
  | 'AGENTS.md'
  | 'CLAUDE.md'
  | 'OWLCODA.md'
  | '.owlcoda/OWLCODA.md'
  | 'rule'

export type ProjectInstructionKind =
  | ProjectFileInstructionKind
  | 'builtin'
  | 'user'

export type ProjectInstructionScope = 'builtin' | 'user' | 'project'

export interface ProjectInstructionSource {
  name: string
  path: string
  kind: ProjectInstructionKind
  scope: ProjectInstructionScope
  depth: number
  bytesRead: number
  content: string
}

export interface LoadProjectInstructionsOptions {
  maxBytesPerFile?: number
  maxSearchDepth?: number
  maxRuleFiles?: number
  skipped?: InstructionChainSkippedSource[]
}

export interface LoadGlobalInstructionsOptions {
  maxBytesPerFile?: number
  builtinPath?: string
  homeDir?: string
  skipped?: InstructionChainSkippedSource[]
}

export type InstructionSkippedReason =
  | 'empty'
  | 'not-file'
  | 'read-error'
  | 'path-scoped-rule'
  | 'shadowed-by-override'
  | 'fallback-not-used'

export interface InstructionChainInspection {
  schemaVersion: 1
  kind: 'owlcoda_instruction_chain'
  cwd: string
  count: number
  limits: InstructionChainInspectionLimits
  sources: InstructionChainInspectionSource[]
  skipped: InstructionChainSkippedSource[]
}

export interface InstructionChainInspectionLimits {
  maxBytesPerFile: number
  maxSearchDepth: number
  maxRuleFiles: number
}

export interface InstructionChainInspectionSource {
  name: string
  path: string
  kind: ProjectInstructionKind
  scope: ProjectInstructionScope
  depth: number
  bytesRead: number
  contentPreview: string
}

export interface InstructionChainSkippedSource {
  name: string
  path: string
  kind: ProjectInstructionKind
  scope: ProjectInstructionScope
  depth: number
  reason: InstructionSkippedReason
}

const DEFAULT_MAX_BYTES_PER_FILE = 16 * 1024
const DEFAULT_MAX_SEARCH_DEPTH = 6
const DEFAULT_MAX_RULE_FILES = 32
const DEFAULT_MAX_RULE_DEPTH = 8

const CANDIDATES: Array<{ kind: ProjectFileInstructionKind; relativePath: string }> = [
  { kind: 'AGENTS.override.md', relativePath: 'AGENTS.override.md' },
  { kind: 'AGENTS.md', relativePath: 'AGENTS.md' },
  { kind: 'CLAUDE.md', relativePath: 'CLAUDE.md' },
  { kind: 'OWLCODA.md', relativePath: 'OWLCODA.md' },
  { kind: '.owlcoda/OWLCODA.md', relativePath: path.join('.owlcoda', 'OWLCODA.md') },
]

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_BUILTIN_AGENTS_PATH = path.resolve(MODULE_DIR, '..', '..', 'AGENTS.md')

export function loadGlobalInstructions(
  options: LoadGlobalInstructionsOptions = {},
): ProjectInstructionSource[] {
  const maxBytesPerFile = options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE
  const found: ProjectInstructionSource[] = []
  const seen = new Set<string>()
  const builtinPath = options.builtinPath ?? DEFAULT_BUILTIN_AGENTS_PATH
  const skipped = options.skipped

  const builtinSource = readInstructionSource({
    filePath: builtinPath,
    cwd: path.dirname(builtinPath),
    kind: 'builtin',
    scope: 'builtin',
    name: 'builtin:AGENTS.md',
    depth: 0,
    maxBytesPerFile,
    skipped,
  })
  if (builtinSource) {
    found.push(builtinSource)
    seen.add(builtinSource.path)
  }

  const userCandidates = userInstructionCandidates(options.homeDir)
  for (let index = 0; index < userCandidates.length; index++) {
    const candidate = userCandidates[index]!
    if (seen.has(candidate.path)) continue
    const presence = instructionFilePresence(candidate.path)
    if (presence === 'missing') continue
    const source = readInstructionSource({
      filePath: candidate.path,
      cwd: path.dirname(candidate.path),
      kind: 'user',
      scope: 'user',
      name: candidate.name,
      depth: 0,
      maxBytesPerFile,
      skipped,
    })
    if (source) {
      found.push(source)
      seen.add(source.path)
    }
    recordExistingFallbackSkips(userCandidates.slice(index + 1), skipped)
    break
  }

  return found
}

export function loadProjectInstructions(
  cwd = process.cwd(),
  options: LoadProjectInstructionsOptions = {},
): Array<ProjectInstructionSource & { kind: ProjectFileInstructionKind; scope: 'project' }> {
  const maxBytesPerFile = options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE
  const maxSearchDepth = options.maxSearchDepth ?? DEFAULT_MAX_SEARCH_DEPTH
  const maxRuleFiles = options.maxRuleFiles ?? DEFAULT_MAX_RULE_FILES
  const found: Array<ProjectInstructionSource & { kind: ProjectFileInstructionKind; scope: 'project' }> = []
  const seen = new Set<string>()
  const rootCwd = path.resolve(cwd)
  if (traversesProjectControlledSymlink(rootCwd)) return []
  const dirs = collectInstructionDirs(rootCwd, maxSearchDepth)
  const skipped = options.skipped

  for (const entry of dirs) {
    let loadedAgentsOverride = false
    for (const candidate of CANDIDATES) {
      const filePath = path.join(entry.dir, candidate.relativePath)
      if (candidate.kind === 'AGENTS.md' && loadedAgentsOverride) {
        if (instructionFilePresence(filePath) === 'present') {
          recordSkipped(skipped, {
            name: entry.depth === 0 ? candidate.kind : path.relative(rootCwd, filePath),
            path: filePath,
            kind: candidate.kind,
            scope: 'project',
            depth: entry.depth,
            reason: 'shadowed-by-override',
          })
        }
        continue
      }
      if (seen.has(filePath)) continue
      seen.add(filePath)

      const source = readInstructionSource({
        filePath,
        cwd: rootCwd,
        kind: candidate.kind,
        scope: 'project',
        depth: entry.depth,
        maxBytesPerFile,
        projectBoundary: entry.dir,
        skipped,
      })
      if (source) {
        found.push(source)
        if (candidate.kind === 'AGENTS.override.md') loadedAgentsOverride = true
      }
    }

    for (const filePath of listMarkdownFiles(path.join(entry.dir, '.claude', 'rules'), {
      maxDepth: DEFAULT_MAX_RULE_DEPTH,
      maxFiles: maxRuleFiles,
    }, entry.dir)) {
      if (seen.has(filePath)) continue
      seen.add(filePath)

      const source = readInstructionSource({
        filePath,
        cwd: rootCwd,
        kind: 'rule',
        scope: 'project',
        depth: entry.depth,
        maxBytesPerFile,
        projectBoundary: entry.dir,
        skipped,
      })
      if (source) found.push(source)
    }
  }

  return found
}

export function loadEffectiveInstructionSources(
  cwd = process.cwd(),
  options: LoadProjectInstructionsOptions & LoadGlobalInstructionsOptions = {},
): ProjectInstructionSource[] {
  const seen = new Set<string>()
  const sources: ProjectInstructionSource[] = []

  for (const source of [...loadGlobalInstructions(options), ...loadProjectInstructions(cwd, options)]) {
    if (seen.has(source.path)) continue
    seen.add(source.path)
    sources.push(source)
  }

  return sources
}

export function renderProjectInstructions(
  cwd = process.cwd(),
  options: LoadProjectInstructionsOptions = {},
): string | null {
  const sources = loadProjectInstructions(cwd, options)
  if (sources.length === 0) return null

  return sources.map((source) =>
    `<project_instructions source="${source.name}">\n${source.content}\n</project_instructions>`,
  ).join('\n\n')
}

export function renderEffectiveInstructions(
  cwd = process.cwd(),
  options: LoadProjectInstructionsOptions & LoadGlobalInstructionsOptions = {},
): string | null {
  const sources = loadEffectiveInstructionSources(cwd, options)
  if (sources.length === 0) return null

  return sources.map((source) =>
    `<project_instructions source="${source.name}">\n${source.content}\n</project_instructions>`,
  ).join('\n\n')
}

export function inspectInstructionChain(
  cwd = process.cwd(),
  options: LoadProjectInstructionsOptions & LoadGlobalInstructionsOptions = {},
): InstructionChainInspection {
  const resolvedCwd = path.resolve(cwd)
  const skipped: InstructionChainSkippedSource[] = []
  const sources = loadEffectiveInstructionSources(resolvedCwd, { ...options, skipped })
  return {
    schemaVersion: 1,
    kind: 'owlcoda_instruction_chain',
    cwd: resolvedCwd,
    count: sources.length,
    limits: instructionInspectionLimits(options),
    sources: sources.map((source) => ({
      name: source.name,
      path: source.path,
      kind: source.kind,
      scope: source.scope,
      depth: source.depth,
      bytesRead: source.bytesRead,
      contentPreview: source.content.slice(0, 240),
    })),
    skipped: dedupeSkipped(skipped),
  }
}

function readInstructionSource<K extends ProjectInstructionKind, S extends ProjectInstructionScope>(input: {
  filePath: string
  cwd: string
  kind: K
  scope: S
  name?: string
  depth: number
  maxBytesPerFile: number
  projectBoundary?: string
  skipped?: InstructionChainSkippedSource[]
}): (ProjectInstructionSource & { kind: K; scope: S }) | null {
  let descriptor: number | undefined
  try {
    if (input.projectBoundary) {
      if (instructionFilePresence(input.filePath) === 'missing') return null
      if (!isSafeProjectInstructionPath(input.filePath, input.projectBoundary)) {
        recordReadSkip(input, 'not-file')
        return null
      }
    }

    const openFlags = input.projectBoundary
      ? fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
      : fs.constants.O_RDONLY
    descriptor = fs.openSync(input.filePath, openFlags)
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile()) {
      recordReadSkip(input, 'not-file')
      return null
    }
    if (
      input.projectBoundary
      && !isSafeOpenedProjectInstruction(input.filePath, input.projectBoundary, stat)
    ) {
      recordReadSkip(input, 'not-file')
      return null
    }
    if (stat.size === 0) {
      recordReadSkip(input, 'empty')
      return null
    }

    const maxBytes = Math.max(0, Math.trunc(input.maxBytesPerFile))
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes))
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0)
    const content = buffer.subarray(0, bytesRead).toString('utf-8').trim()
    if (!content) {
      recordReadSkip(input, 'empty')
      return null
    }
    if (input.kind === 'rule' && hasPathScopedFrontmatter(content)) {
      recordReadSkip(input, 'path-scoped-rule')
      return null
    }
    const relativeName = path.relative(input.cwd, input.filePath)

    return {
      name: input.name ?? (input.kind === 'rule' ? relativeName : input.depth === 0 ? input.kind : relativeName),
      path: input.filePath,
      kind: input.kind,
      scope: input.scope,
      depth: input.depth,
      bytesRead,
      content,
    }
  } catch {
    if (instructionFilePresence(input.filePath) === 'present') recordReadSkip(input, 'read-error')
    return null
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor)
      } catch {
        // The read result remains authoritative if closing an already-open descriptor fails.
      }
    }
  }
}

function isSafeProjectInstructionPath(filePath: string, projectBoundary: string): boolean {
  const boundary = path.resolve(projectBoundary)
  const target = path.resolve(filePath)
  const relative = path.relative(boundary, target)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false
  }

  try {
    let current = boundary
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment)
      if (fs.lstatSync(current).isSymbolicLink()) return false
    }

    const canonicalBoundary = fs.realpathSync(boundary)
    const canonicalTarget = fs.realpathSync(target)
    const canonicalRelative = path.relative(canonicalBoundary, canonicalTarget)
    return canonicalRelative !== ''
      && canonicalRelative !== '..'
      && !canonicalRelative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(canonicalRelative)
  } catch {
    return false
  }
}

function isSafeOpenedProjectInstruction(
  filePath: string,
  projectBoundary: string,
  openedStat: fs.Stats,
): boolean {
  if (!isSafeProjectInstructionPath(filePath, projectBoundary)) return false

  try {
    const currentStat = fs.statSync(filePath)
    return currentStat.isFile()
      && currentStat.dev === openedStat.dev
      && currentStat.ino === openedStat.ino
  } catch {
    return false
  }
}

function instructionInspectionLimits(
  options: LoadProjectInstructionsOptions & LoadGlobalInstructionsOptions,
): InstructionChainInspectionLimits {
  return {
    maxBytesPerFile: options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE,
    maxSearchDepth: options.maxSearchDepth ?? DEFAULT_MAX_SEARCH_DEPTH,
    maxRuleFiles: options.maxRuleFiles ?? DEFAULT_MAX_RULE_FILES,
  }
}

function recordReadSkip(input: {
  filePath: string
  cwd: string
  kind: ProjectInstructionKind
  scope: ProjectInstructionScope
  name?: string
  depth: number
  skipped?: InstructionChainSkippedSource[]
}, reason: InstructionSkippedReason): void {
  recordSkipped(input.skipped, {
    name: input.name ?? (input.kind === 'rule' ? path.relative(input.cwd, input.filePath) : input.depth === 0 ? input.kind : path.relative(input.cwd, input.filePath)),
    path: input.filePath,
    kind: input.kind,
    scope: input.scope,
    depth: input.depth,
    reason,
  })
}

function recordSkipped(
  skipped: InstructionChainSkippedSource[] | undefined,
  source: InstructionChainSkippedSource,
): void {
  skipped?.push(source)
}

function recordExistingFallbackSkips(
  candidates: Array<{ name: string; path: string }>,
  skipped: InstructionChainSkippedSource[] | undefined,
): void {
  for (const candidate of candidates) {
    if (instructionFilePresence(candidate.path) !== 'present') continue
    recordSkipped(skipped, {
      name: candidate.name,
      path: candidate.path,
      kind: 'user',
      scope: 'user',
      depth: 0,
      reason: 'fallback-not-used',
    })
  }
}

function instructionFilePresence(filePath: string): 'missing' | 'present' {
  try {
    fs.lstatSync(filePath)
    return 'present'
  } catch {
    return 'missing'
  }
}

function dedupeSkipped(skipped: InstructionChainSkippedSource[]): InstructionChainSkippedSource[] {
  const seen = new Set<string>()
  const deduped: InstructionChainSkippedSource[] = []
  for (const source of skipped) {
    const key = `${source.reason}\0${source.path}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(source)
  }
  return deduped
}

function hasPathScopedFrontmatter(content: string): boolean {
  if (!content.startsWith('---')) return false
  const match = /^---\s*\n([\s\S]*?)\n---(?:\n|$)/.exec(content)
  if (!match) return false
  return /^paths\s*:/m.test(match[1]!)
}

function userInstructionCandidates(homeDir?: string): Array<{ name: string; path: string }> {
  const home = homeDir ?? process.env.HOME
  if (!home) return []
  return [
    {
      name: 'user:~/.owlcoda/AGENTS.md',
      path: path.join(home, '.owlcoda', 'AGENTS.md'),
    },
    {
      name: 'user:~/.codex/AGENTS.md',
      path: path.join(home, '.codex', 'AGENTS.md'),
    },
  ]
}

function collectInstructionDirs(cwd: string, maxSearchDepth: number): Array<{ dir: string; depth: number }> {
  const dirs: Array<{ dir: string; depth: number }> = []
  let dir = cwd

  for (let depth = 0; depth < maxSearchDepth; depth++) {
    dirs.push({ dir, depth })
    if (fs.existsSync(path.join(dir, '.git'))) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return dirs.reverse()
}

function traversesProjectControlledSymlink(cwd: string): boolean {
  let boundary = cwd

  while (true) {
    if (
      instructionFilePresence(path.join(boundary, '.git')) === 'present'
      && hasSymlinkBelowBoundary(boundary, cwd)
    ) {
      return true
    }
    const parent = path.dirname(boundary)
    if (parent === boundary) return false
    boundary = parent
  }
}

function hasSymlinkBelowBoundary(boundary: string, target: string): boolean {
  const relative = path.relative(boundary, target)
  if (!relative) return false
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return true

  let current = boundary
  try {
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment)
      if (fs.lstatSync(current).isSymbolicLink()) return true
    }
    return false
  } catch {
    return true
  }
}

function listMarkdownFiles(
  root: string,
  options: { maxDepth: number; maxFiles: number },
  projectBoundary: string,
): string[] {
  if (!isSafeProjectInstructionPath(root, projectBoundary)) return []
  const files: string[] = []
  collectMarkdownFiles(root, 0, options, files)
  return files.sort()
}

function collectMarkdownFiles(
  dir: string,
  depth: number,
  options: { maxDepth: number; maxFiles: number },
  files: string[],
): void {
  if (files.length >= options.maxFiles || depth > options.maxDepth) return

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (files.length >= options.maxFiles) return
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectMarkdownFiles(entryPath, depth + 1, options, files)
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(entryPath)
    }
  }
}
