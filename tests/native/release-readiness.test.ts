import { describe, expect, it } from 'vitest'

import { buildReleaseDecisionPacket } from '../../src/native/release-decision-packet.js'
import { buildReleaseReadinessSnapshot } from '../../src/native/release-readiness.js'

describe('release readiness snapshot', () => {
  it('combines npm, public source, and website gates into one execution snapshot', () => {
    const decisionPacket = buildReleaseDecisionPacket({
      packageName: 'owlcoda',
      localVersion: '0.15.10',
      gitHead: 'abc123',
      gitDirty: false,
      npmLatestVersion: '0.15.9',
      npmDistTags: { latest: '0.15.9' },
      prepublishGatePassed: true,
    })

    const snapshot = buildReleaseReadinessSnapshot({
      decisionPacket,
      surfaceReadiness: {
        publicSource: {
          status: 'ready',
          reasons: [],
          nextCommand: 'no public source sync required for npm-only package candidate',
        },
        website: {
          status: 'ready',
          reasons: [],
          nextCommand: 'run site build, then deploy website surface separately',
        },
      },
    })

    expect(snapshot.overallStatus).toBe('ready_to_execute')
    expect(snapshot.releaseActions).toEqual([
      { surface: 'npm', command: 'npm publish' },
      { surface: 'publicSource', command: 'no public source sync required for npm-only package candidate' },
      { surface: 'website', command: 'run site build, then deploy website surface separately' },
    ])
    expect(snapshot.surfaces.npm.status).toBe('ready')
    expect(snapshot.surfaces.publicSource.status).toBe('ready')
    expect(snapshot.surfaces.website.status).toBe('ready')
  })

  it('blocks execution when npm is ready but website readiness is blocked', () => {
    const decisionPacket = buildReleaseDecisionPacket({
      packageName: 'owlcoda',
      localVersion: '0.15.10',
      gitHead: 'abc123',
      gitDirty: false,
      npmLatestVersion: '0.15.9',
      npmDistTags: { latest: '0.15.9' },
      prepublishGatePassed: true,
    })

    const snapshot = buildReleaseReadinessSnapshot({
      decisionPacket,
      surfaceReadiness: {
        publicSource: { status: 'ready', reasons: [], nextCommand: 'ok' },
        website: {
          status: 'blocked',
          reasons: ['website_changelog_contains_private_traces'],
          nextCommand: 'fix website',
        },
      },
    })

    expect(snapshot.overallStatus).toBe('blocked')
    expect(snapshot.blockers).toContain('website:website_changelog_contains_private_traces')
    expect(snapshot.releaseActions).toEqual([])
  })
})
