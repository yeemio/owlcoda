import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { loadProjectInstructions } from './project-instructions.js'
import { recordGateEvent } from './gate-telemetry.js'
import type {
  ProjectMapEntryPoint,
  ProjectMapEvidenceSeed,
  ProjectMapSnapshot,
  ProjectMapSourceFile,
  ProjectMapTruthSource,
  ProjectMapVerificationProfile,
  ProjectMapWriteBoundary,
} from './protocol/project-map-types.js'

export interface BuildProjectMapSnapshotOptions {
  createdAt?: string
  maxSearchDepth?: number
  maxSourceBytes?: number
}

export interface ProjectMapPromptSummaryOptions {
  maxEntries?: number
}

interface PackageInfo {
  name?: string
  version?: string
  scripts: Record<string, string>
  main?: string
  binPaths: Array<{ name: string; path: string }>
  files: string[]
  path?: string
}

interface ControlPlaneSourceFile {
  path: string
  kind: 'settings' | 'agent' | 'runtime'
}

const DEFAULT_MAX_SEARCH_DEPTH = 10
const DEFAULT_MAX_SOURCE_BYTES = 16 * 1024
const MAX_AGENT_DEFINITION_FILES = 32
const RUNTIME_CONTROL_PLANE_SOURCE_CANDIDATES = [
  path.join('src', 'native', 'project-map.ts'),
  path.join('src', 'native', 'project-instructions.ts'),
  path.join('src', 'native', 'protocol', 'project-map-types.ts'),
  path.join('src', 'native', 'tools', 'project-map.ts'),
  path.join('src', 'native', 'headless.ts'),
  path.join('src', 'native', 'conversation.ts'),
  path.join('src', 'native', 'run-workspace.ts'),
]

const ENTRY_DIR_CANDIDATES: Array<{ relativePath: string; kind: ProjectMapEntryPoint['kind']; reason: string }> = [
  { relativePath: 'src', kind: 'source_dir', reason: 'common source directory' },
  { relativePath: 'lib', kind: 'source_dir', reason: 'common library directory' },
  { relativePath: 'app', kind: 'source_dir', reason: 'common application directory' },
  { relativePath: 'packages', kind: 'source_dir', reason: 'common monorepo packages directory' },
  { relativePath: 'tests', kind: 'test_dir', reason: 'common test directory' },
  { relativePath: 'test', kind: 'test_dir', reason: 'common test directory' },
  { relativePath: '__tests__', kind: 'test_dir', reason: 'common test directory' },
  { relativePath: 'docs', kind: 'docs_dir', reason: 'common documentation directory' },
  { relativePath: 'scripts', kind: 'script', reason: 'common automation directory' },
  { relativePath: 'config', kind: 'config', reason: 'common configuration directory' },
]

const VERIFICATION_SCRIPT_IDS: Record<string, string> = {
  test: 'npm-test',
  typecheck: 'npm-typecheck',
  lint: 'npm-lint',
  build: 'npm-build',
  verify: 'npm-verify',
  smoke: 'npm-smoke',
}

const VERIFICATION_SCRIPT_ORDER = ['test', 'typecheck', 'lint', 'build', 'verify', 'smoke']

