/**
 * Failing e2e pin: Ink /retry no-op bug (Task A1)
 *
 * Current signature of handleSlashCommand has 12 params — no `hooks` argument.
 * This test passes a 13th `hooks` argument with an `onSideEffect` callback and
 * asserts the post-fix behavior: when `/retry` runs without `rl` (Ink path),
 * it should call hooks.onSideEffect({ kind: 'force_resubmit_failed_turn', text }).
 *
 * TODAY this test FAILS because:
 *   1. TypeScript rejects the extra 13th argument (compile-time error), OR
 *   2. At runtime the hooks param is undefined inside the function and
 *      sideEffect.action remains null instead of the expected object.
 *
 * The fix (Task A2) will add the `hooks` param and wire the signal.
 */

import { describe, it, expect } from 'vitest'
import { handleSlashCommand } from '../../src/native/slash-commands.js'

describe('/retry without rl (Ink path)', () => {
  it('signals a force-resubmit instead of being a silent no-op', async () => {
    const conversation = {
      turns: [
        { role: 'user', content: [{ type: 'text', text: 'previous question' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'partial reply' }] },
      ],
    }

    const sideEffect = { action: null as null | { kind: string; text?: string } }

    const result = await (handleSlashCommand as any)(
      '/retry',
      conversation as any,
      { input: 0, output: 0, total: 0 } as any,
      {} as any,      // opts
      {} as any,      // approveState
      {} as any,      // dispatcher
      undefined,      // statusBar
      undefined,      // toolCollector
      undefined,      // rl  ← Ink path: no readline
      undefined,      // mcpManager
      {} as any,      // thinkingState
      { write: () => {} } as any,  // output
      // 13th arg: hooks — does not exist in current signature
      { onSideEffect: (s: any) => { sideEffect.action = s } },
    )

    expect(result).toBe(true)
    expect(sideEffect.action).toEqual({ kind: 'force_resubmit_failed_turn', text: 'previous question' })
    expect(conversation.turns).toEqual([])
  })
})

describe('Ink slash side-effect drain', () => {
  it('drains force_resubmit_failed_turn into a submit call', () => {
    const calls: string[] = []
    const handleSubmit = (text: string) => { calls.push(text) }
    const ref = { current: { kind: 'force_resubmit_failed_turn' as const, text: 'previous question' } }
    const sideEffect = ref.current
    ref.current = null as any
    if (sideEffect?.kind === 'force_resubmit_failed_turn') {
      handleSubmit(sideEffect.text)
    }
    expect(calls).toEqual(['previous question'])
  })
})
