import type { DeliverableMode } from '../deliverable-contract.js'
import {
  assessRunWorkspaceCompletion,
  createRunWorkspace,
  getRunWorkspacePaths,
  getRunWorkspacePathsFromRef,
  readCheckpoint,
  readArtifactLedger,
  readManifest,
  recordArtifact,
  recordEvent,
  refreshArtifactLedger,
  writeCheckpoint,
  type RunCheckpoint,
  type RunArtifactOrigin,
  type RunWorkspaceEvent,
  type TaskFamily,
} from '../run-workspace.js'
import { isAbsolute, normalize, relative, resolve } from 'node:path'
import { checkReadPathAllowed, checkWritePathAllowed } from './fs-policy.js'
import type { NativeToolDef, ToolExecutionContext, ToolResult } from './types.js'
import { extractUserDeclaredExternalRoots } from '../task-state.js'

export type RunWorkspaceAction =
  | 'create'
  | 'readManifest'
  | 'recordArtifact'
  | 'readLedger'
  | 'refreshLedger'
  | 'recordEvent'
  | 'writeCheckpoint'
  | 'readCheckpoint'
  | 'assessCompletion'

export interface RunWorkspaceInput {
  action: RunWorkspaceAction | string
  outputRoot?: string
  cwd?: string
  runRef?: string
  taskFamily?: TaskFamily | string
  deliverableMode?: DeliverableMode | string
  skillRoute?: Record<string, unknown>
  plan?: Record<string, unknown>
  verification?: Record<string, unknown>
  checkpoint?: RunCheckpoint
  path?: string
  origin?: RunArtifactOrigin | string
  environment?: string
  project?: string
  runId?: string
  jobId?: string
  artifactType?: string
  stepId?: string
  status?: string
  participatesInFinal?: boolean
  sourcePath?: string
  event?: RunWorkspaceEvent
  type?: string
  at?: string
  message?: string
  data?: Record<string, unknown>
}

const ACTIONS = new Set<RunWorkspaceAction>([
  'create',
  'readManifest',
  'recordArtifact',
  'readLedger',
  'refreshLedger',
  'recordEvent',
  'writeCheckpoint',
  'readCheckpoint',
  'assessCompletion',
])

const TASK_FAMILIES = new Set<TaskFamily>([
  'deck',
  'code',
  'image_asset',
  'research',
  'data_report',
  'release',
  'general',
])

const DELIVERABLE_MODES = new Set<DeliverableMode>([
  'read_only_review',
  'text_deliverable',
  'file_artifact_delivery',
  'code_change',
  'command_job',
  'mixed_unknown',
])

export function createRunWorkspaceTool(): NativeToolDef<RunWorkspaceInput> {
  return {
    name: 'RunWorkspace',
    description:
      'Manage OwlCoda durable run metadata under .owlcoda-run. Supports ' +
      'create/readManifest/recordArtifact/readLedger/refreshLedger/recordEvent/' +
      'writeCheckpoint/readCheckpoint/writeVerification/assessCompletion. ' +
      'This tool does not execute shell commands or write user deliverables; it ' +
      'only creates and updates run manifest, artifact ledger, verification, checkpoint, and event metadata.',
    maturity: 'beta',

    async execute(input: RunWorkspaceInput, context?: ToolExecutionContext): Promise<ToolResult> {
      const action = typeof input?.action === 'string' ? input.action : ''
      if (!isRunWorkspaceAction(action)) {
        return error(
          `Error: action is required and must be one of: ${[...ACTIONS].join(', ')}.`,
          'run-workspace:invalid-action',
        )
      }

      try {
        const effectiveInput = action === 'create' ? input : withActiveRunRef(input, context)
        if (action === 'create') return await executeCreate(effectiveInput, context)
        if (action === 'readManifest') return await executeReadManifest(effectiveInput, context)
        if (action === 'recordArtifact') return await executeRecordArtifact(effectiveInput, context)
        if (action === 'readLedger') return await executeReadLedger(effectiveInput, context)
        if (action === 'refreshLedger') return await executeRefreshLedger(effectiveInput, context)
        if (action === 'recordEvent') return await executeRecordEvent(effectiveInput, context)
        if (action === 'writeCheckpoint') return await executeWriteCheckpoint(effectiveInput, context)
        if (action === 'assessCompletion') return await executeAssessCompletion(effectiveInput, context)
        return await executeReadCheckpoint(effectiveInput, context)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return error(`Error: ${message}`, 'run-workspace:execution-error')
      }
    },
  }
}