export function buildProjectMapSnapshot(
  cwd = process.cwd(),
  options: BuildProjectMapSnapshotOptions = {},
): ProjectMapSnapshot {
  const resolvedCwd = path.resolve(cwd)
  const createdAt = options.createdAt ?? new Date().toISOString()
  const maxSearchDepth = options.maxSearchDepth ?? DEFAULT_MAX_SEARCH_DEPTH
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES
  const gitRoot = findGitRoot(resolvedCwd, maxSearchDepth)
  const git = gitRoot ? readGitState(gitRoot) : null
  const packageInfo = readNearestPackageInfo(resolvedCwd, gitRoot, maxSearchDepth)
  const projectRoot = packageInfo.path ? path.dirname(packageInfo.path) : gitRoot ?? resolvedCwd
  const instructionSources = loadProjectInstructions(resolvedCwd, {
    maxBytesPerFile: maxSourceBytes,
    maxSearchDepth,
  })
  const controlPlaneSources = discoverControlPlaneSources(projectRoot)

  const sourceFiles: ProjectMapSourceFile[] = [
    ...instructionSources.map((source) => {
      const fingerprint = fingerprintFile(source.path, maxSourceBytes)
      return {
        path: source.path,
        kind: source.kind,
        scope: source.depth === 0 ? 'directory' : 'repo',
        bytesRead: fingerprint.bytesRead,
        sha256: fingerprint.sha256,
      } satisfies ProjectMapSourceFile
    }),
    ...controlPlaneSources.map((source) => {
      const fingerprint = fingerprintFile(source.path, maxSourceBytes)
      return {
        path: source.path,
        kind: source.kind,
        scope: 'repo',
        bytesRead: fingerprint.bytesRead,
        sha256: fingerprint.sha256,
      } satisfies ProjectMapSourceFile
    }),
  ]

  if (packageInfo.path) {
    const fingerprint = fingerprintFile(packageInfo.path, maxSourceBytes)
    sourceFiles.push({
      path: packageInfo.path,
      kind: 'package',
      scope: packageInfo.path.startsWith(`${projectRoot}${path.sep}`) ? 'repo' : 'directory',
      bytesRead: fingerprint.bytesRead,
      sha256: fingerprint.sha256,
    })
  }

  const entrypoints = buildEntryPoints(projectRoot, packageInfo)
  const truthSources = buildTruthSources({
    gitHeadPath: git?.headPath,
    packagePath: packageInfo.path,
    sourceFiles,
  })
  const evidenceSeeds = buildEvidenceSeeds({
    sourceFiles,
    entrypoints,
    packageInfo,
    gitHeadPath: git?.headPath,
  })
  const writeBoundaries = buildWriteBoundaries(gitRoot ?? projectRoot)
  const verificationProfiles = buildVerificationProfiles(packageInfo)

  return {
    version: 1,
    createdAt,
    cwd: resolvedCwd,
    ...(gitRoot ? { gitRoot } : {}),
    ...(git?.head ? { gitHead: git.head } : {}),
    ...(packageInfo.name ? { packageName: packageInfo.name } : {}),
    ...(packageInfo.version ? { packageVersion: packageInfo.version } : {}),
    sourceFiles,
    entrypoints,
    truthSources,
    evidenceSeeds,
    writeBoundaries,
    verificationProfiles,
    freshness: {
      status: 'fresh',
      checkedAt: createdAt,
      ...(git?.head ? { gitHead: git.head } : {}),
      sourceHashes: Object.fromEntries(sourceFiles.map((source) => [source.path, source.sha256])),
    },
  }
}

export function isProjectMapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['OWLCODA_PROJECT_MAP']
  if (raw === undefined) return true
  const value = raw.trim().toLowerCase()
  return !new Set(['', '0', 'false', 'no', 'off', 'disable', 'disabled']).has(value)
}

/**
 * Day-0 shadow-sampling opt-out. Defaults ON whenever Project Map itself is on
 * (the sampler only runs inside an enabled Project Map path anyway); set
 * OWLCODA_PROJECT_MAP_SHADOW=0 to silence the ledger writes without disabling
 * Project Map. Mirrors isProjectMapEnabled's FALSY handling.
 */
export function isProjectMapShadowSamplingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['OWLCODA_PROJECT_MAP_SHADOW']
  if (raw === undefined) return true
  const value = raw.trim().toLowerCase()
  return !new Set(['', '0', 'false', 'no', 'off', 'disable', 'disabled']).has(value)
}

/**
 * Append one behavior-neutral shadow sample of a Project Map snapshot decision
 * to the gate-telemetry ledger. Records whether the snapshot was rebuilt
 * (stale) or reused (fresh) plus the resulting map shape, so default-on
 * readiness can be judged from accumulated fresh/stale samples instead of a
 * model self-report. Fire-and-forget: recordGateEvent swallows all I/O errors.
 */
