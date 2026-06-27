import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import type { DeliverableMode } from './deliverable-contract.js'
import type { ProjectMapSnapshot } from './protocol/project-map-types.js'
import type { RuntimeFactRefs } from './protocol/types.js'
import { mergeRuntimeFactRefs } from './runtime-facts.js'

export const RUN_WORKSPACE_DIR = '.owlcoda-run'
export const RUN_WORKSPACE_STRUCTURE_VERSION = 2
export const RUN_WORKSPACE_DIRECTORIES = ['stage', 'final', 'assets', 'scripts', 'evidence', 'notes'] as const

export type RunWorkspaceDirectory = typeof RUN_WORKSPACE_DIRECTORIES[number]

export type TaskFamily =
  | 'deck'
  | 'code'
  | 'image_asset'
  | 'research'
  | 'data_report'
  | 'release'
  | 'general'

export type RunArtifactOrigin =
  | 'write'
  | 'edit'
  | 'bash_detected'
  | 'skill_asset_copy'
  | 'manual'
  | (string & {})

export type RunArtifactStatus = 'present' | 'missing'

export interface RunWorkspacePaths {
  outputRoot: string
  runDir: string
  manifestPath: string
  checkpointPath: string
  skillRoutePath: string
  planPath: string
  artifactsPath: string
  verificationPath: string
  projectMapPath: string
  eventsPath: string
  stageDir: string
  finalDir: string
  assetsDir: string
  scriptsDir: string
  evidenceDir: string
  notesDir: string
}

export interface RunManifest {
  version: 1
  structureVersion: typeof RUN_WORKSPACE_STRUCTURE_VERSION
  runId: string
  createdAt: string
  outputRoot: string
  cwd: string
  createdDirectories: RunWorkspaceDirectory[]
  taskFamily?: TaskFamily
  deliverableMode?: DeliverableMode
}

export interface RunArtifactRecord {
  id: string
  path: string
  origin: RunArtifactOrigin
  environment?: string
  project?: string
  threadId?: string
  turnId?: string
  runId?: string
  taskId?: string
  jobId?: string
  proofId?: string
  factRefs?: RuntimeFactRefs
  artifactType?: string
  size: number | null
  mtime: string | null
  mtimeMs: number | null
  stepId?: string
  participatesInFinal: boolean
  status: RunArtifactStatus
  sourcePath?: string
  recordedAt: string
  updatedAt: string
  missingAt?: string
}

export interface ArtifactLedger {
  version: 1
  updatedAt: string
  artifacts: RunArtifactRecord[]
}

export interface RunWorkspaceEvent {
  type: string
  at?: string
  stepId?: string
  message?: string
  factRefs?: RuntimeFactRefs
  data?: Record<string, unknown>
}

export interface StoredRunWorkspaceEvent extends RunWorkspaceEvent {
  at: string
  runId: string
  factRefs?: RuntimeFactRefs
}

export interface CreateRunWorkspaceOptions {
  outputRoot: string
  cwd?: string
  runId?: string
  createdAt?: string
  taskFamily?: TaskFamily
  deliverableMode?: DeliverableMode
  skillRoute?: Record<string, unknown>
  plan?: Record<string, unknown>
  verification?: Record<string, unknown>
  projectMap?: ProjectMapSnapshot
  checkpoint?: RunCheckpoint
  artifacts?: RunArtifactRecord[]
}

export interface CreateRunWorkspaceResult {
  paths: RunWorkspacePaths
  manifest: RunManifest
}

export interface RecordArtifactOptions {
  path: string
  origin: RunArtifactOrigin
  environment?: string
  project?: string
  threadId?: string
  turnId?: string
  runId?: string
  taskId?: string
  jobId?: string
  proofId?: string
  factRefs?: RuntimeFactRefs
  artifactType?: string
  stepId?: string
  participatesInFinal?: boolean
  sourcePath?: string
  id?: string
}

export interface ReadArtifactLedgerOptions {
  refresh?: boolean
  environment?: string
  project?: string
  runId?: string
  jobId?: string
  artifactType?: string
  origin?: string
  status?: string
  stepId?: string
  participatesInFinal?: boolean
}

export type RunCheckpoint = Record<string, unknown>

export function getRunWorkspacePaths(outputRoot: string, cwd = process.cwd()): RunWorkspacePaths {
  const resolvedOutputRoot = resolvePath(outputRoot, cwd)
  const runDir = join(resolvedOutputRoot, RUN_WORKSPACE_DIR)
  return buildRunWorkspacePaths(resolvedOutputRoot, runDir)
}

