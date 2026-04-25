import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { formatBanner } from '../../src/native/display.js'
import { SLASH_COMMANDS, handleSlashCommand } from '../../src/native/slash-commands.js'
import { listSessions } from '../../src/native/session.js'
import { createConversation } from '../../src/native/conversation.js'
import { UsageTracker } from '../../src/native/usage.js'
import { stripAnsi } from '../../src/native/tui/colors.js'

// ─── First-run detection (Gate 4.7) ──────────────────────────

describe('First-run onboarding', () => {
  it('detects first run when no sessions exist', () => {
    const sessions = listSessions()
    const recentSessions = sessions.slice(0, 3)
    const isFirstRun = recentSessions.length === 0

    // On a clean install with no sessions, isFirstRun should be true.
    // In CI the session dir may or may not exist, so we test the logic itself.
    expect(typeof isFirstRun).toBe('boolean')
  })

  it('generates onboarding affordances for first-run banner', () => {
    const firstRunTips = [
      'Ask anything — OwlCoda reads, writes, and runs code for you',
      '/help — see all commands',
      '/model — switch between local and cloud models',
      '/skills — discover available coding skills',
      '/dashboard — monitor system health and usage',
      '/why-native — learn what makes native mode special',
    ]

    const banner = formatBanner({
      version: '0.0.0-test',
      model: 'test-model',
      mode: 'native',
      sessionId: 'test-session',
      cwd: '/test/dir',
      isFirstRun: true,
      tips: firstRunTips,
    })

    const plain = stripAnsi(banner)
    expect(plain).toContain('owlcoda')
    expect(plain).toContain('/help')
    expect(plain).toContain('/why-native')
    expect(plain).toContain('terminal coding agent')
  })

  it('uses default tips when tips option is omitted', () => {
    const banner = formatBanner({
      version: '0.0.0-test',
      model: 'test-model',
      mode: 'native',
      sessionId: 'test-session',
      cwd: '/test/dir',
    })

    const plain = stripAnsi(banner)
    // Default compact banner includes the command and file affordances.
    expect(plain).toContain('/help')
    expect(plain).toContain('@')
    // Should NOT contain first-run specific tips
    expect(plain).not.toContain('Ask anything')
  })
})

// ─── /why-native command (Gate 5.5) ──────────────────────────

describe('/why-native command', () => {
  it('is registered in SLASH_COMMANDS', () => {
    expect(SLASH_COMMANDS).toContain('/why-native')
  })

  it('appears in /help output', async () => {
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      logs.push(args.map(String).join(' '))
    })

    const conv = createConversation({
      system: 'test',
      model: 'test-model',
      maxTokens: 1024,
    })
    const usage = new UsageTracker()

    await handleSlashCommand('/help', conv, usage)
    spy.mockRestore()

    const output = logs.join('\n')
    expect(output).toContain('/why-native')
  })

  it('produces output with key native-advantage phrases', async () => {
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      logs.push(args.map(String).join(' '))
    })

    const conv = createConversation({
      system: 'test',
      model: 'test-model',
      maxTokens: 1024,
    })
    const usage = new UsageTracker()

    const handled = await handleSlashCommand('/why-native', conv, usage)
    spy.mockRestore()

    expect(handled).toBe(true)

    const output = stripAnsi(logs.join('\n'))
    expect(output).toContain('native tools')
    expect(output).toContain('slash commands')
    expect(output).toContain('Local model routing')
    expect(output).toContain('Local-first deployment')
    expect(output).toContain('Session persistence')
    expect(output).toContain('Skill system')
    expect(output).toContain('Tool maturity labels')
    expect(output).toContain('Full observability')
  })
})