function withActiveRunRef(input: RunWorkspaceInput, context?: ToolExecutionContext): RunWorkspaceInput {
  if (input.runRef?.trim()) return input
  const runDir = context?.taskState?.run.runWorkspace?.runDir
  return runDir ? { ...input, runRef: runDir } : input
}

async function executeCreate(input: RunWorkspaceInput, context?: ToolExecutionContext): Promise<ToolResult> {
  const outputRoot = requiredString(input.outputRoot, 'outputRoot')
  if (typeof outputRoot !== 'string') return outputRoot

  const taskFamily = optionalEnum(input.taskFamily, TASK_FAMILIES, 'taskFamily')
  if (taskFamily instanceof Error) return validationError(taskFamily.message)
  const deliverableMode = optionalEnum(input.deliverableMode, DELIVERABLE_MODES, 'deliverableMode')
  if (deliverableMode instanceof Error) return validationError(deliverableMode.message)

  const effectiveCwd = input.cwd ?? context?.taskState?.contract.cwd ?? process.cwd()
  const paths = getRunWorkspacePaths(outputRoot, effectiveCwd)
  const fsVerdict = allowMetadataWrite(paths.manifestPath, input, context)
  if (fsVerdict) return fsVerdict

  const result = await createRunWorkspace({
    outputRoot,
    cwd: effectiveCwd,
    ...(taskFamily ? { taskFamily } : {}),
    ...(deliverableMode ? { deliverableMode } : {}),
    ...(isRecord(input.skillRoute) ? { skillRoute: input.skillRoute } : {}),
    ...(isRecord(input.plan) ? { plan: input.plan } : {}),
  })

  return jsonResult(result, { action: 'create', runDir: result.paths.runDir })
}

async function executeReadManifest(input: RunWorkspaceInput, context?: ToolExecutionContext): Promise<ToolResult> {
  const runRef = requiredString(input.runRef, 'runRef')
  if (typeof runRef !== 'string') return runRef
  const fsVerdict = allowMetadataRead(getRunWorkspacePathsFromRef(runRef, input.cwd).manifestPath, input, context)
  if (fsVerdict) return fsVerdict
  const result = await readManifest(runRef, input.cwd)
  return jsonResult(result, { action: 'readManifest', runId: result.runId })
}

async function executeRecordArtifact(input: RunWorkspaceInput, context?: ToolExecutionContext): Promise<ToolResult> {
  const runRef = requiredString(input.runRef, 'runRef')
  if (typeof runRef !== 'string') return runRef
  const artifactPath = requiredString(input.path, 'path')
  if (typeof artifactPath !== 'string') return artifactPath
  const origin = requiredString(input.origin, 'origin')
  if (typeof origin !== 'string') return origin

  const paths = getRunWorkspacePathsFromRef(runRef, input.cwd)
  const fsVerdict = allowMetadataWrite(paths.artifactsPath, input, context)
  if (fsVerdict) return fsVerdict
  const manifest = await readManifest(runRef, input.cwd)
  const artifactScope = validateArtifactPathWithinOutputRoot(artifactPath, manifest.outputRoot)
  if (artifactScope) return artifactScope

  const result = await recordArtifact(runRef, {
    path: artifactPath,
    origin,
    ...(typeof input.environment === 'string' && input.environment.trim() ? { environment: input.environment } : {}),
    ...(typeof input.project === 'string' && input.project.trim() ? { project: input.project } : {}),
    ...(typeof input.runId === 'string' && input.runId.trim() ? { runId: input.runId } : {}),
    ...(typeof input.jobId === 'string' && input.jobId.trim() ? { jobId: input.jobId } : {}),
    ...(typeof input.artifactType === 'string' && input.artifactType.trim() ? { artifactType: input.artifactType } : {}),
    ...(typeof input.stepId === 'string' && input.stepId.trim() ? { stepId: input.stepId } : {}),
    ...(typeof input.participatesInFinal === 'boolean' ? { participatesInFinal: input.participatesInFinal } : {}),
    ...(typeof input.sourcePath === 'string' && input.sourcePath.trim() ? { sourcePath: input.sourcePath } : {}),
  }, input.cwd)

  return jsonResult(result, { action: 'recordArtifact', artifactPath: result.path, status: result.status })
}

async function executeReadLedger(input: RunWorkspaceInput, context?: ToolExecutionContext): Promise<ToolResult> {
  const runRef = requiredString(input.runRef, 'runRef')
  if (typeof runRef !== 'string') return runRef
  const fsVerdict = allowMetadataRead(getRunWorkspacePathsFromRef(runRef, input.cwd).artifactsPath, input, context)
  if (fsVerdict) return fsVerdict
  const filters = artifactLedgerReadFilters(input)
  const result = await readArtifactLedger(runRef, filters, input.cwd)
  if (Object.keys(filters).length > 0) {
    return jsonResult({
      ledger: result,
      artifactCount: result.artifacts.length,
      filters,
    }, { action: 'readLedger', artifactCount: result.artifacts.length, filters })
  }
  return jsonResult(result, { action: 'readLedger', artifactCount: result.artifacts.length })
}

