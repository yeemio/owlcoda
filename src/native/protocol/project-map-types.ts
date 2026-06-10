export type ProjectMapSourceKind =
  | 'AGENTS.md'
  | 'CLAUDE.md'
  | 'OWLCODA.md'
  | '.owlcoda/OWLCODA.md'
  | 'rule'
  | 'settings'
  | 'agent'
  | 'runtime'
  | 'package'
  | 'other'

export type ProjectMapSourceScope = 'repo' | 'directory' | 'user'
export type ProjectMapEntryPointKind = 'source_dir' | 'test_dir' | 'docs_dir' | 'script' | 'package_script' | 'config'
export type ProjectMapTruthSourceKind = 'file' | 'command' | 'git' | 'package'
export type ProjectMapWriteBoundaryKind = 'allow' | 'deny' | 'ask'
export type ProjectMapWriteBoundaryScope = 'file' | 'directory' | 'glob'
export type ProjectMapWriteBoundaryOrigin = 'instructions' | 'settings' | 'detected' | 'user'
export type ProjectMapVerificationAppliesTo =
  | 'code_change'
  | 'file_artifact_delivery'
  | 'text_deliverable'
  | 'command_job'
  | 'release'
export type ProjectMapEvidenceSeedKind =
  | 'instruction'
  | 'entrypoint'
  | 'package'
  | 'package_script'
  | 'git'
  | 'settings'
  | 'agent'
  | 'runtime'
  | 'verification'

export interface ProjectMapSnapshot {
  version: 1
  createdAt: string
  cwd: string
  gitRoot?: string
  gitHead?: string
  packageName?: string
  packageVersion?: string
  sourceFiles: ProjectMapSourceFile[]
  entrypoints: ProjectMapEntryPoint[]
  truthSources: ProjectMapTruthSource[]
  evidenceSeeds: ProjectMapEvidenceSeed[]
  writeBoundaries: ProjectMapWriteBoundary[]
  verificationProfiles: ProjectMapVerificationProfile[]
  freshness: ProjectMapFreshness
}

export interface ProjectMapSourceFile {
  path: string
  kind: ProjectMapSourceKind
  scope: ProjectMapSourceScope
  bytesRead: number
  sha256: string
}

export interface ProjectMapEntryPoint {
  path: string
  kind: ProjectMapEntryPointKind
  reason: string
}

export interface ProjectMapTruthSource {
  path?: string
  command?: string
  kind: ProjectMapTruthSourceKind
  reason: string
  safeReadonly: boolean
}

export interface ProjectMapEvidenceSeed {
  path?: string
  command?: string
  kind: ProjectMapEvidenceSeedKind
  reason: string
}

export interface ProjectMapWriteBoundary {
  path: string
  kind: ProjectMapWriteBoundaryKind
  scope: ProjectMapWriteBoundaryScope
  origin: ProjectMapWriteBoundaryOrigin
  reason: string
}

export interface ProjectMapVerificationProfile {
  id: string
  appliesTo: ProjectMapVerificationAppliesTo
  commands: string[]
  taskVerifyChecks: Array<Record<string, unknown>>
  artifactPacks: string[]
  requiredBeforeDone: boolean
}

export interface ProjectMapFreshness {
  status: 'fresh' | 'stale' | 'unknown'
  checkedAt: string
  gitHead?: string
  sourceHashes: Record<string, string>
}
