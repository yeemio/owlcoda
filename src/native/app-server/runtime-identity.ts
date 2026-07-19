import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { VERSION, buildTag } from '../../version.js'
import { APP_SERVER_PROTOCOL_VERSION } from './protocol-contract.js'

export type AppServerCompatibility =
  | 'compatible'
  | 'version_mismatch'
  | 'protocol_mismatch'
  | 'workspace_mismatch'

export interface AppServerClientIdentity {
  name: string
  version: string
}

export interface AppServerClientInitializeInput {
  client: AppServerClientIdentity
  supportedProtocolVersions: string[]
  expectedRuntimeVersion?: string
  expectedWorkspaceRealpath: string
  requestedCapabilities: Record<string, boolean>
}

export interface AppServerClientInitializeResult {
  runtimeVersion: string
  runtimeBuild: string
  protocolVersion: string
  workspaceId: string
  workspaceRealpath: string
  capabilities: Record<string, boolean>
  compatibility: AppServerCompatibility
}

export const APP_SERVER_CAPABILITIES: Readonly<Record<string, boolean>> = Object.freeze({
  imageInput: true,
  review: true,
  eventReplay: true,
  approval: true,
  interaction: true,
  runtimeFacts: true,
  structuredOutputArtifacts: true,
  workflowRun: true,
  jobs: true,
})

export function initializeAppServerClient(
  projectRoot: string,
  input: AppServerClientInitializeInput,
): AppServerClientInitializeResult {
  const workspaceRealpath = canonicalWorkspaceRealpath(projectRoot)
  const identity = {
    runtimeVersion: VERSION,
    runtimeBuild: buildTag(),
    protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    workspaceId: workspaceIdForRealpath(workspaceRealpath),
    workspaceRealpath,
    capabilities: { ...APP_SERVER_CAPABILITIES },
  }
  return {
    ...identity,
    compatibility: classifyAppServerCompatibility(input, identity),
  }
}

export function classifyAppServerCompatibility(
  input: AppServerClientInitializeInput,
  identity: Omit<AppServerClientInitializeResult, 'compatibility'>,
): AppServerCompatibility {
  if (!input.supportedProtocolVersions.includes(identity.protocolVersion)) {
    return 'protocol_mismatch'
  }
  if (input.expectedRuntimeVersion && input.expectedRuntimeVersion !== identity.runtimeVersion) {
    return 'version_mismatch'
  }
  const expectedWorkspaceRealpath = canonicalExpectedWorkspaceRealpath(input.expectedWorkspaceRealpath)
  const returnedWorkspaceRealpath = canonicalExpectedWorkspaceRealpath(identity.workspaceRealpath)
  if (
    identity.workspaceRealpath !== returnedWorkspaceRealpath
    || expectedWorkspaceRealpath !== returnedWorkspaceRealpath
    || identity.workspaceId !== workspaceIdForRealpath(returnedWorkspaceRealpath)
  ) {
    return 'workspace_mismatch'
  }
  return 'compatible'
}

export function isAppServerClientInitializeResult(value: unknown): value is AppServerClientInitializeResult {
  if (!isRecord(value)) return false
  if (!isNonEmptyString(value.runtimeVersion)) return false
  if (!isNonEmptyString(value.runtimeBuild)) return false
  if (!isNonEmptyString(value.protocolVersion)) return false
  if (!isNonEmptyString(value.workspaceId)) return false
  if (!isNonEmptyString(value.workspaceRealpath)) return false
  if (!isCapabilityMap(value.capabilities)) return false
  return value.compatibility === 'compatible'
    || value.compatibility === 'version_mismatch'
    || value.compatibility === 'protocol_mismatch'
    || value.compatibility === 'workspace_mismatch'
}

export function workspaceIdForRealpath(workspaceRealpath: string): string {
  return createHash('sha256').update(workspaceRealpath).digest('hex')
}

function canonicalWorkspaceRealpath(path: string): string {
  return realpathSync(resolve(path))
}

function canonicalExpectedWorkspaceRealpath(path: string): string {
  try {
    return realpathSync(resolve(path))
  } catch {
    return resolve(path)
  }
}

function isCapabilityMap(value: unknown): value is Record<string, boolean> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'boolean')
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