export async function createRunWorkspace(options: CreateRunWorkspaceOptions): Promise<CreateRunWorkspaceResult> {
  const cwd = resolvePath(options.cwd ?? process.cwd(), process.cwd())
  const paths = getRunWorkspacePaths(options.outputRoot, cwd)
  const createdAt = options.createdAt ?? new Date().toISOString()
  const manifest: RunManifest = {
    version: 1,
    structureVersion: RUN_WORKSPACE_STRUCTURE_VERSION,
    runId: options.runId ?? `run-${randomUUID()}`,
    createdAt,
    outputRoot: paths.outputRoot,
    cwd,
    createdDirectories: [...RUN_WORKSPACE_DIRECTORIES],
    ...(options.taskFamily ? { taskFamily: options.taskFamily } : {}),
    ...(options.deliverableMode ? { deliverableMode: options.deliverableMode } : {}),
  }

  await mkdir(paths.outputRoot, { recursive: true })
  await mkdir(paths.runDir, { recursive: true })
  for (const directory of RUN_WORKSPACE_DIRECTORIES) {
    await mkdir(join(paths.outputRoot, directory), { recursive: true })
  }
  await writeJson(paths.manifestPath, manifest)
  await writeJson(paths.skillRoutePath, options.skillRoute ?? {})
  await writeJson(paths.planPath, options.plan ?? { steps: [] })
  await writeJson(paths.verificationPath, options.verification ?? { checks: [], results: [] })
  if (options.projectMap) {
    await writeJson(paths.projectMapPath, options.projectMap)
  }
  await writeJson(paths.checkpointPath, options.checkpoint ?? {
    version: 1,
    updatedAt: createdAt,
    status: 'initialized',
  })
  await writeJson(paths.artifactsPath, {
    version: 1,
    updatedAt: createdAt,
    artifacts: options.artifacts ?? [],
  } satisfies ArtifactLedger)
  await writeFile(paths.eventsPath, '', { flag: 'a' })

  return { paths, manifest }
}

export async function readManifest(runRef: string, cwd = process.cwd()): Promise<RunManifest> {
  const paths = getRunWorkspacePathsFromRef(runRef, cwd)
  return readJson<RunManifest>(paths.manifestPath)
}

export async function writeCheckpoint(runRef: string, checkpoint: RunCheckpoint, cwd = process.cwd()): Promise<RunCheckpoint> {
  const paths = getRunWorkspacePathsFromRef(runRef, cwd)
  await writeJson(paths.checkpointPath, checkpoint)
  return checkpoint
}

export async function readCheckpoint(runRef: string, cwd = process.cwd()): Promise<RunCheckpoint> {
  const paths = getRunWorkspacePathsFromRef(runRef, cwd)
  return readJson<RunCheckpoint>(paths.checkpointPath)
}

export async function writeSkillRoute(runRef: string, skillRoute: Record<string, unknown>, cwd = process.cwd()): Promise<void> {
  const paths = getRunWorkspacePathsFromRef(runRef, cwd)
  await writeJson(paths.skillRoutePath, skillRoute)
}

export async function writePlan(runRef: string, plan: Record<string, unknown>, cwd = process.cwd()): Promise<void> {
  const paths = getRunWorkspacePathsFromRef(runRef, cwd)
  await writeJson(paths.planPath, plan)
}

export async function writeVerification(runRef: string, verification: Record<string, unknown>, cwd = process.cwd()): Promise<void> {
  const paths = getRunWorkspacePathsFromRef(runRef, cwd)
  await writeJson(paths.verificationPath, verification)
}

export async function writeProjectMap(
  runRef: string,
  projectMap: ProjectMapSnapshot,
  cwd = process.cwd(),
): Promise<ProjectMapSnapshot> {
  const paths = getRunWorkspacePathsFromRef(runRef, cwd)
  await writeJson(paths.projectMapPath, projectMap)
  return projectMap
}

export async function readProjectMap(runRef: string, cwd = process.cwd()): Promise<ProjectMapSnapshot> {
  const paths = getRunWorkspacePathsFromRef(runRef, cwd)
  return readJson<ProjectMapSnapshot>(paths.projectMapPath)
}

export async function readArtifactLedger(
  runRef: string,
  options: ReadArtifactLedgerOptions = {},
  cwd = process.cwd(),
): Promise<ArtifactLedger> {
  if (options.refresh) {
    return filterArtifactLedger(await refreshArtifactLedger(runRef, cwd), options)
  }
  const paths = getRunWorkspacePathsFromRef(runRef, cwd)
  return filterArtifactLedger(await readJson<ArtifactLedger>(paths.artifactsPath), options)
}

