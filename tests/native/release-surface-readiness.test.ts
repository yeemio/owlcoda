import { describe, expect, it } from 'vitest'

import {
  evaluatePublicSourceSurface,
  evaluateWebsiteSurface,
} from '../../src/native/release-surface-readiness.js'

describe('release surface readiness', () => {
  it('blocks website readiness when public website copy is behind the package candidate', () => {
    const surface = evaluateWebsiteSurface({
      packageVersion: '0.15.10',
      publicVersion: 'v0.15.7',
      changelog: '## [0.15.7] - older release\n',
      enReleaseText: 'owlcoda 0.15.7 - older release',
      zhReleaseText: 'owlcoda 0.15.7 - 旧版本',
      installCommand: 'npm install -g owlcoda@latest',
    })

    expect(surface.status).toBe('blocked')
    expect(surface.reasons).toContain('website_public_version_mismatch')
    expect(surface.reasons).toContain('website_changelog_missing_candidate_version')
    expect(surface.reasons).toContain('website_release_card_missing_candidate_version')
  })

  it('blocks website readiness when the changelog contains private engineering traces', () => {
    const surface = evaluateWebsiteSurface({
      packageVersion: '0.15.10',
      publicVersion: 'v0.15.10',
      changelog: '## [0.15.10]\nCompared with legacy internal build upstream at /Users/publicuser/private\n',
      enReleaseText: 'owlcoda 0.15.10 - release',
      zhReleaseText: 'owlcoda 0.15.10 - 发布',
      installCommand: 'npm install -g owlcoda@latest',
    })

    expect(surface.status).toBe('blocked')
    expect(surface.reasons).toContain('website_changelog_contains_private_traces')
  })

  it('does not force the public router source line to match an npm-only package candidate', () => {
    const surface = evaluatePublicSourceSurface({
      packageVersion: '0.15.10',
      publicPackageVersion: '0.15.9',
      publicGitDirty: false,
      publicHasPrivateOnlyDirs: false,
      npmOnlyTrial: true,
    })

    expect(surface.status).toBe('ready')
    expect(surface.reasons).toEqual([])
    expect(surface.nextCommand).toContain('no public source sync required')
  })
})
