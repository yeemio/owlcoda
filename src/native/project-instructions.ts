import * as fs from 'node:fs'
import * as path from 'node:path'

export type ProjectInstructionKind =
  | 'AGENTS.md'
  | 'CLAUDE.md'
  | 'OWLCODA.md'
  | '.owlcoda/OWLCODA.md'
  | 'rule'

export interface ProjectInstructionSource {
  name: string
  path: string
  kind: ProjectInstructionKind
  depth: number
  bytesRead: number
  content: string
}

export interface LoadProjectInstructionsOptions {
  maxBytesPerFile?: number
  maxSearchDepth?: number
}

const DEFAULT_MAX_BYTES_PER_FILE = 16 * 1024
const DEFAULT_MAX_SEARCH_DEPTH = 6
const DEFAULT_MAX_RULE_FILES = 32
const DEFAULT_MAX_RULE_DEPTH = 8

const CANDIDATES: Array<{ kind: ProjectInstructionKind; relativePath: string }> = [
  { kind: 'AGENTS.md', relativePath: 'AGENTS.md' },
  { kind: 'CLAUDE.md', relativePath: 'CLAUDE.md' },
  { kind: 'OWLCODA.md', relativePath: 'OWLCODA.md' },
  { kind: '.owlcoda/OWLCODA.md', relativePath: path.join('.owlcoda', 'OWLCODA.md') },
]

export function loadProjectInstructions(
  cwd = process.cwd(),
  options: LoadProjectInstructionsOptions = {},
): ProjectInstructionSource[] {
  const maxBytesPerFile = options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE
  const maxSearchDepth = options.maxSearchDepth ?? DEFAULT_MAX_SEARCH_DEPTH
  const found: ProjectInstructionSource[] = []
  const seen = new Set<string>()
  const rootCwd = path.resolve(cwd)
  let dir = rootCwd

  for (let depth = 0; depth < maxSearchDepth; depth++) {
    for (const candidate of CANDIDATES) {
      const filePath = path.join(dir, candidate.relativePath)
      if (seen.has(filePath)) continue
      seen.add(filePath)

      const source = readInstructionSource({
        filePath,
        cwd: rootCwd,
        kind: candidate.kind,
        depth,
        maxBytesPerFile,
      })
      if (source) found.push(source)
    }

    for (const filePath of listMarkdownFiles(path.join(dir, '.claude', 'rules'), {
      maxDepth: DEFAULT_MAX_RULE_DEPTH,
      maxFiles: DEFAULT_MAX_RULE_FILES,
    })) {
      if (seen.has(filePath)) continue
      seen.add(filePath)

      const source = readInstructionSource({
        filePath,
        cwd: rootCwd,
        kind: 'rule',
        depth,
        maxBytesPerFile,
      })
      if (source) found.push(source)
    }

    if (fs.existsSync(path.join(dir, '.git'))) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return found
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

function readInstructionSource(input: {
  filePath: string
  cwd: string
  kind: ProjectInstructionKind
  depth: number
  maxBytesPerFile: number
}): ProjectInstructionSource | null {
  try {
    const stat = fs.statSync(input.filePath)
    if (!stat.isFile() || stat.size === 0) return null

    const buffer = fs.readFileSync(input.filePath)
    const sliced = buffer.subarray(0, Math.max(0, input.maxBytesPerFile))
    const content = sliced.toString('utf-8').trim()
    if (!content) return null
    const relativeName = path.relative(input.cwd, input.filePath)

    return {
      name: input.kind === 'rule' ? relativeName : input.depth === 0 ? input.kind : relativeName,
      path: input.filePath,
      kind: input.kind,
      depth: input.depth,
      bytesRead: sliced.length,
      content,
    }
  } catch {
    return null
  }
}

function listMarkdownFiles(
  root: string,
  options: { maxDepth: number; maxFiles: number },
): string[] {
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