export function recordProjectMapSnapshotSample(
  snapshot: ProjectMapSnapshot,
  wasStale: boolean,
  conversationId: string,
  iteration: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isProjectMapShadowSamplingEnabled(env)) return
  recordGateEvent({
    ts: Date.now(),
    kind: 'project_map_snapshot_sampled',
    conversationId,
    iteration,
    lastToolSignatures: [],
    reason: wasStale ? 'snapshot_rebuilt' : 'snapshot_reused',
    projectMapWasStale: wasStale,
    projectMapFreshnessStatus: snapshot.freshness.status,
    projectMapSourceFileCount: snapshot.sourceFiles.length,
    projectMapWriteBoundaryCount: snapshot.writeBoundaries.length,
    projectMapVerificationProfileCount: snapshot.verificationProfiles.length,
    ...(snapshot.gitHead ? { projectMapGitHead: snapshot.gitHead } : {}),
    ...(snapshot.packageName ? { projectMapPackageName: snapshot.packageName } : {}),
  })
}

export function isProjectMapSnapshotStale(
  snapshot: ProjectMapSnapshot | undefined,
  cwd = process.cwd(),
  options: Pick<BuildProjectMapSnapshotOptions, 'maxSearchDepth' | 'maxSourceBytes'> = {},
): boolean {
  if (!snapshot) return true
  const resolvedCwd = path.resolve(cwd)
  if (snapshot.cwd !== resolvedCwd) return true
  if (snapshot.freshness.status !== 'fresh') return true

  const maxSearchDepth = options.maxSearchDepth ?? DEFAULT_MAX_SEARCH_DEPTH
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES
  const gitRoot = findGitRoot(resolvedCwd, maxSearchDepth)
  if ((gitRoot ?? undefined) !== snapshot.gitRoot) return true
  const git = gitRoot ? readGitState(gitRoot) : null
  if ((git?.head ?? undefined) !== snapshot.gitHead) return true

  const currentSourceHashes = currentProjectMapSourceHashes(resolvedCwd, gitRoot, maxSearchDepth, maxSourceBytes)
  const previousSourceHashes = snapshot.freshness.sourceHashes
  const currentPaths = Object.keys(currentSourceHashes).sort()
  const previousPaths = Object.keys(previousSourceHashes).sort()
  if (currentPaths.length !== previousPaths.length) return true
  for (let i = 0; i < currentPaths.length; i++) {
    if (currentPaths[i] !== previousPaths[i]) return true
    const currentPath = currentPaths[i]!
    if (currentSourceHashes[currentPath] !== previousSourceHashes[currentPath]) return true
  }
  return false
}

export function buildProjectMapPromptSummary(
  snapshot: ProjectMapSnapshot,
  options: ProjectMapPromptSummaryOptions = {},
): string {
  const maxEntries = options.maxEntries ?? 6
  const root = snapshot.gitRoot ?? snapshot.cwd
  const packageLabel = snapshot.packageName
    ? `${snapshot.packageName}${snapshot.packageVersion ? `@${snapshot.packageVersion}` : ''}`
    : '(none)'
  const instructionLabels = snapshot.sourceFiles
    .filter((source) => isInstructionSourceKind(source.kind))
    .map((source) => displayPath(source.path, root))
  const controlPlaneLabels = snapshot.sourceFiles
    .filter((source) => source.kind === 'settings' || source.kind === 'agent')
    .slice(0, maxEntries)
    .map((source) => `${displayPath(source.path, root)} (${source.kind})`)
  const entrypointLabels = snapshot.entrypoints
    .slice(0, maxEntries)
    .map((entry) => `${displayPath(entry.path, root)} (${entry.kind})`)
  const boundaryLabels = snapshot.writeBoundaries
    .slice(0, maxEntries)
    .map((boundary) => `${boundary.kind} ${displayPath(boundary.path, root)} (${boundary.origin})`)
  const verificationLabels = snapshot.verificationProfiles
    .flatMap((profile) => profile.commands)
    .slice(0, maxEntries)

  return [
    '<project_map>',
    `Root: ${root}`,
    `Git HEAD: ${snapshot.gitHead ?? '(none)'}`,
    `Package: ${packageLabel}`,
    `Instructions: ${formatList(instructionLabels)}`,
    `Control plane sources: ${formatList(controlPlaneLabels)}`,
    `Entry points: ${formatList(entrypointLabels)}`,
    `Write boundary: ${formatList(boundaryLabels)}`,
    `Verification: ${formatList(verificationLabels, '; ')}`,
    '</project_map>',
  ].join('\n')
}

