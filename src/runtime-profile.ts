import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getOwlcodaRuntimeProfileDir } from './paths.js'

export interface PreparedProfile {
  profileDir: string
  apiKey: string
}

function getProfileDirPath(): string {
  return getOwlcodaRuntimeProfileDir()
}

// Matches the normalization used by the compatibility runtime's config key hashing.
function normalizePathForConfigKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/$/, '')
}

// Mark all ancestors of cwd as trusted so computeTrustDialogAccepted() returns true
// regardless of where the user launches owlcoda from.
function buildTrustedProjectPaths(
  cwd: string,
): Record<string, { hasTrustDialogAccepted: boolean }> {
  const paths: Record<string, { hasTrustDialogAccepted: boolean }> = {}
  let current = normalizePathForConfigKey(resolve(cwd))
  const root = normalizePathForConfigKey(resolve('/'))
  while (true) {
    // Skip empty/invalid paths (e.g. above root on some systems)
    if (current.length > 0) {
      paths[current] = { hasTrustDialogAccepted: true }
    }
    if (current === root) break
    const parent = normalizePathForConfigKey(resolve(current, '..'))
    if (parent === current || parent.length === 0) break
    current = parent
  }
  return paths
}

/**
 * Read and parse a JSON config file, returning an empty object on error.
 */
function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * Merge trusted project paths into an existing projects object.
 */
function mergeTrustedProjects(
  existing: Record<string, unknown> | undefined,
  trusted: Record<string, { hasTrustDialogAccepted: boolean }>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(existing ?? {}) }
  for (const [path, config] of Object.entries(trusted)) {
    const existingConfig = (merged[path] as Record<string, unknown>) ?? {}
    merged[path] = { ...existingConfig, ...config }
  }
  return merged
}

/**
 * Prepare an isolated runtime profile for OwlCoda.
 * - Creates ~/.owlcoda/runtime-profile/
 * - Writes the OwlCoda runtime trust config with projects[path].hasTrustDialogAccepted = true
 * - Writes settings.json with customApiKeyResponses.approved
 * - Idempotent: safe to call multiple times
 * - NEVER touches any external user profile
 */
export function prepareLocalFrontdoorProfile(apiKey: string): PreparedProfile {
  const profileDir = getProfileDirPath()
  mkdirSync(profileDir, { recursive: true })

  const cwd = process.cwd()
  const trustedPaths = buildTrustedProjectPaths(cwd)

  // ── runtime trust config: write workspace trust (projects config) ──
  const globalConfigPath = join(profileDir, 'profile.json')
  const globalConfig = readJsonFile(globalConfigPath)
  const existingProjects = (globalConfig['projects'] as Record<string, unknown> | undefined) ?? {}
  globalConfig['projects'] = mergeTrustedProjects(existingProjects, trustedPaths)
  writeFileSync(globalConfigPath, JSON.stringify(globalConfig, null, 2) + '\n', 'utf-8')

  // ── settings.json: write API key approval ────────────────────────────────
  const settingsPath = join(profileDir, 'settings.json')
  const approvalKey = apiKey.slice(-20)
  const settings = readJsonFile(settingsPath)

  const existing = settings['customApiKeyResponses'] as Record<string, unknown> | undefined
  const approved: string[] = Array.isArray(existing?.['approved']) ? (existing['approved'] as string[]) : []
  const rejected: string[] = Array.isArray(existing?.['rejected']) ? (existing['rejected'] as string[]) : []
  if (!approved.includes(approvalKey)) {
    approved.push(approvalKey)
  }
  settings['customApiKeyResponses'] = { approved, rejected }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')

  // settings.local.json: ensure exists for startup
  const localSettingsPath = join(profileDir, 'settings.local.json')
  if (!existsSync(localSettingsPath)) {
    writeFileSync(localSettingsPath, '{}\n', 'utf-8')
  }

  return { profileDir, apiKey }
}

/**
 * Get the profile directory path (for testing/inspection).
 */
export function getProfileDir(): string {
  return getProfileDirPath()
}

/**
 * Prepare profile in a custom directory (for testing).
 */
export function prepareProfileAt(profileDir: string, apiKey: string): PreparedProfile {
  mkdirSync(profileDir, { recursive: true })

  const cwd = process.cwd()
  const trustedPaths = buildTrustedProjectPaths(cwd)

  const globalConfigPath = join(profileDir, 'profile.json')
  const globalConfig = readJsonFile(globalConfigPath)
  const existingProjects = (globalConfig['projects'] as Record<string, unknown> | undefined) ?? {}
  globalConfig['projects'] = mergeTrustedProjects(existingProjects, trustedPaths)
  writeFileSync(globalConfigPath, JSON.stringify(globalConfig, null, 2) + '\n', 'utf-8')

  const settingsPath = join(profileDir, 'settings.json')
  const approvalKey = apiKey.slice(-20)
  const settings = readJsonFile(settingsPath)

  const existing = settings['customApiKeyResponses'] as Record<string, unknown> | undefined
  const approved: string[] = Array.isArray(existing?.['approved']) ? (existing['approved'] as string[]) : []
  const rejected: string[] = Array.isArray(existing?.['rejected']) ? (existing['rejected'] as string[]) : []
  if (!approved.includes(approvalKey)) {
    approved.push(approvalKey)
  }
  settings['customApiKeyResponses'] = { approved, rejected }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')

  const localSettingsPath = join(profileDir, 'settings.local.json')
  if (!existsSync(localSettingsPath)) {
    writeFileSync(localSettingsPath, '{}\n', 'utf-8')
  }

  return { profileDir, apiKey }
}
