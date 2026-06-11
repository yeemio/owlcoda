import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { recoverGuardRejectedSubmission } from '../../src/native/repl-shared.js'
import { SubmissionQueue, MAX_QUEUE_SIZE } from '../../src/native/submission-queue.js'

const item = (text: string) => ({
  kind: 'user_turn' as const,
  text,
  submittedAt: 1,
  origin: 'user' as const,
})

// A submission that loses the SubmissionGuard race used to be silently
// swallowed: runConversationTurn early-returned before its setInputValue(''),
// so the typed characters sat in the composer with zero feedback (fresh
// submit), or the drained queue item vanished entirely (drain path). The
// recovery contract: the message goes (back) into the queue — never lost —
// and the caller gets a footer notice to show.
describe('recoverGuardRejectedSubmission', () => {
  it('enqueues the rejected submission and returns a pending notice', () => {
    const q = new SubmissionQueue()
    const notice = recoverGuardRejectedSubmission(q, item('hello'))
    expect(q.size).toBe(1)
    expect(q.peek()?.text).toBe('hello')
    expect(notice).toMatch(/queued/i)
    expect(notice).toContain('1 pending')
  })

  it('keeps FIFO order behind already-queued items', () => {
    const q = new SubmissionQueue()
    q.enqueue(item('first'))
    recoverGuardRejectedSubmission(q, item('second'))
    expect(q.dequeue()?.text).toBe('first')
    expect(q.dequeue()?.text).toBe('second')
  })

  it('reports the overflow drop when the queue is full', () => {
    const q = new SubmissionQueue()
    for (let i = 0; i < MAX_QUEUE_SIZE; i++) q.enqueue(item(`m${i}`))
    const notice = recoverGuardRejectedSubmission(q, item('newest'))
    expect(q.size).toBe(MAX_QUEUE_SIZE)
    expect(notice).toMatch(/full|dropped/i)
  })
})

// Regression lock on the ink-repl wiring (the component itself has no unit
// harness): runConversationTurn must REPORT a guard rejection — `return false`,
// not a bare silent `return` — and both user-facing call sites (fresh submit
// tail + queued drain) must route the rejected message through
// recoverGuardRejectedSubmission. If this test fails after a refactor, verify
// the rejected-submission recovery still exists before updating the patterns.
describe('ink-repl guard-rejection wiring (source lock)', () => {
  const src = readFileSync(join(__dirname, '../../src/native/ink-repl.tsx'), 'utf8')

  it('guard rejection returns false instead of a silent bare return', () => {
    const guardBranch = src.match(/tryStart\(\)\s*\n\s*if \(turnGen === null\) \{[\s\S]{0,800}?\n    \}/)?.[0] ?? ''
    expect(guardBranch).toContain('return false')
  })

  it('both user-facing call sites recover the rejected submission', () => {
    const calls = src.match(/recoverGuardRejectedSubmission\(/g) ?? []
    // 2 call sites (handleSubmit tail, drain re-enqueue); import has no paren
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })
})
