export type ReleaseSurfaceStatus = 'ready' | 'blocked' | 'manual'

export interface ReleaseDecisionInput {
  packageName: string
  localVersion: string
  gitHead: string
  gitDirty: boolean
  npmLatestVersion?: string | null
  npmDistTags?: Record<string, string>
  prepublishGatePassed: boolean
}

export interface ReleaseSurfaceDecision {
  status: ReleaseSurfaceStatus
  reasons: string[]
  nextCommand: string
}

export interface ReleaseDecisionPacket {
  packageName: string
  localVersion: string
  gitHead: string
  gitDirty: boolean
  npmLatestVersion: string | null
  npmDistTags: Record<string, string>
  surfaces: {
    npm: ReleaseSurfaceDecision
    publicSource: ReleaseSurfaceDecision
    website: ReleaseSurfaceDecision
  }
}

export function buildReleaseDecisionPacket(input: ReleaseDecisionInput): ReleaseDecisionPacket {
  const npmReasons: string[] = []
  const npmLatestVersion = input.npmLatestVersion ?? null
  const npmDistTags = input.npmDistTags ?? {}

  if (input.gitDirty) {
    npmReasons.push('git_worktree_dirty')
  }
  if (!input.prepublishGatePassed) {
    npmReasons.push('prepublish_gate_not_verified')
  }
  if (npmLatestVersion && compareVersions(input.localVersion, npmLatestVersion) <= 0) {
    npmReasons.push('local_version_not_newer_than_npm_latest')
  }

  const npmStatus: ReleaseSurfaceStatus = npmReasons.length === 0 ? 'ready' : 'blocked'

  return {
    packageName: input.packageName,
    localVersion: input.localVersion,
    gitHead: input.gitHead,
    gitDirty: input.gitDirty,
    npmLatestVersion,
    npmDistTags,
    surfaces: {
      npm: {
        status: npmStatus,
        reasons: npmReasons,
        nextCommand: npmStatus === 'ready'
          ? 'npm publish'
          : 'fix npm surface blockers before npm publish',
      },
      publicSource: {
        status: 'manual',
        reasons: ['public_source_surface_must_be_verified_separately'],
        nextCommand: `npm run release:surface-readiness; if source sync is required, verify public source mirror, then push matching tag v${input.localVersion}`,
      },
      website: {
        status: 'manual',
        reasons: ['website_surface_must_be_verified_separately'],
        nextCommand: 'npm run release:surface-readiness; then run and verify the site deploy flow separately',
      },
    },
  }
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av > bv) return 1
    if (av < bv) return -1
  }
  return 0
}

function parseVersion(version: string): number[] {
  return version
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => Number.isFinite(part) ? part : 0)
}