function findGitRoot(startDir: string, maxSearchDepth: number): string | undefined {
  let dir = startDir
  for (let depth = 0; depth <= maxSearchDepth; depth++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir

    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

function readGitState(gitRoot: string): { head?: string; headPath: string } | null {
  const gitDir = resolveGitDir(gitRoot)
  if (!gitDir) return null

  const headPath = path.join(gitDir, 'HEAD')
  const headContent = readText(headPath)?.trim()
  if (!headContent) return { headPath }

  if (!headContent.startsWith('ref: ')) {
    return { head: headContent, headPath }
  }

  const refName = headContent.slice('ref: '.length).trim()
  const refPath = path.join(gitDir, refName)
  const refHead = readText(refPath)?.trim()
  if (refHead) return { head: refHead, headPath }

  const packedHead = readPackedRef(gitDir, refName)
  return packedHead ? { head: packedHead, headPath } : { headPath }
}

function resolveGitDir(gitRoot: string): string | null {
  const dotGitPath = path.join(gitRoot, '.git')
  try {
    const stat = fs.statSync(dotGitPath)
    if (stat.isDirectory()) return dotGitPath
    if (!stat.isFile()) return null

    const content = fs.readFileSync(dotGitPath, 'utf8').trim()
    const match = /^gitdir:\s*(.+)$/i.exec(content)
    if (!match) return null
    return path.resolve(gitRoot, match[1]!)
  } catch {
    return null
  }
}

function readPackedRef(gitDir: string, refName: string): string | undefined {
  const packedRefs = readText(path.join(gitDir, 'packed-refs'))
  if (!packedRefs) return undefined

  for (const line of packedRefs.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('^')) continue
    const [sha, ref] = line.trim().split(/\s+/, 2)
    if (ref === refName && sha) return sha
  }
  return undefined
}

function readNearestPackageInfo(startDir: string, stopDir: string | undefined, maxSearchDepth: number): PackageInfo {
  let dir = startDir
  for (let depth = 0; depth <= maxSearchDepth; depth++) {
    const packagePath = path.join(dir, 'package.json')
    if (isFile(packagePath)) {
      const parsed = parsePackageJson(packagePath)
      return { ...parsed, path: packagePath }
    }

    if (stopDir && dir === stopDir) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { scripts: {}, binPaths: [], files: [] }
}

function currentProjectMapSourceHashes(
  cwd: string,
  gitRoot: string | undefined,
  maxSearchDepth: number,
  maxSourceBytes: number,
): Record<string, string> {
  const packageInfo = readNearestPackageInfo(cwd, gitRoot, maxSearchDepth)
  const instructionSources = loadProjectInstructions(cwd, {
    maxBytesPerFile: maxSourceBytes,
    maxSearchDepth,
  })
  const projectRoot = packageInfo.path ? path.dirname(packageInfo.path) : gitRoot ?? cwd
  const controlPlaneSources = discoverControlPlaneSources(projectRoot)
  const paths = [
    ...instructionSources.map((source) => source.path),
    ...controlPlaneSources.map((source) => source.path),
    ...(packageInfo.path ? [packageInfo.path] : []),
  ]
  return Object.fromEntries(paths.map((sourcePath) => [
    sourcePath,
    fingerprintFile(sourcePath, maxSourceBytes).sha256,
  ]))
}

function parsePackageJson(packagePath: string): Omit<PackageInfo, 'path'> {
  try {
    const raw = fs.readFileSync(packagePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) return { scripts: {}, binPaths: [], files: [] }

    const scripts = isRecord(parsed['scripts'])
      ? Object.fromEntries(
        Object.entries(parsed['scripts'])
          .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string'),
      )
      : {}

    return {
      ...(typeof parsed['name'] === 'string' ? { name: parsed['name'] } : {}),
      ...(typeof parsed['version'] === 'string' ? { version: parsed['version'] } : {}),
      ...(typeof parsed['main'] === 'string' ? { main: parsed['main'] } : {}),
      binPaths: parsePackageBinPaths(parsed['bin']),
      files: Array.isArray(parsed['files'])
        ? parsed['files'].filter((value): value is string => typeof value === 'string')
        : [],
      scripts,
    }
  } catch {
    return { scripts: {}, binPaths: [], files: [] }
  }
}

function parsePackageBinPaths(value: unknown): Array<{ name: string; path: string }> {
  if (typeof value === 'string') return [{ name: 'default', path: value }]
  if (!isRecord(value)) return []
  return Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')
    .map(([name, binPath]) => ({ name, path: binPath }))
}

function buildEntryPoints(projectRoot: string, packageInfo: PackageInfo): ProjectMapEntryPoint[] {
  const entries: ProjectMapEntryPoint[] = []

  for (const candidate of ENTRY_DIR_CANDIDATES) {
    const candidatePath = path.join(projectRoot, candidate.relativePath)
    if (!isDirectory(candidatePath)) continue
    entries.push({
      path: candidatePath,
      kind: candidate.kind,
      reason: candidate.reason,
    })
  }

  for (const scriptName of Object.keys(packageInfo.scripts)) {
    entries.push({
      path: `package.json#scripts.${scriptName}`,
      kind: 'package_script',
      reason: `npm script "${scriptName}" declared in package.json`,
    })
  }

  return entries
}

function buildTruthSources(input: {
  gitHeadPath?: string
  packagePath?: string
  sourceFiles: ProjectMapSourceFile[]
}): ProjectMapTruthSource[] {
  const sources: ProjectMapTruthSource[] = []

  if (input.gitHeadPath) {
    sources.push({
      path: input.gitHeadPath,
      kind: 'git',
      reason: 'git HEAD identifies the repository revision for this snapshot',
      safeReadonly: true,
    })
  }

  for (const sourceFile of input.sourceFiles) {
    sources.push({
      path: sourceFile.path,
      kind: sourceFile.kind === 'package' ? 'package' : 'file',
      reason: truthSourceReason(sourceFile.kind),
      safeReadonly: true,
    })
  }

  return dedupeByPathAndKind(sources)
}

function buildEvidenceSeeds(input: {
  sourceFiles: ProjectMapSourceFile[]
  entrypoints: ProjectMapEntryPoint[]
  packageInfo: PackageInfo
  gitHeadPath?: string
}): ProjectMapEvidenceSeed[] {
  const seeds: ProjectMapEvidenceSeed[] = []

  if (input.gitHeadPath) {
    seeds.push({
      path: input.gitHeadPath,
      kind: 'git',
      reason: 'use git HEAD to detect snapshot drift',
    })
  }

  for (const sourceFile of input.sourceFiles) {
    seeds.push({
      path: sourceFile.path,
      kind: evidenceSeedKind(sourceFile.kind),
      reason: evidenceSeedReason(sourceFile.kind),
    })
  }

  for (const entrypoint of input.entrypoints.filter((entry) => entry.kind !== 'package_script')) {
    seeds.push({
      path: entrypoint.path,
      kind: 'entrypoint',
      reason: entrypoint.reason,
    })
  }

  for (const scriptName of Object.keys(input.packageInfo.scripts)) {
    seeds.push({
      command: npmCommandForScript(scriptName),
      kind: 'package_script',
      reason: `npm script "${scriptName}" can guide verification planning; it is not auto-run`,
    })
  }

  return seeds
}

function buildWriteBoundaries(root: string): ProjectMapWriteBoundary[] {
  return [{
    path: root,
    kind: 'ask',
    scope: 'directory',
    origin: 'detected',
    reason: 'detected project boundary; later gates must still require explicit write provenance',
  }]
}

function buildVerificationProfiles(packageInfo: PackageInfo): ProjectMapVerificationProfile[] {
  const profiles: ProjectMapVerificationProfile[] = []
  const { scripts } = packageInfo
  const orderedScripts = [
    ...VERIFICATION_SCRIPT_ORDER.filter((scriptName) => Object.hasOwn(scripts, scriptName)),
    ...Object.keys(scripts)
      .filter((scriptName) => /^test:|^verify:|^smoke:/.test(scriptName))
      .filter((scriptName) => !VERIFICATION_SCRIPT_ORDER.includes(scriptName))
      .sort(),
  ]

  for (const scriptName of orderedScripts) {
    const taskVerifyChecks = buildPackageScriptTaskVerifyChecks(scriptName, packageInfo)
    profiles.push({
      id: VERIFICATION_SCRIPT_IDS[scriptName] ?? `npm-${scriptName.replace(/[^a-zA-Z0-9_-]+/g, '-')}`,
      appliesTo: scriptName === 'smoke' || scriptName.startsWith('smoke:') ? 'release' : 'code_change',
      commands: [npmCommandForScript(scriptName)],
      taskVerifyChecks,
      artifactPacks: taskVerifyChecks.length > 0 ? ['package-build-artifacts'] : [],
      requiredBeforeDone: true,
    })
  }

  return profiles
}

function npmCommandForScript(scriptName: string): string {
  return scriptName === 'test' ? 'npm test' : `npm run ${scriptName}`
}

function buildPackageScriptTaskVerifyChecks(
  scriptName: string,
  packageInfo: PackageInfo,
): Array<Record<string, unknown>> {
  if (scriptName !== 'build') return []

  const checks: Array<Record<string, unknown>> = []
  const seen = new Set<string>()

  if (packageInfo.main && isSafePackageArtifactPath(packageInfo.main)) {
    addCheck(checks, seen, {
      id: 'project-map-package-main',
      kind: 'file_exists',
      path: normalizePackageArtifactPath(packageInfo.main),
      reason: 'package.json main artifact should exist after build',
    })
  }

  for (const bin of packageInfo.binPaths) {
    if (!isSafePackageArtifactPath(bin.path)) continue
    addCheck(checks, seen, {
      id: `project-map-package-bin-${slugifyProjectMapId(bin.name)}`,
      kind: 'file_exists',
      path: normalizePackageArtifactPath(bin.path),
      reason: `package.json bin artifact "${bin.name}" should exist after build`,
    })
  }

  for (const filesEntry of packageInfo.files) {
    const directory = packageFilesDirectory(filesEntry)
    if (!directory) continue
    addCheck(checks, seen, {
      id: `project-map-package-files-${slugifyProjectMapId(directory)}`,
      kind: 'artifact_count',
      root: directory,
      glob: '**/*',
      min: 1,
      reason: `package.json files directory "${directory}" should contain build artifacts`,
    })
  }

  return checks
}

function addCheck(checks: Array<Record<string, unknown>>, seen: Set<string>, check: Record<string, unknown>): void {
  const key = `${check['kind']}:${check['path'] ?? check['root']}:${check['glob'] ?? ''}`
  if (seen.has(key)) return
  seen.add(key)
  checks.push(check)
}

function packageFilesDirectory(filesEntry: string): string | null {
  const normalized = normalizePackageArtifactPath(filesEntry)
  if (!isSafePackageArtifactPath(normalized)) return null
  if (normalized.includes('*')) return null
  if (path.extname(normalized)) return null
  return normalized
}

function normalizePackageArtifactPath(value: string): string {
  return value.trim().replace(/^\.\/+/, '').replace(/\/+$/, '')
}

function isSafePackageArtifactPath(value: string): boolean {
  const normalized = normalizePackageArtifactPath(value)
  if (!normalized) return false
  if (path.isAbsolute(normalized)) return false
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return false
  return true
}

function slugifyProjectMapId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'artifact'
}

function discoverControlPlaneSources(projectRoot: string): ControlPlaneSourceFile[] {
  const sources: ControlPlaneSourceFile[] = []

  for (const relativePath of [
    path.join('.owlcoda', 'settings.json'),
    path.join('.owlcoda', 'settings.local.json'),
  ]) {
    const sourcePath = path.join(projectRoot, relativePath)
    if (isFile(sourcePath)) sources.push({ path: sourcePath, kind: 'settings' })
  }

  for (const relativeDir of [
    path.join('.claude', 'agents'),
    path.join('.owlcoda', 'agents'),
  ]) {
    for (const sourcePath of listShallowMarkdownFiles(path.join(projectRoot, relativeDir), MAX_AGENT_DEFINITION_FILES)) {
      sources.push({ path: sourcePath, kind: 'agent' })
    }
  }

  for (const relativePath of RUNTIME_CONTROL_PLANE_SOURCE_CANDIDATES) {
    const sourcePath = path.join(projectRoot, relativePath)
    if (isFile(sourcePath)) sources.push({ path: sourcePath, kind: 'runtime' })
  }

  return sources
}

function listShallowMarkdownFiles(dir: string, maxFiles: number): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.join(dir, entry.name))
    .sort()
    .slice(0, maxFiles)
}

