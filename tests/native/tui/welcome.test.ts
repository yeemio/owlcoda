import { describe, it, expect } from 'vitest'
import { formatWelcomeMarker, getWelcomeTitleIconPlacement, renderWelcome, supportsTerminalImages } from '../../../src/native/tui/welcome.js'
import { stripAnsi, visibleWidth } from '../../../src/native/tui/colors.js'

function untrack(text: string): string {
  return stripAnsi(text).replace(/\u2009/g, '')
}

describe('renderWelcome', () => {
  const baseOpts = {
    version: '0.5.0',
    model: 'TestModel-7B',
    mode: 'native',
    sessionId: 'sess-test-123',
    cwd: '/Users/test/project',
    columns: 100,
  }

  it('includes version', () => {
    const result = renderWelcome(baseOpts)
    expect(result).toContain('0.5.0')
  })

  it('uses branded title text instead of owl emoji', () => {
    const result = stripAnsi(renderWelcome(baseOpts))
    expect(result).toContain('owlcoda v0.5.0')
    expect(result).not.toContain('🦉')
  })

  it('keeps model name out of the pure welcome mark', () => {
    const result = renderWelcome(baseOpts)
    expect(result).not.toContain('TestModel-7B')
  })

  it('keeps working directory out of the pure welcome mark', () => {
    const result = renderWelcome(baseOpts)
    expect(result).not.toContain('/Users/test/project')
  })

  it('includes the startup ASCII owl mark from the design', () => {
    const result = renderWelcome(baseOpts)
    expect(stripAnsi(result)).toContain('owlcoda v0.5.0')
    expect(stripAnsi(result)).toContain('⢦⣤⣀⣠⣤⣤⣤⣀')
    expect(stripAnsi(result)).toContain('⣿⣷')
  })

  it('does not render a large boxed splash screen', () => {
    const result = renderWelcome(baseOpts)
    expect(result).not.toContain('╭')
    expect(result).not.toContain('╰')
  })

  it('does not add generic welcome copy to the design mark', () => {
    const result = renderWelcome(baseOpts)
    expect(stripAnsi(result)).not.toContain('Welcome')
  })

  it('keeps recent sessions out of the first-screen welcome surface', () => {
    const result = renderWelcome({
      ...baseOpts,
      recentSessions: [
        { id: 'abc-12345678', title: 'Fix login', turns: 5, date: '2024-01-01' },
      ],
    })
    expect(result).not.toContain('Recent activity')
    expect(result).not.toContain('Fix login')
  })

  it('does not render an empty recent activity block', () => {
    const result = renderWelcome(baseOpts)
    expect(result).not.toContain('No recent activity')
  })

  it('renders compact layout for narrow terminals', () => {
    const result = renderWelcome({ ...baseOpts, columns: 50 })
    expect(result).not.toContain('╭')
    expect(stripAnsi(result)).toContain('owlcoda')
  })

  it('keeps custom tips out of the pure welcome mark', () => {
    const result = renderWelcome({
      ...baseOpts,
      tips: ['Custom tip 1', 'Custom tip 2'],
    })
    expect(result).not.toContain('Custom tip 1')
    expect(result).not.toContain('Custom tip 2')
  })

  it('keeps username out of the pure welcome mark', () => {
    const result = renderWelcome({ ...baseOpts, username: 'Alice' })
    expect(stripAnsi(result)).not.toContain('Alice')
  })

  it('does not render default tips inside the pure welcome mark', () => {
    const result = renderWelcome({ ...baseOpts })
    expect(stripAnsi(result)).not.toContain('/init')
  })

  it('mentions Shift+Enter in default tips', () => {
    const result = renderWelcome({ ...baseOpts })
    expect(stripAnsi(result)).toContain('Shift+Enter')
  })

  it('shows compact hotkey guidance instead of a tips header', () => {
    const result = renderWelcome({ ...baseOpts })
    expect(stripAnsi(result)).toContain('/help')
    expect(stripAnsi(result)).not.toContain('Tips for getting started')
  })

  it('does not crowd the mark with home-directory warnings', () => {
    const home = process.env['HOME'] || '/Users/test'
    const result = renderWelcome({ ...baseOpts, cwd: home })
    expect(stripAnsi(result)).not.toContain('home directory')
  })

  it('left-aligns the welcome block like the design transcript', () => {
    const result = renderWelcome({ ...baseOpts, columns: 140 })
    const firstNonEmpty = result.split('\n').find(line => line.trim().length > 0) ?? ''
    expect(firstNonEmpty.startsWith(' ')).toBe(false)
  })

  it('keeps optional logo frame inputs on the static startup ASCII mark', () => {
    const left = stripAnsi(renderWelcome({ ...baseOpts, logoFrame: 'dot-left' }))
    const leftMid = stripAnsi(renderWelcome({ ...baseOpts, logoFrame: 'dot-left-mid' }))
    const mid = stripAnsi(renderWelcome({ ...baseOpts, logoFrame: 'dot-mid' }))
    const rightMid = stripAnsi(renderWelcome({ ...baseOpts, logoFrame: 'dot-right-mid' }))
    const right = stripAnsi(renderWelcome({ ...baseOpts, logoFrame: 'dot-right' }))
    expect(left).toContain('⢸⣿⡁')
    expect(leftMid).toBe(left)
    expect(mid).toBe(left)
    expect(rightMid).toBe(left)
    expect(right).toBe(left)
  })

  it('computes title icon placement for kitty-like terminals', () => {
    expect(supportsTerminalImages({ TERM_PROGRAM: 'ghostty' } as NodeJS.ProcessEnv)).toBe(true)
    const placement = getWelcomeTitleIconPlacement({ ...baseOpts })
    expect(placement.cols).toBe(2)
    expect(placement.rows).toBe(1)
    expect(placement.colOffset).toBe(0)
  })

  it('does not overflow line width when metadata contains CJK text', () => {
    const result = renderWelcome({
      ...baseOpts,
      model: 'qwen2.5-coder:32b',
      recentSessions: [
        { id: 'conv-17712345', title: '2. B 体', turns: 227, date: '4/15/2026' },
      ],
    })

    for (const line of result.split('\n')) {
      expect(visibleWidth(stripAnsi(line))).toBeLessThanOrEqual(100)
    }
  })
})

describe('formatWelcomeMarker', () => {
  it('matches the design marker shape with cwd, branch, and clean state', () => {
    const marker = stripAnsi(formatWelcomeMarker({
      cwd: '/Users/test/code/owlcoda',
      branch: 'main',
      pendingChanges: 0,
    }))
    expect(untrack(marker)).toBe('—  CWD /USERS/TEST/CODE/OWLCODA · BRANCH MAIN · NO PENDING CHANGES')
  })

  it('shortens the home directory and shows pending change count', () => {
    const originalHome = process.env['HOME']
    process.env['HOME'] = '/Users/test'
    try {
      const marker = stripAnsi(formatWelcomeMarker({
        cwd: '/Users/test/code/owlcoda',
        branch: 'feature/ui',
        pendingChanges: 2,
      }))
      expect(untrack(marker)).toBe('—  CWD ~/CODE/OWLCODA · BRANCH FEATURE/UI · 2 PENDING CHANGES')
    } finally {
      if (originalHome === undefined) {
        delete process.env['HOME']
      } else {
        process.env['HOME'] = originalHome
      }
    }
  })
})
