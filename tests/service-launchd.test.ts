/**
 * Tests for the opt-in launchd KeepAlive service (P2-a, macOS).
 *
 * The launchd service is the chosen runtime self-heal mechanism: it restarts
 * the daemon on crash without depending on a REPL client being open, so
 * headless callers (the variants-gen script) are covered. Installed only by
 * explicit `owlcoda service install` — default behavior is unchanged.
 *
 * These cover the pure pieces (support gate, plist path, plist rendering).
 * The launchctl bootstrap/bootout side effects are manually smoke-verified.
 */
import { describe, it, expect } from 'vitest'
import {
  renderLaunchAgentPlist,
  launchAgentPath,
  isLaunchdSupported,
  buildLaunchdEnv,
  SERVICE_LABEL,
} from '../src/service-launchd.js'

describe('isLaunchdSupported', () => {
  it('is true on darwin and false elsewhere', () => {
    expect(isLaunchdSupported('darwin')).toBe(true)
    expect(isLaunchdSupported('linux')).toBe(false)
    expect(isLaunchdSupported('win32')).toBe(false)
  })
})

describe('launchAgentPath', () => {
  it('resolves under ~/Library/LaunchAgents with the service label', () => {
    expect(launchAgentPath('/Users/bob')).toBe(
      `/Users/bob/Library/LaunchAgents/${SERVICE_LABEL}.plist`,
    )
  })
})

describe('renderLaunchAgentPlist', () => {
  const plist = renderLaunchAgentPlist({
    programArgs: ['/opt/owlcoda', '/opt/cli.js', 'server', '--port', '8019'],
    stdoutPath: '/home/.owlcoda/daemon.log',
    stderrPath: '/home/.owlcoda/daemon.log',
  })

  it('is a valid plist labelled for the daemon', () => {
    expect(plist).toContain('<?xml')
    expect(plist).toContain('<!DOCTYPE plist')
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`)
  })

  it('lists every program argument', () => {
    expect(plist).toContain('<string>/opt/owlcoda</string>')
    expect(plist).toContain('<string>server</string>')
    expect(plist).toContain('<string>--port</string>')
    expect(plist).toContain('<string>8019</string>')
  })

  it('sets KeepAlive + RunAtLoad so the daemon auto-restarts on crash', () => {
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
  })

  it('routes stdout+stderr to the daemon log (launchd-native forensics)', () => {
    expect(plist).toMatch(
      /<key>StandardOutPath<\/key>\s*<string>\/home\/\.owlcoda\/daemon\.log<\/string>/,
    )
    expect(plist).toMatch(
      /<key>StandardErrorPath<\/key>\s*<string>\/home\/\.owlcoda\/daemon\.log<\/string>/,
    )
  })

  it('escapes XML metacharacters in arguments', () => {
    const p = renderLaunchAgentPlist({
      programArgs: ['a&b<c>'],
      stdoutPath: '/x',
      stderrPath: '/x',
    })
    expect(p).toContain('a&amp;b&lt;c&gt;')
    expect(p).not.toContain('<string>a&b<c></string>')
  })

  it('emits an EnvironmentVariables dict when env vars are given', () => {
    const p = renderLaunchAgentPlist({
      programArgs: ['/opt/owlcoda'],
      stdoutPath: '/x',
      stderrPath: '/x',
      envVars: { OWLCODA_LAUNCHD: '1' },
    })
    expect(p).toContain('<key>EnvironmentVariables</key>')
    expect(p).toContain('<key>OWLCODA_LAUNCHD</key>')
    expect(p).toContain('<string>1</string>')
  })
})

describe('buildLaunchdEnv', () => {
  it('captures OWLCODA_* env (launchd does not inherit the shell) and sets the markers', () => {
    // Without this, a launchd daemon ignores the user's OWLCODA_HOME and writes
    // pid/meta to the wrong config root — clobbering the real daemon's pid file.
    const e = buildLaunchdEnv(
      { OWLCODA_HOME: '/custom/home', OWLCODA_MODES: '0', PATH: '/bin', HOME: '/h' },
      'tok-1',
    )
    expect(e).toEqual({
      OWLCODA_HOME: '/custom/home',
      OWLCODA_MODES: '0',
      OWLCODA_LAUNCHD: '1',
      OWLCODA_RUNTIME_TOKEN: 'tok-1',
    })
  })

  it('forces the launchd markers even if stale ones are present in env', () => {
    const e = buildLaunchdEnv({ OWLCODA_LAUNCHD: '0', OWLCODA_RUNTIME_TOKEN: 'stale' }, 'fresh')
    expect(e.OWLCODA_LAUNCHD).toBe('1')
    expect(e.OWLCODA_RUNTIME_TOKEN).toBe('fresh')
  })

  it('forwards cloud credential env vars config reads from env (KIMI/MOONSHOT)', () => {
    // config.ts:186 resolves the Kimi/Moonshot cloud preset key from
    // KIMI_API_KEY/MOONSHOT_API_KEY (NOT OWLCODA_*-prefixed). launchd does not
    // inherit the shell, so dropping these leaves a launchd-spawned daemon
    // unable to authenticate to Kimi → 401 on every cloud turn.
    const e = buildLaunchdEnv(
      { OWLCODA_HOME: '/h', KIMI_API_KEY: 'sk-kimi', MOONSHOT_API_KEY: 'sk-moon' },
      'tok',
    )
    expect(e.KIMI_API_KEY).toBe('sk-kimi')
    expect(e.MOONSHOT_API_KEY).toBe('sk-moon')
    expect(e.OWLCODA_HOME).toBe('/h')
  })

  it('does not forward unrelated non-OWLCODA env (no broad leak)', () => {
    const e = buildLaunchdEnv({ PATH: '/bin', HOME: '/h', AWS_SECRET_ACCESS_KEY: 'x' }, 'tok')
    expect(e.PATH).toBeUndefined()
    expect(e.HOME).toBeUndefined()
    expect(e.AWS_SECRET_ACCESS_KEY).toBeUndefined()
  })
})