function isInstructionSourceKind(kind: ProjectMapSourceFile['kind']): boolean {
  return kind === 'AGENTS.override.md'
    || kind === 'AGENTS.md'
    || kind === 'CLAUDE.md'
    || kind === 'OWLCODA.md'
    || kind === '.owlcoda/OWLCODA.md'
    || kind === 'rule'
}

function truthSourceReason(kind: ProjectMapSourceFile['kind']): string {
  if (kind === 'package') return 'package.json declares project metadata and npm scripts'
  if (kind === 'settings') return 'project settings contribute runtime control-plane configuration evidence'
  if (kind === 'agent') return 'project agent definition is bounded control-plane evidence'
  if (kind === 'runtime') return 'Project Map runtime implementation file is bounded control-plane freshness evidence'
  return 'project instruction file contributes runtime guidance'
}

function evidenceSeedKind(kind: ProjectMapSourceFile['kind']): ProjectMapEvidenceSeed['kind'] {
  if (kind === 'package') return 'package'
  if (kind === 'settings') return 'settings'
  if (kind === 'agent') return 'agent'
  if (kind === 'runtime') return 'runtime'
  return 'instruction'
}

function evidenceSeedReason(kind: ProjectMapSourceFile['kind']): string {
  if (kind === 'package') return 'package metadata and scripts are bounded project evidence'
  if (kind === 'settings') return 'settings files are bounded runtime control-plane evidence'
  if (kind === 'agent') return 'agent definitions are discoverable evidence, not auto-loaded subagents'
  if (kind === 'runtime') return 'runtime implementation file participates in bounded Project Map freshness'
  return 'instruction files are explicit project guidance'
}

