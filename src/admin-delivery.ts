import { spawn } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OwlCodaConfig } from './config.js'

const ADMIN_ONE_SHOT_PREFIX = 'ots1'
const ADMIN_TOKEN_MAX_FUTURE_SKEW_MS = 60_000

export interface AdminBundleStatus {
  bundleDir: string
  indexPath: string
  available: boolean
}

export interface OneShotTokenOptions {
  now?: () => number
  nonce?: string
}

export interface VerifyOneShotTokenOptions {
  now?: () => number
  maxAgeMs?: number
}

export type AdminHandoffRoute = 'models' | 'aliases' | 'orphans' | 'catalog'

export interface AdminHandoffContext {
  route?: AdminHandoffRoute
  select?: string
  view?: string
}

/**
 * Resolve the admin bundle directory.
 *
 * The bundle lives inside the installed package, NOT in the user's cwd.
 * We resolve relative to this compiled module's location:
 *
 *   - runtime (installed):  .../owlcoda/dist/admin-delivery.js  → ../dist/admin  → .../owlcoda/dist/admin
 *   - dev (tsx):            .../owlcoda/src/admin-delivery.ts   → ../dist/admin  → .../owlcoda/dist/admin
 *
 * Tests may pass an explicit `projectRoot` to override for hermetic fixtures.
 */
export function getAdminBundleDir(projectRoot?: string): string {
  if (projectRoot) return join(projectRoot, 'dist', 'admin')
  const here = dirname(fileURLToPath(import.meta.url))
  // `here` is either `<pkg>/dist` or `<pkg>/src` — both resolve to `<pkg>/dist/admin`
  // via `../dist/admin`.
  return resolve(here, '..', 'dist', 'admin')
}

export function getAdminBundleStatus(projectRoot?: string): AdminBundleStatus {
  const bundleDir = getAdminBundleDir(projectRoot)
  const indexPath = join(bundleDir, 'index.html')
  return {
    bundleDir,
    indexPath,
    available: existsSync(indexPath),
  }
}

export function getAdminBearerToken(config: Pick<OwlCodaConfig, 'adminToken' | 'port'>): string {
  return config.adminToken ?? `owlcoda-local-key-${config.port}`
}

export function createOneShotAdminToken(secret: string, options: OneShotTokenOptions = {}): string {
  const issuedAt = String((options.now ?? Date.now)())
  const nonce = options.nonce ?? randomBytes(8).toString('hex')
  const payload = `${issuedAt}.${nonce}`
  const signature = createHmac('sha256', secret).update(payload).digest('hex')
  return `${ADMIN_ONE_SHOT_PREFIX}.${issuedAt}.${nonce}.${signature}`
}

export function verifyOneShotAdminToken(
  secret: string,
  token: string,
  options: VerifyOneShotTokenOptions = {},
): boolean {
  const parts = token.split('.')
  if (parts.length !== 4 || parts[0] !== ADMIN_ONE_SHOT_PREFIX) return false
  const [, issuedAtRaw, nonce, providedSignature] = parts
  const issuedAt = Number(issuedAtRaw)
  if (!Number.isFinite(issuedAt) || !nonce || !providedSignature) return false

  const now = (options.now ?? Date.now)()
  const maxAgeMs = options.maxAgeMs ?? 300_000
  if (issuedAt > now + ADMIN_TOKEN_MAX_FUTURE_SKEW_MS) return false
  if (now - issuedAt > maxAgeMs) return false

  const payload = `${issuedAtRaw}.${nonce}`
  const expectedSignature = createHmac('sha256', secret).update(payload).digest('hex')
  const expectedBuffer = Buffer.from(expectedSignature, 'utf-8')
  const providedBuffer = Buffer.from(providedSignature, 'utf-8')
  if (expectedBuffer.length !== providedBuffer.length) return false
  return timingSafeEqual(expectedBuffer, providedBuffer)
}

export function buildAdminHandoffHash(context: AdminHandoffContext = {}): string {
  const route = context.route ?? 'models'
  const params = new URLSearchParams()
  if (context.select) params.set('select', context.select)
  if (context.view) params.set('view', context.view)
  const query = params.toString()
  return `#/${route}${query ? `?${query}` : ''}`
}

export function buildAdminHandoffUrl(baseUrl: string, token: string, context: AdminHandoffContext = {}): string {
  return buildAdminUrl(baseUrl, token, buildAdminHandoffHash(context))
}

export function buildAdminUrl(baseUrl: string, token: string, hash: string = ''): string {
  const url = new URL('/admin/', baseUrl)
  url.searchParams.set('token', token)
  url.hash = hash
  return url.toString()
}

export function adminHandoffFailureHint(): string {
  return 'If the browser says the handoff token expired or auth failed, rerun the handoff to mint a fresh admin URL.'
}

function envFlagEnabled(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

export function shouldAutoOpenAdminBrowser(explicit?: boolean): boolean {
  if (typeof explicit === 'boolean') return explicit
  return envFlagEnabled(process.env['OWLCODA_ADMIN_AUTO_OPEN'])
}

export function adminAutoOpenDisabledHint(): string {
  return 'Browser auto-open is disabled by default. Open the URL manually, pass --open-browser, or set OWLCODA_ADMIN_AUTO_OPEN=1.'
}

export function openUrlInBrowser(url: string): boolean {
  const command = process.platform === 'darwin'
    ? ['open', url]
    : process.platform === 'win32'
      ? ['cmd', '/c', 'start', '', url]
      : ['xdg-open', url]

  try {
    const child = spawn(command[0]!, command.slice(1), {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    return true
  } catch {
    return false
  }
}
