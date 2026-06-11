import { describe, expect, it } from 'vitest'
import { shouldHeadlessExitNonZero } from '../../src/native/headless.js'

// A hard_stop (context overflow refused-to-send, or a synthesis packet over
// budget) means the turn did not complete — headless must exit non-zero, not
// report a silent exit-0 success with stale text.
describe('shouldHeadlessExitNonZero', () => {
  it('exits non-zero on hard_stop', () => {
    expect(shouldHeadlessExitNonZero('hard_stop', undefined, '')).toBe(true)
  })

  it('exits non-zero on task_no_progress / max_iterations / stalled', () => {
    expect(shouldHeadlessExitNonZero('max_iterations', undefined, '')).toBe(true)
    expect(shouldHeadlessExitNonZero('stalled', undefined, '')).toBe(true)
  })

  it('exits zero on a normal end_turn with content', () => {
    expect(shouldHeadlessExitNonZero('end_turn', undefined, 'done')).toBe(false)
  })

  it('keeps narration_loop with text as a zero exit', () => {
    expect(shouldHeadlessExitNonZero('narration_loop', undefined, 'text')).toBe(false)
  })
})