async function executeRefreshLedger(input: RunWorkspaceInput, context?: ToolExecutionContext): Promise<ToolResult> {
  const runRef = requiredString(input.runRef, 'runRef')
  if (typeof runRef !== 'string') return runRef
  const paths = getRunWorkspacePathsFromRef(runRef, input.cwd)
  const fsVerdict = allowMetadataWrite(paths.artifactsPath, input, context)
  if (fsVerdict) return fsVerdict
  const manifest = await readManifest(runRef, input.cwd)
  const ledger = await readArtifactLedger(runRef, {}, input.cwd)
  for (const artifact of ledger.artifacts) {
    const artifactScope = validateArtifactPathWithinOutputRoot(artifact.path, manifest.outputRoot)
    if (artifactScope) return artifactScope
  }
  const result = await refreshArtifactLedger(runRef, input.cwd)
  return jsonResult(result, { action: 'refreshLedger', artifactCount: result.artifacts.length })
}

async function executeRecordEvent(input: RunWorkspaceInput, context?: ToolExecutionContext): Promise<ToolResult> {
  const runRef = requiredString(input.runRef, 'runRef')
  if (typeof runRef !== 'string') return runRef
  const fsVerdict = allowMetadataWrite(getRunWorkspacePathsFromRef(runRef, input.cwd).eventsPath, input, context)
  if (fsVerdict) return fsVerdict

  const event = resolveEventInput(input)
  if (event instanceof Error) return validationError(event.message)

  const result = await recordEvent(runRef, event, input.cwd)
  return jsonResult(result, { action: 'recordEvent', eventType: result.type, runId: result.runId })
}

async function executeWriteCheckpoint(input: RunWorkspaceInput, context?: ToolExecutionContext): Promise<ToolResult> {
  const runRef = requiredString(input.runRef, 'runRef')
  if (typeof runRef !== 'string') return runRef
  const checkpoint = resolveCheckpointInput(input)
  if (checkpoint instanceof Error) return validationError(checkpoint.message)
  if (checkpoint.status === 'completed') {
    return validationError('RunWorkspace completed checkpoints are runtime-owned and can only be written by passing TaskVerify.')
  }

  const fsVerdict = allowMetadataWrite(getRunWorkspacePathsFromRef(runRef, input.cwd).checkpointPath, input, context)
  if (fsVerdict) return fsVerdict

  const result = await writeCheckpoint(runRef, checkpoint, input.cwd)
  return jsonResult(result, { action: 'writeCheckpoint' })
}

async function executeReadCheckpoint(input: RunWorkspaceInput, context?: ToolExecutionContext): Promise<ToolResult> {
  const runRef = requiredString(input.runRef, 'runRef')
  if (typeof runRef !== 'string') return runRef
  const fsVerdict = allowMetadataRead(getRunWorkspacePathsFromRef(runRef, input.cwd).checkpointPath, input, context)
  if (fsVerdict) return fsVerdict
  const result = await readCheckpoint(runRef, input.cwd)
  return jsonResult(result, { action: 'readCheckpoint' })
}

async function executeAssessCompletion(input: RunWorkspaceInput, context?: ToolExecutionContext): Promise<ToolResult> {
  const runRef = requiredString(input.runRef, 'runRef')
  if (typeof runRef !== 'string') return runRef
  const paths = getRunWorkspacePathsFromRef(runRef, input.cwd)
  const fsVerdict = allowMetadataRead(paths.runDir, input, context)
  if (fsVerdict) return fsVerdict
  const result = await assessRunWorkspaceCompletion(runRef, input.cwd)
  return jsonResult(result, { action: 'assessCompletion', verdict: result.verdict, blockerCount: result.blockers.length })
}

function resolveEventInput(input: RunWorkspaceInput): RunWorkspaceEvent | Error {
  if (isRecord(input.event)) {
    if (typeof input.event.type !== 'string' || input.event.type.trim() === '') {
      return new Error('event.type is required for recordEvent.')
    }
    return input.event as RunWorkspaceEvent
  }
  if (typeof input.type !== 'string' || input.type.trim() === '') {
    return new Error('event.type or top-level type is required for recordEvent.')
  }
  return {
    type: input.type,
    ...(typeof input.at === 'string' && input.at.trim() ? { at: input.at } : {}),
    ...(typeof input.stepId === 'string' && input.stepId.trim() ? { stepId: input.stepId } : {}),
    ...(typeof input.message === 'string' && input.message.trim() ? { message: input.message } : {}),
    ...(isRecord(input.data) ? { data: input.data } : {}),
  }
}