function displayPath(filePath: string, root: string): string {
  if (filePath.startsWith('package.json#')) return filePath
  if (path.isAbsolute(filePath)) {
    const relative = path.relative(root, filePath)
    return relative && !relative.startsWith('..') ? relative : filePath
  }
  return filePath
}

function formatList(values: string[], separator = ', '): string {
  return values.length > 0 ? values.join(separator) : '(none)'
}

function fingerprintFile(filePath: string, maxBytes: number): { bytesRead: number; sha256: string } {
  try {
    const buffer = fs.readFileSync(filePath)
    const sliced = buffer.subarray(0, Math.max(0, maxBytes))
    return {
      // `bytesRead` stays bounded by maxBytes (it is the evidence-sample size
      // reported in the snapshot). The freshness `sha256`, however, hashes the
      // FULL file: the file is already fully read above, and a bounded-slice
      // hash silently misses any edit beyond the first maxBytes — so a large
      // instruction file changed past the window would never be marked stale.
      // Hashing the whole buffer costs no extra I/O and makes staleness exact.
      bytesRead: sliced.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    }
  } catch {
    return {
      bytesRead: 0,
      sha256: crypto.createHash('sha256').update('').digest('hex'),
    }
  }
}

function dedupeByPathAndKind(sources: ProjectMapTruthSource[]): ProjectMapTruthSource[] {
  const seen = new Set<string>()
  const deduped: ProjectMapTruthSource[] = []

  for (const source of sources) {
    const key = `${source.kind}:${source.path ?? source.command ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(source)
  }

  return deduped
}

function readText(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory()
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
