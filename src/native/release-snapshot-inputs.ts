import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ReleaseDecisionInput } from './release-decision-packet.js'
import type { PublicSourceSurfaceInput, WebsiteSurfaceInput } from './release-surface-readiness.js'

interface PackageJson {
  name?: string
  version?: string
}

export interface ReleaseSnapshotInputs {
  packageName: string
  localVersion: string
  decisionInput: ReleaseDecisionInput
  websiteInput: WebsiteSurfaceInput
  publicSourceInput: PublicSourceSurfaceInput
  publicRepo: string
}

export function runReleaseCommand(command: string, args: string[], cwd = process.cwd()): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function readReleaseSnapshotInputs(options?: {
  prepublishGatePassed?: boolean
  publicRepo?: string
}): ReleaseSnapshotInputs {
  const pkg = readPackageJson()
  const npmTruth = readNpmTruth(pkg.name)
  const publicRepo = options?.publicRepo ?? process.env.OWLCODA_PUBLIC_REPO ?? '/Users/you/gitrep/owlcoda'

  return {
    packageName: pkg.name,
    localVersion: pkg.version,
    publicRepo,
    decisionInput: {
      packageName: pkg.name,
      localVersion: pkg.version,
      gitHead: runReleaseCommand('git', ['rev-parse', 'HEAD']),
      gitDirty: runReleaseCommand('git', ['status', '--short']).length > 0,
      npmLatestVersion: npmTruth.latestVersion,
      npmDistTags: npmTruth.distTags,
      prepublishGatePassed: options?.prepublishGatePassed ?? false,
    },
    websiteInput: readWebsiteInput(pkg.version),
    publicSourceInput: {
      packageVersion: pkg.version,
      publicPackageVersion: readPublicPackageVersion(publicRepo),
      publicGitDirty: readPublicGitDirty(publicRepo),
      publicHasPrivateOnlyDirs: hasPrivateOnlyDirs(publicRepo),
      npmOnlyTrial: true,
    },
  }
}

function readPackageJson(): Required<Pick<PackageJson, 'name' | 'version'>> {
  const parsed = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as PackageJson
  return {
    name: String(parsed.name ?? ''),
    version: String(parsed.version ?? ''),
  }
}

function readNpmTruth(packageName: string): { latestVersion: string | null; distTags: Record<string, string> } {
  try {
    const parsed = JSON.parse(runReleaseCommand('npm', ['view', packageName, 'version', 'dist-tags', '--json', '--prefer-online'])) as {
      version?: string
      'dist-tags'?: Record<string, string>
    }
    return {
      latestVersion: parsed.version ?? parsed['dist-tags']?.['latest'] ?? null,
      distTags: parsed['dist-tags'] ?? {},
    }
  } catch {
    return { latestVersion: null, distTags: {} }
  }
}

function readWebsiteInput(packageVersion: string): WebsiteSurfaceInput {
  const siteRoot = join(process.cwd(), 'site')
  const enI18n = readFileSync(join(siteRoot, 'src/i18n/en.ts'), 'utf8')
  const zhI18n = readFileSync(join(siteRoot, 'src/i18n/zh.ts'), 'utf8')
  return {
    packageVersion,
    publicVersion: extractConst(readFileSync(join(siteRoot, 'src/lib/version.ts'), 'utf8'), 'PUBLIC_VERSION'),
    changelog: readFileSync(join(siteRoot, 'src/content/_changelog.md'), 'utf8'),
    enReleaseText: extractReleaseBlock(enI18n),
    zhReleaseText: extractReleaseBlock(zhI18n),
    installCommand: 'npm install -g owlcoda@latest',
  }
}

function extractConst(content: string, name: string): string {
  const match = content.match(new RegExp(`export const ${name} = ['"]([^'"]+)['"]`))
  return match?.[1] ?? ''
}

function extractReleaseBlock(content: string): string {
  const match = content.match(/release:\s*\{([\s\S]*?)\n\s*\},\n\s*stepsCaption:/)
  return match?.[1] ?? ''
}

function readPublicPackageVersion(publicRepo: string): string | null {
  const packageJsonPath = join(publicRepo, 'package.json')
  if (!existsSync(packageJsonPath)) return null
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageJson
  return typeof parsed.version === 'string' ? parsed.version : null
}

function readPublicGitDirty(publicRepo: string): boolean {
  if (!existsSync(publicRepo)) return true
  return runReleaseCommand('git', ['status', '--short'], publicRepo).length > 0
}

function hasPrivateOnlyDirs(publicRepo: string): boolean {
  return existsSync(join(publicRepo, 'site')) || existsSync(join(publicRepo, 'internal'))
}
