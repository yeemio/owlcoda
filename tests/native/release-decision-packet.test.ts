import { describe, expect, it } from 'vitest'

import { buildReleaseDecisionPacket } from '../../src/native/release-decision-packet.js'

describe('release decision packet', () => {
  it('blocks npm publish when local package version is not newer than npm latest', () => {
    const packet = buildReleaseDecisionPacket({
      packageName: 'owlcoda',
      localVersion: '0.15.8',
      gitHead: 'abc123',
      gitDirty: false,
      npmLatestVersion: '0.15.9',
      npmDistTags: { latest: '0.15.9' },
      prepublishGatePassed: true,
    })

    expect(packet.surfaces.npm.status).toBe('blocked')
    expect(packet.surfaces.npm.reasons).toContain('local_version_not_newer_than_npm_latest')
    expect(packet.surfaces.publicSource.status).toBe('manual')
    expect(packet.surfaces.website.status).toBe('manual')
  })

  it('keeps npm publish, public source, and website as independently verifiable surfaces', () => {
    const packet = buildReleaseDecisionPacket({
      packageName: 'owlcoda',
      localVersion: '0.16.0',
      gitHead: 'def456',
      gitDirty: false,
      npmLatestVersion: '0.15.9',
      npmDistTags: { latest: '0.15.9' },
      prepublishGatePassed: true,
    })

    expect(Object.keys(packet.surfaces)).toEqual(['npm', 'publicSource', 'website'])
    expect(packet.surfaces.npm.status).toBe('ready')
    expect(packet.surfaces.publicSource.nextCommand).toContain('release:surface-readiness')
    expect(packet.surfaces.publicSource.nextCommand).toContain('v0.16.0')
    expect(packet.surfaces.website.nextCommand).toContain('release:surface-readiness')
    expect(packet.surfaces.website.nextCommand).toContain('site deploy')
  })
})