export async function recordArtifact(
  runRef: string,
  options: RecordArtifactOptions,
  cwd = process.cwd(),
): Promise<RunArtifactRecord> {
  const paths = getRunWorkspacePathsFromRef(runRef, cwd)
  const manifest = await readManifest(paths.runDir)
  const ledger = await readArtifactLedger(paths.runDir)
  const now = new Date().toISOString()
  const artifactPath = resolveArtifactPath(options.path, manifest.outputRoot)
  const observed = await observeArtifact(artifactPath)
  const existingIndex = ledger.artifacts.findIndex((artifact) => normalize(artifact.path) === normalize(artifactPath))
  const existing = existingIndex >= 0 ? ledger.artifacts[existingIndex] : undefined
  const artifactId = options.id ?? existing?.id ?? `artifact-${ledger.artifacts.length + 1}`
  const runId = options.runId ?? existing?.runId ?? manifest.runId
  const factRefs = mergeRuntimeFactRefs(options.factRefs, existing?.factRefs, {
    threadId: options.threadId ?? existing?.threadId,
    turnId: options.turnId ?? existing?.turnId,
    runId,
    taskId: options.taskId ?? existing?.taskId,
    stepId: options.stepId ?? existing?.stepId,
    jobId: options.jobId ?? existing?.jobId,
    artifactId,
    artifactPath,
    proofId: options.proofId ?? existing?.proofId,
  })
  const record: RunArtifactRecord = {
    id: artifactId,
    path: artifactPath,
    origin: options.origin,
    ...(options.environment ? { environment: options.environment } : existing?.environment ? { environment: existing.environment } : {}),
    ...(options.project ? { project: options.project } : existing?.project ? { project: existing.project } : {}),
    ...(factRefs?.threadId ? { threadId: factRefs.threadId } : {}),
    ...(factRefs?.turnId ? { turnId: factRefs.turnId } : {}),
    runId,
    ...(factRefs?.taskId ? { taskId: factRefs.taskId } : {}),
    ...(options.jobId ? { jobId: options.jobId } : existing?.jobId ? { jobId: existing.jobId } : {}),
    ...(factRefs?.proofId ? { proofId: factRefs.proofId } : {}),
    ...(factRefs ? { factRefs } : {}),
    ...(options.artifactType ? { artifactType: options.artifactType } : existing?.artifactType ? { artifactType: existing.artifactType } : {}),
    size: observed.size,
    mtime: observed.mtime,
    mtimeMs: observed.mtimeMs,
    ...(options.stepId ? { stepId: options.stepId } : existing?.stepId ? { stepId: existing.stepId } : {}),
    participatesInFinal: options.participatesInFinal ?? existing?.participatesInFinal ?? true,
    status: observed.status,
    ...(options.sourcePath ? { sourcePath: options.sourcePath } : existing?.sourcePath ? { sourcePath: existing.sourcePath } : {}),
    recordedAt: existing?.recordedAt ?? now,
    updatedAt: now,
    ...(observed.status === 'missing' ? { missingAt: existing?.missingAt ?? now } : {}),
  }

  if (existingIndex >= 0) {
    ledger.artifacts[existingIndex] = record
  } else {
    ledger.artifacts.push(record)
  }
  ledger.updatedAt = now
  await writeJson(paths.artifactsPath, ledger)
  return record
}

export async function refreshArtifactLedger(runRef: string, cwd = process.cwd()): Promise<ArtifactLedger> {
  const paths = getRunWorkspacePathsFromRef(runRef, cwd)
  const ledger = await readArtifactLedger(paths.runDir)
  let changed = false
  const now = new Date().toISOString()
  const artifacts: RunArtifactRecord[] = []

  for (const artifact of ledger.artifacts) {
    const observed = await observeArtifact(artifact.path)
    const next: RunArtifactRecord = {
      ...artifact,
      size: observed.status === 'present' ? observed.size : artifact.size,
      mtime: observed.status === 'present' ? observed.mtime : artifact.mtime,
      mtimeMs: observed.status === 'present' ? observed.mtimeMs : artifact.mtimeMs,
      status: observed.status,
      updatedAt: artifact.updatedAt,
      ...(observed.status === 'missing'
        ? { missingAt: artifact.missingAt ?? now }
        : {}),
    }
    if (observed.status === 'present' && next.missingAt) {
      delete next.missingAt
    }
    if (!artifactRecordsEqual(artifact, next)) {
      next.updatedAt = now
      changed = true
    }
    artifacts.push(next)
  }

  const refreshed: ArtifactLedger = {
    version: ledger.version,
    updatedAt: changed ? now : ledger.updatedAt,
    artifacts,
  }
  if (changed) {
    await writeJson(paths.artifactsPath, refreshed)
  }
  return refreshed
}

