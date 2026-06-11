import { describe, expect, it } from 'vitest'
import { classifyTurnDifficulty } from '../src/difficulty-router.js'

function body(text: string) {
  return { messages: [{ role: 'user', content: text }] } as never
}

// The confirmation signal must fire only on a PURE confirmation. A turn that
// merely STARTS with a confirmation word but then carries a correction or a new
// instruction ("no, fix it properly") is exactly the kind of turn that needs the
// stronger model — it must not be routed down as simple.
describe('classifyTurnDifficulty — confirmation must be pure', () => {
  it('keeps a bare confirmation simple', () => {
    expect(classifyTurnDifficulty(body('yes')).difficulty).toBe('simple')
    expect(classifyTurnDifficulty(body('ok.')).difficulty).toBe('simple')
    expect(classifyTurnDifficulty(body('go ahead')).difficulty).toBe('simple')
    expect(classifyTurnDifficulty(body('lgtm')).difficulty).toBe('simple')
    expect(classifyTurnDifficulty(body('sounds good!')).difficulty).toBe('simple')
  })

  it('does not call a correction that merely starts with a confirmation word simple', () => {
    expect(classifyTurnDifficulty(body('no, fix it properly')).difficulty).toBe('moderate')
    expect(classifyTurnDifficulty(body('okay so the real problem is the race in the daemon, dig in')).difficulty).toBe('moderate')
  })
})
