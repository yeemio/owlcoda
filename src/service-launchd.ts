/**
 * Opt-in launchd KeepAlive service for the OwlCoda daemon (macOS only).
 *
 * Installed only by explicit `owlcoda service install`. The default daemon path
 * (spawnDaemon detached child) is unchanged for users who don't opt in. When
 * installed, launchd owns the daemon: it restarts it on crash (KeepAlive)
 * without needing any client open — covering headless callers like the
 * variants-gen script — and routes the daemon's stdout/stderr to
 * ~/.owlcoda/daemon.log natively.
 *
 * Pure helpers (isLaunchdSupported / launchAgentPath / renderLaunchAgentPlist)
 * are unit-tested; the launchctl bootstrap/bootout side effects are manually
 * smoke-verified.
 */
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

export const SERVICE_LABEL = 'com.owlcoda.daemon'

/** launchd is macOS-only. Linux (systemd) / Windows are out of scope this round. */
export function isLaunchdSupported(plat: NodeJS.Platform = process.platform): boolean {
  return plat === 'darwin'
}

/** Per-user LaunchAgent path: ~/Library/LaunchAgents/com.owlcoda.daemon.plist */
export function launchAgentPath(home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
}

/**
 * Build the EnvironmentVariables for the launchd plist. launchd does NOT
 * inherit the shell environment, so capture the user's current OWLCODA_* config
 * (most importantly OWLCODA_HOME — otherwise the daemon writes pid/meta to the
 * wrong config root and clobbers the real daemon's pid file) and force the
 * launchd markers (OWLCODA_LAUNCHD + a stable OWLCODA_RUNTIME_TOKEN).
 */
/**
 * Cloud-credential env vars that config.ts reads directly from the environment
 * (NOT OWLCODA_*-prefixed). These must also cross into the launchd environment,
 * otherwise a launchd-spawned daemon cannot authenticate to the cloud preset
 * (e.g. KIMI_API_KEY at config.ts:186 → 401 on every cloud turn). Keep this in
 * sync with the non-OWLCODA_ credential reads in config.ts.
 */
export const LAUNCHD_FORWARDED_CREDENTIAL_ENV = ['KIMI_API_KEY', 'MOONSHOT_API_KEY'] as const

export function buildLaunchdEnv(env: NodeJS.ProcessEnv, runtimeToken: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('OWLCODA_') && v !== undefined) out[k] = v
  }
  for (const k of LAUNCHD_FORWARDED_CREDENTIAL_ENV) {
    const v = env[k]
    if (v !== undefined) out[k] = v
  }
  out['OWLCODA_LAUNCHD'] = '1'
  out['OWLCODA_RUNTIME_TOKEN'] = runtimeToken
  return out
}

export interface LaunchAgentSpec {
  label?: string
  programArgs: string[]
  stdoutPath: string
  stderrPath: string
  workingDir?: string
  envVars?: Record<string, string>
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function renderLaunchAgentPlist(spec: LaunchAgentSpec): string {
  const label = spec.label ?? SERVICE_LABEL
  const argLines = spec.programArgs.map(a => `    <string>${xmlEscape(a)}</string>`).join('\n')
  const envEntries = spec.envVars ? Object.entries(spec.envVars) : []
  const envBlock = envEntries.length
    ? '  <key>EnvironmentVariables</key>\n  <dict>\n' +
      envEntries.map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`).join('\n') +
      '\n  </dict>\n'
    : ''
  const workingDirBlock = spec.workingDir
    ? `  <key>WorkingDirectory</key>\n  <string>${xmlEscape(spec.workingDir)}</string>\n`
    : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argLines}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(spec.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(spec.stderrPath)}</string>
${workingDirBlock}${envBlock}</dict>
</plist>
`
}

function currentUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : 0
}

export interface InstallServiceOptions {
  programArgs: string[]
  stdoutPath: string
  stderrPath: string
  envVars?: Record<string, string>
}

export interface ServiceActionResult {
  plistPath: string
  loaded: boolean
  note?: string
}

/** Write the plist and (re)load it via launchctl. Throws on non-darwin. */
export function installLaunchdService(opts: InstallServiceOptions): ServiceActionResult {
  if (!isLaunchdSupported()) {
    throw new Error(`launchd service is unsupported on ${process.platform} — macOS only`)
  }
  const plistPath = launchAgentPath()
  mkdirSync(dirname(plistPath), { recursive: true })
  writeFileSync(plistPath, renderLaunchAgentPlist({
    programArgs: opts.programArgs,
    stdoutPath: opts.stdoutPath,
    stderrPath: opts.stderrPath,
    envVars: opts.envVars,
  }), 'utf-8')

  const uid = currentUid()
  // Clean reload: bootout any prior instance (ignore if absent), then bootstrap.
  try { execFileSync('launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`], { stdio: 'ignore' }) } catch { /* not loaded yet */ }
  let loaded = false
  let note: string | undefined
  try {
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'pipe' })
    loaded = true
  } catch {
    try {
      execFileSync('launchctl', ['load', '-w', plistPath], { stdio: 'pipe' })
      loaded = true
      note = 'loaded via legacy `launchctl load -w`'
    } catch (err) {
      note = `plist written but launchctl load failed: ${(err as Error).message}`
    }
  }
  return { plistPath, loaded, note }
}

/** Bootout the service and remove the plist. Throws on non-darwin. */
export function uninstallLaunchdService(): ServiceActionResult {
  if (!isLaunchdSupported()) {
    throw new Error(`launchd service is unsupported on ${process.platform} — macOS only`)
  }
  const plistPath = launchAgentPath()
  const uid = currentUid()
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`], { stdio: 'ignore' })
  } catch {
    try { execFileSync('launchctl', ['unload', '-w', plistPath], { stdio: 'ignore' }) } catch { /* not loaded */ }
  }
  let removed = false
  try { if (existsSync(plistPath)) { unlinkSync(plistPath); removed = true } } catch { /* ok */ }
  return { plistPath, loaded: false, note: removed ? 'plist removed' : 'plist not present' }
}

/** Kick the daemon to restart under launchd (used by version-drift restart in W4). */
export function kickstartLaunchdService(): void {
  if (!isLaunchdSupported()) return
  const uid = currentUid()
  execFileSync('launchctl', ['kickstart', '-k', `gui/${uid}/${SERVICE_LABEL}`], { stdio: 'ignore' })
}

export interface LaunchdServiceStatus {
  supported: boolean
  installed: boolean
  plistPath: string
  launchctl?: string
}

/** Best-effort status: plist presence + `launchctl print` summary if loaded. */
export function getLaunchdServiceStatus(): LaunchdServiceStatus {
  const plistPath = launchAgentPath()
  const supported = isLaunchdSupported()
  const installed = existsSync(plistPath)
  let launchctl: string | undefined
  if (supported && installed) {
    try {
      launchctl = execFileSync('launchctl', ['print', `gui/${currentUid()}/${SERVICE_LABEL}`], { stdio: 'pipe' }).toString()
    } catch {
      launchctl = undefined
    }
  }
  return { supported, installed, plistPath, launchctl }
}

/** True when the plist exists (proxy for "launchd owns the daemon"). */
export function isLaunchdServiceInstalled(): boolean {
  return isLaunchdSupported() && existsSync(launchAgentPath())
}