export async function recordEvent(
  runRef: string,
  event: RunWorkspaceEvent,
  cwd = process.cwd(),
): Promise<StoredRunWorkspaceEvent> {
  const paths = getRunWorkspacePathsFromRef(runRef, cwd)
  const manifest = await readManifest(paths.runDir)
  const factRefs = mergeRuntimeFactRefs(event.factRefs, {
    runId: manifest.runId,
    stepId: event.stepId,
  })
  const stored: StoredRunWorkspaceEvent = {
    ...event,
    at: event.at ?? new Date().toISOString(),
    runId: manifest.runId,
    ...(factRefs ? { factRefs } : {}),
  }
  await appendFile(paths.eventsPath, `${JSON.stringify(stored)}\n`, 'utf8')
  return stored
}

export function getRunWorkspacePathsFromRef(runRef: string, cwd = process.cwd()): RunWorkspacePaths {
  const resolved = resolvePath(runRef, cwd)
  if (basename(resolved) === 'manifest.json') {
    return pathsFromRunDir(dirname(resolved))
  }
  if (basename(resolved) === RUN_WORKSPACE_DIR) {
    return pathsFromRunDir(resolved)
  }
  return getRunWorkspacePaths(resolved)
}

function pathsFromRunDir(runDir: string): RunWorkspacePaths {
  const outputRoot = dirname(runDir)
  return buildRunWorkspacePaths(outputRoot, runDir)
}

function filterArtifactLedger(ledger: ArtifactLedger, options: ReadArtifactLedgerOptions): ArtifactLedger {
  const filters = artifactLedgerFilters(options)
  if (filters.length === 0) return ledger
  return {
    ...ledger,
    artifacts: ledger.artifacts.filter(artifact => filters.every(filter => filter(artifact))),
  }
}

function artifactLedgerFilters(options: ReadArtifactLedgerOptions): Array<(artifact: RunArtifactRecord) => boolean> {
  const filters: Array<(artifact: RunArtifactRecord) => boolean> = []
  const stringFields = [
    'environment',
    'project',
    'runId',
    'jobId',
    'artifactType',
    'origin',
    'status',
    'stepId',
  ] as const
  for (const field of stringFields) {
    const value = options[field]
    if (typeof value === 'string' && value.trim()) {
      filters.push((artifact) => artifact[field] === value.trim())
    }
  }
  if (typeof options.participatesInFinal === 'boolean') {
    filters.push((artifact) => artifact.participatesInFinal === options.participatesInFinal)
  }
  return filters
}

function buildRunWorkspacePaths(outputRoot: string, runDir: string): RunWorkspacePaths {
  return {
    outputRoot,
    runDir,
    manifestPath: join(runDir, 'manifest.json'),
    checkpointPath: join(runDir, 'checkpoint.json'),
    skillRoutePath: join(runDir, 'skill-route.json'),
    planPath: join(runDir, 'plan.json'),
    artifactsPath: join(runDir, 'artifacts.json'),
    verificationPath: join(runDir, 'verification.json'),
    projectMapPath: join(runDir, 'project-map.json'),
    eventsPath: join(runDir, 'events.jsonl'),
    stageDir: join(outputRoot, 'stage'),
    finalDir: join(outputRoot, 'final'),
    assetsDir: join(outputRoot, 'assets'),
    scriptsDir: join(outputRoot, 'scripts'),
    evidenceDir: join(outputRoot, 'evidence'),
    notesDir: join(outputRoot, 'notes'),
  }
}

function resolvePath(path: string, cwd: string): string {
  return normalize(isAbsolute(path) ? resolve(path) : resolve(cwd, path))
}

function resolveArtifactPath(path: string, outputRoot: string): string {
  return normalize(isAbsolute(path) ? resolve(path) : resolve(outputRoot, path))
}

async function observeArtifact(path: string): Promise<{
  status: RunArtifactStatus
  size: number | null
  mtime: string | null
  mtimeMs: number | null
}> {
  try {
    const info = await stat(path)
    return {
      status: 'present',
      size: info.size,
      mtime: info.mtime.toISOString(),
      mtimeMs: info.mtimeMs,
    }
  } catch (err) {
    if (isMissingFileError(err)) {
      return {
        status: 'missing',
        size: null,
        mtime: null,
        mtimeMs: null,
      }
    }
    throw err
  }
}

function isMissingFileError(err: unknown): boolean {
  return typeof err === 'object'
    && err !== null
    && 'code' in err
    && (err as { code?: unknown }).code === 'ENOENT'
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, 'utf8')
  return JSON.parse(raw) as T
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function artifactRecordsEqual(a: RunArtifactRecord, b: RunArtifactRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
