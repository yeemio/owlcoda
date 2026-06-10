import { buildProjectMapSnapshot } from '../project-map.js'
import {
  getRunWorkspacePathsFromRef,
  readProjectMap,
  writeProjectMap,
} from '../run-workspace.js'
import { checkReadPathAllowed, checkWritePathAllowed } from './fs-policy.js'
import type { NativeToolDef, ToolExecutionContext, ToolResult } from './types.js'
import { extractUserDeclaredExternalRoots } from '../task-state.js'

export type ProjectMapAction = 'scan' | 'show' | 'refresh'

export interface ProjectMapInput {
  action: ProjectMapAction | string
  cwd?: string
  runRef?: string
  maxSourceBytes?: number
}

const ACTIONS = new Set<ProjectMapAction>(['scan', 'show', 'refresh'])

export function createProjectMapTool(): NativeToolDef<ProjectMapInput> {
  return {
    name: 'ProjectMap',
    description:
      'Read or refresh the bounded OwlCoda Project Map snapshot. scan builds a read-only snapshot; ' +
      'refresh writes .owlcoda-run/project-map.json for an existing RunWorkspace; show reads that persisted snapshot.',
    maturity: 'beta',

    async execute(input: ProjectMapInput, context?: ToolExecutionContext): Promise<ToolResult> {
      const action = typeof input?.action === 'string' ? input.action : ''
      if (!isProjectMapAction(action)) {
        return error(
          `Error: action is required and must be one of: ${[...ACTIONS].join(', ')}.`,
          'project-map:invalid-action',
        )
      }

      try {
        if (action === 'show') return await executeShow(input, context)
        const snapshot = buildProjectMapSnapshot(input.cwd ?? context?.taskState?.contract.cwd ?? process.cwd(), {
          ...(typeof input.maxSourceBytes === 'number' ? { maxSourceBytes: input.maxSourceBytes } : {}),
        })
        if (action === 'scan') {
          return jsonResult(snapshot, { action: 'scan', packageName: snapshot.packageName })
        }

        const runRef = requiredString(input.runRef, 'runRef')
        if (typeof runRef !== 'string') return runRef
        const paths = getRunWorkspacePathsFromRef(runRef, input.cwd)
        const fsVerdict = allowMetadataWrite(paths.projectMapPath, input, context)
        if (fsVerdict) return fsVerdict
        const persisted = await writeProjectMap(runRef, snapshot, input.cwd)
        return jsonResult(persisted, { action, packageName: persisted.packageName, projectMapPath: paths.projectMapPath })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return error(`Error: ${message}`, 'project-map:execution-error')
      }
    },
  }
}

async function executeShow(input: ProjectMapInput, context?: ToolExecutionContext): Promise<ToolResult> {
  const runRef = requiredString(input.runRef, 'runRef')
  if (typeof runRef !== 'string') return runRef
  const paths = getRunWorkspacePathsFromRef(runRef, input.cwd)
  const fsVerdict = allowMetadataRead(paths.projectMapPath, input, context)
  if (fsVerdict) return fsVerdict
  const snapshot = await readProjectMap(runRef, input.cwd)
  return jsonResult(snapshot, { action: 'show', packageName: snapshot.packageName })
}

function isProjectMapAction(value: string): value is ProjectMapAction {
  return ACTIONS.has(value as ProjectMapAction)
}

function requiredString(value: unknown, name: string): string | ToolResult {
  if (typeof value !== 'string' || value.trim() === '') {
    return {
      output: `Error: ${name} is required.`,
      isError: true,
      metadata: { failureCategory: `project-map:missing-${name}` },
    }
  }
  return value
}

function allowMetadataWrite(targetPath: string, input: ProjectMapInput, context?: ToolExecutionContext): ToolResult | null {
  const policy = checkWritePathAllowed(targetPath, {
    workspaceRoot: input.cwd ?? context?.taskState?.contract.cwd,
    externalScopes: extractUserDeclaredExternalRoots(context?.taskState),
  })
  if (policy.allowed) return null
  return {
    output: `Error: ${policy.reason}`,
    isError: true,
    metadata: {
      failureCategory: 'project-map:fs-policy-denied',
      fsPolicyDenied: true,
      attemptedPath: policy.attemptedPath,
    },
  }
}

function allowMetadataRead(targetPath: string, input: ProjectMapInput, context?: ToolExecutionContext): ToolResult | null {
  const policy = checkReadPathAllowed(targetPath, {
    workspaceRoot: input.cwd ?? context?.taskState?.contract.cwd,
    externalScopes: extractUserDeclaredExternalRoots(context?.taskState),
  })
  if (policy.allowed) return null
  return {
    output: `Error: ${policy.reason}`,
    isError: true,
    metadata: {
      failureCategory: 'project-map:fs-policy-denied',
      fsPolicyDenied: true,
      attemptedPath: policy.attemptedPath,
    },
  }
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
