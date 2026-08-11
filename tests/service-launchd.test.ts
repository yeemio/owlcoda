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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  renderLaunchAgentPlist,
  launchAgentPath,
  isLaunchdSupported,
  buildLaunchdEnv,
  installLaunchdService,
  uninstallLaunchdService,
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

  it('bounds launchd crash-loop restart frequency', () => {
    expect(plist).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/)
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

describe('launchd side-effect boundary', () => {
  it('writes and reloads only an isolated temp LaunchAgent through an injected launchctl', () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-launchd-fixture-'))
    const fakeBin = join(root, 'bin')
    const fakeLaunchctl = join(fakeBin, 'launchctl')
    const launchctlLog = join(root, 'launchctl.log')
    const previousHome = process.env.HOME
    const previousPath = process.env.PATH
    const previousLog = process.env.OWLCODA_TEST_LAUNCHCTL_LOG
    try {
      mkdirSync(fakeBin)
      writeFileSync(fakeLaunchctl, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$OWLCODA_TEST_LAUNCHCTL_LOG"\nexit 0\n', 'utf8')
      chmodSync(fakeLaunchctl, 0o700)
      process.env.HOME = root
      process.env.PATH = `${fakeBin}:${previousPath ?? ''}`
      process.env.OWLCODA_TEST_LAUNCHCTL_LOG = launchctlLog

      const installed = installLaunchdService({
        programArgs: ['/tmp/node', '/tmp/cli.ts', 'server', '--port', '39191'],
        stdoutPath: join(root, 'daemon.log'),
        stderrPath: join(root, 'daemon.log'),
        envVars: { OWLCODA_HOME: join(root, 'owlcoda'), OWLCODA_LAUNCHD: '1' },
      })
      expect(installed.loaded).toBe(true)
      expect(installed.plistPath).toBe(launchAgentPath(root))
      expect(installed.plistPath).not.toContain('/Users/example/Library/LaunchAgents')
      expect(readFileSync(installed.plistPath, 'utf8')).toMatch(/ThrottleInterval[\s\S]*<integer>10<\/integer>/)
      expect(readFileSync(installed.plistPath, 'utf8')).toContain('<string>39191</string>')

      const removed = uninstallLaunchdService()
      expect(removed.loaded).toBe(false)
      expect(existsSync(installed.plistPath)).toBe(false)
      const calls = readFileSync(launchctlLog, 'utf8').trim().split('\n')
      expect(calls).toHaveLength(3)
      expect(calls[0]).toMatch(/^bootout gui\/\d+\/com\.owlcoda\.daemon$/)
      expect(calls[1]).toMatch(/^bootstrap gui\/\d+ .+com\.owlcoda\.daemon\.plist$/)
      expect(calls[2]).toMatch(/^bootout gui\/\d+\/com\.owlcoda\.daemon$/)
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousLog === undefined) delete process.env.OWLCODA_TEST_LAUNCHCTL_LOG
      else process.env.OWLCODA_TEST_LAUNCHCTL_LOG = previousLog
      rmSync(root, { recursive: true, force: true })
    }
  })
})