function artifactLedgerReadFilters(input: RunWorkspaceInput) {
  return {
    ...(typeof input.environment === 'string' && input.environment.trim() ? { environment: input.environment.trim() } : {}),
    ...(typeof input.project === 'string' && input.project.trim() ? { project: input.project.trim() } : {}),
    ...(typeof input.runId === 'string' && input.runId.trim() ? { runId: input.runId.trim() } : {}),
    ...(typeof input.jobId === 'string' && input.jobId.trim() ? { jobId: input.jobId.trim() } : {}),
    ...(typeof input.artifactType === 'string' && input.artifactType.trim() ? { artifactType: input.artifactType.trim() } : {}),
    ...(typeof input.origin === 'string' && input.origin.trim() ? { origin: input.origin.trim() } : {}),
    ...(typeof input.status === 'string' && input.status.trim() ? { status: input.status.trim() } : {}),
    ...(typeof input.stepId === 'string' && input.stepId.trim() ? { stepId: input.stepId.trim() } : {}),
    ...(typeof input.participatesInFinal === 'boolean' ? { participatesInFinal: input.participatesInFinal } : {}),
  }
}

function resolveCheckpointInput(input: RunWorkspaceInput): RunCheckpoint | Error {
  if (!isRecord(input.checkpoint)) {
    return new Error('checkpoint object is required for writeCheckpoint.')
  }
  return input.checkpoint
}

function isRunWorkspaceAction(value: string): value is RunWorkspaceAction {
  return ACTIONS.has(value as RunWorkspaceAction)
}

function requiredString(value: unknown, name: string): string | ToolResult {
  if (typeof value !== 'string' || value.trim() === '') {
    return {
      output: `Error: ${name} is required.`,
      isError: true,
      metadata: { failureCategory: `run-workspace:missing-${name}` },
    }
  }
  return value
}

function optionalEnum<T extends string>(value: unknown, allowed: Set<T>, name: string): T | undefined | Error {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    return new Error(`${name} must be one of: ${[...allowed].join(', ')}.`)
  }
  return value as T
}

function validationError(message: string): ToolResult {
  return error(`Error: ${message}`, 'run-workspace:invalid-input')
}

function allowMetadataWrite(targetPath: string, input: RunWorkspaceInput, context?: ToolExecutionContext): ToolResult | null {
  const policy = checkWritePathAllowed(targetPath, {
    workspaceRoot: input.cwd ?? context?.taskState?.contract.cwd,
    externalScopes: extractUserDeclaredExternalRoots(context?.taskState),
    allowRunWorkspaceMetadata: true,
  })
  if (policy.allowed) return null
  return {
    output: `Error: ${policy.reason}`,
    isError: true,
    metadata: {
      failureCategory: 'run-workspace:fs-policy-denied',
      fsPolicyDenied: true,
      attemptedPath: policy.attemptedPath,
    },
  }
}

function allowMetadataRead(targetPath: string, input: RunWorkspaceInput, context?: ToolExecutionContext): ToolResult | null {
  const policy = checkReadPathAllowed(targetPath, {
    workspaceRoot: input.cwd ?? context?.taskState?.contract.cwd,
    externalScopes: extractUserDeclaredExternalRoots(context?.taskState),
  })
  if (policy.allowed) return null
  return {
    output: `Error: ${policy.reason}`,
    isError: true,
    metadata: {
      failureCategory: 'run-workspace:fs-policy-denied',
      fsPolicyDenied: true,
      attemptedPath: policy.attemptedPath,
    },
  }
}

function validateArtifactPathWithinOutputRoot(artifactPath: string, outputRoot: string): ToolResult | null {
  const root = normalize(resolve(outputRoot))
  const resolved = normalize(isAbsolute(artifactPath) ? resolve(artifactPath) : resolve(root, artifactPath))
  const rel = relative(root, resolved)
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) return null
  return error(
    `Error: artifact path resolves outside run workspace outputRoot. Resolved: ${resolved}. Output root: ${root}.`,
    'run-workspace:artifact-outside-output-root',
  )
}

function error(output: string, failureCategory: string): ToolResult {
  return {
    output,
    isError: true,
    metadata: { failureCategory },
  }
}

function jsonResult(result: unknown, metadata: Record<string, unknown>): ToolResult {
  return {
    output: JSON.stringify(result, null, 2),
    isError: false,
    metadata: { ...metadata, result },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
