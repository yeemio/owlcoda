import type { ReleaseDecisionPacket, ReleaseSurfaceDecision } from './release-decision-packet.js'
import type { ReleaseSurfaceReadiness } from './release-surface-readiness.js'

export type ReleaseReadinessOverallStatus = 'ready_to_execute' | 'blocked'

export interface ReleaseAction {
  surface: 'npm' | 'publicSource' | 'website'
  command: string
}

export interface ReleaseReadinessSnapshotInput {
  decisionPacket: ReleaseDecisionPacket
  surfaceReadiness: {
    publicSource: ReleaseSurfaceReadiness
    website: ReleaseSurfaceReadiness
  }
}

export interface ReleaseReadinessSnapshot {
  packageName: string
  localVersion: string
  gitHead: string
  gitDirty: boolean
  npmLatestVersion: string | null
  overallStatus: ReleaseReadinessOverallStatus
  blockers: string[]
  releaseActions: ReleaseAction[]
  surfaces: {
    npm: ReleaseSurfaceDecision
    publicSource: ReleaseSurfaceReadiness
    website: ReleaseSurfaceReadiness
  }
}

export function buildReleaseReadinessSnapshot(input: ReleaseReadinessSnapshotInput): ReleaseReadinessSnapshot {
  const npm = input.decisionPacket.surfaces.npm
  const publicSource = input.surfaceReadiness.publicSource
  const website = input.surfaceReadiness.website
  const blockers = [
    ...surfaceBlockers('npm', npm),
    ...surfaceBlockers('publicSource', publicSource),
    ...surfaceBlockers('website', website),
  ]
  const overallStatus: ReleaseReadinessOverallStatus = blockers.length === 0 ? 'ready_to_execute' : 'blocked'

  return {
    packageName: input.decisionPacket.packageName,
    localVersion: input.decisionPacket.localVersion,
    gitHead: input.decisionPacket.gitHead,
    gitDirty: input.decisionPacket.gitDirty,
    npmLatestVersion: input.decisionPacket.npmLatestVersion,
    overallStatus,
    blockers,
    releaseActions: overallStatus === 'ready_to_execute'
      ? [
          { surface: 'npm', command: npm.nextCommand },
          { surface: 'publicSource', command: publicSource.nextCommand },
          { surface: 'website', command: website.nextCommand },
        ]
      : [],
    surfaces: {
      npm,
      publicSource,
      website,
    },
  }
}

function surfaceBlockers(surface: 'npm' | 'publicSource' | 'website', decision: { status: string; reasons: string[] }): string[] {
  if (decision.status === 'ready') return []
  if (decision.reasons.length === 0) return [`${surface}:not_ready`]
  return decision.reasons.map((reason) => `${surface}:${reason}`)
}
