export type ReleaseSurfaceReadinessStatus = 'ready' | 'blocked'

export interface ReleaseSurfaceReadiness {
  status: ReleaseSurfaceReadinessStatus
  reasons: string[]
  nextCommand: string
}

export interface WebsiteSurfaceInput {
  packageVersion: string
  publicVersion: string
  changelog: string
  enReleaseText: string
  zhReleaseText: string
  installCommand: string
}

export interface PublicSourceSurfaceInput {
  packageVersion: string
  publicPackageVersion: string | null
  publicGitDirty: boolean
  publicHasPrivateOnlyDirs: boolean
  npmOnlyTrial: boolean
}

export function evaluateWebsiteSurface(input: WebsiteSurfaceInput): ReleaseSurfaceReadiness {
  const reasons: string[] = []
  const expectedPublicVersion = `v${input.packageVersion}`

  if (input.publicVersion !== expectedPublicVersion) {
    reasons.push('website_public_version_mismatch')
  }
  if (!input.changelog.includes(`## [${input.packageVersion}]`)) {
    reasons.push('website_changelog_missing_candidate_version')
  }
  if (!input.enReleaseText.includes(input.packageVersion) || !input.zhReleaseText.includes(input.packageVersion)) {
    reasons.push('website_release_card_missing_candidate_version')
  }
  if (input.installCommand.trim() !== 'npm install -g owlcoda@latest') {
    reasons.push('website_install_command_not_npm_latest')
  }
  if (containsPrivateWebsiteTrace(input.changelog)) {
    reasons.push('website_changelog_contains_private_traces')
  }

  return {
    status: reasons.length === 0 ? 'ready' : 'blocked',
    reasons,
    nextCommand: reasons.length === 0
      ? 'run site build, then deploy website surface separately'
      : 'fix website version, changelog, and release-card blockers',
  }
}

function containsPrivateWebsiteTrace(content: string): boolean {
  const lower = content.toLowerCase()
  if (/\/Users\/(?!you\b|user\b|username\b|test\b|example\b|publicuser\b)[A-Za-z0-9._-]+/.test(content)) {
    return true
  }
  return lower.includes('legacy-internal-build')
    || lower.includes('legacy internal build')
    || lower.includes(['claude', 'code'].join(' '))
    || lower.includes('private development workspace')
    || lower.includes('private development workspace')
    || lower.includes('router rather than')
    || lower.includes('preview phase')
}

export function evaluatePublicSourceSurface(input: PublicSourceSurfaceInput): ReleaseSurfaceReadiness {
  const reasons: string[] = []

  if (input.publicGitDirty) {
    reasons.push('public_source_git_dirty')
  }
  if (input.publicHasPrivateOnlyDirs) {
    reasons.push('public_source_contains_private_only_dirs')
  }
  if (!input.npmOnlyTrial && input.publicPackageVersion !== input.packageVersion) {
    reasons.push('public_source_version_mismatch')
  }

  return {
    status: reasons.length === 0 ? 'ready' : 'blocked',
    reasons,
    nextCommand: reasons.length === 0
      ? npmOnlyPublicSourceCommand(input)
      : 'fix public source surface blockers before tag or mirror sync',
  }
}

function npmOnlyPublicSourceCommand(input: PublicSourceSurfaceInput): string {
  if (input.npmOnlyTrial && input.publicPackageVersion !== input.packageVersion) {
    return 'no public source sync required for npm-only package candidate; verify public router separately if requested'
  }
  return `verify public source mirror, then push matching tag v${input.packageVersion}`
}
