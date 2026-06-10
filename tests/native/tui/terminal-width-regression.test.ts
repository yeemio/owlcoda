import { describe, expect, it } from 'vitest'
import { renderWelcome } from '../../../src/native/tui/welcome.js'
import { renderSessionsPanel, renderSettingsPanel } from '../../../src/native/tui/panel.js'
import { renderToolRow } from '../../../src/native/tui/tool-row.js'
import { renderBanner } from '../../../src/native/tui/banner.js'
import { renderComposerRail } from '../../../src/native/tui/message.js'
import { stripAnsi, visibleWidth } from '../../../src/native/tui/colors.js'

function expectWithinColumns(text: string, columns: number): void {
  for (const line of text.split('\n')) {
    expect(visibleWidth(stripAnsi(line))).toBeLessThanOrEqual(columns)
  }
}

describe('terminal width regression surfaces', () => {
  for (const columns of [80, 100, 120]) {
    it(`keeps core surfaces within ${columns} columns`, () => {
      expectWithinColumns(renderWelcome({
        version: '0.12.30',
        model: 'minimax-m27',
        mode: 'native',
        sessionId: 'conv-test',
        cwd: '/Users/test/project/with/a/long/path',
        columns,
        recentSessions: [
          { id: 'conv-1234567890', title: 'A long CJK session 标题 should stay on one visible line', turns: 42, date: '4/24/2026' },
        ],
      }), columns)

      expectWithinColumns(renderSessionsPanel([
        {
          id: 'conv-1234567890',
          title: 'A long session title that should not wrap across the panel row',
          turns: [{}, {}],
          createdAt: '2026-04-24T00:00:00.000Z',
          updatedAt: '2026-04-24T01:00:00.000Z',
        },
      ], { columns }), columns)

      expectWithinColumns(renderSettingsPanel({
        version: '0.12.30',
        model: 'minimax-m27',
        maxTokens: 4096,
        mode: 'native',
        trace: false,
        owlcodaHome: '/Users/test/.owlcoda',
        apiBaseUrl: 'http://127.0.0.1:9999',
        approveMode: 'ask-before-execute',
        theme: 'dark',
        alwaysApprovedTools: ['bash', 'edit', 'write'],
        columns,
      }), columns)

      expectWithinColumns(renderToolRow({
        verb: 'bash',
        arg: 'pnpm vitest run tests/native/tui/terminal-width-regression.test.ts',
        state: 'run',
        columns,
      }), columns)

      expectWithinColumns(renderBanner({
        kind: 'warn',
        title: 'Rate limit',
        body: 'Retrying after a short delay with a compact status banner',
        columns,
      }), columns)

      expectWithinColumns(renderComposerRail({
        model: 'minimax-m27',
        mode: 'auto',
        contextTokens: 1200,
        contextMax: 32768,
        columns,
      }), columns)
    })
  }
})
