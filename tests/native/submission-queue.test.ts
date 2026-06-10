/**
 * SubmissionQueue unit tests.
 *
 * Locked contract:
 *   - FIFO order
 *   - cap MAX_QUEUE_SIZE; over → drop oldest + signal overflow
 *   - consumeOverflowFlag is one-shot
 *   - clear() drops everything + resets overflow
 *   - snapshot() returns a defensive copy
 */
import { describe, it, expect } from 'vitest'
import {
  SubmissionQueue,
  MAX_QUEUE_SIZE,
  type QueuedSubmission,
} from '../../src/native/submission-queue.js'

function mk(text: string, origin: QueuedSubmission['origin'] = 'user'): QueuedSubmission {
  return { kind: 'user_turn', text, submittedAt: Date.now(), origin }
}

describe('SubmissionQueue — empty state', () => {
  it('starts empty', () => {
    const q = new SubmissionQueue()
    expect(q.size).toBe(0)
    expect(q.isEmpty).toBe(true)
    expect(q.peek()).toBeUndefined()
    expect(q.dequeue()).toBeUndefined()
  })

  it('consumeOverflowFlag is false on fresh queue', () => {
    const q = new SubmissionQueue()
    expect(q.consumeOverflowFlag()).toBe(false)
  })
})

describe('SubmissionQueue — FIFO enqueue/dequeue', () => {
  it('returns true on clean enqueue (under cap)', () => {
    const q = new SubmissionQueue()
    expect(q.enqueue(mk('a'))).toBe(true)
    expect(q.enqueue(mk('b'))).toBe(true)
  })

  it('dequeue returns items in insertion order', () => {
    const q = new SubmissionQueue()
    q.enqueue(mk('a'))
    q.enqueue(mk('b'))
    q.enqueue(mk('c'))
    expect(q.dequeue()?.text).toBe('a')
    expect(q.dequeue()?.text).toBe('b')
    expect(q.dequeue()?.text).toBe('c')
    expect(q.dequeue()).toBeUndefined()
  })

  it('size tracks correctly across enqueue / dequeue', () => {
    const q = new SubmissionQueue()
    expect(q.size).toBe(0)
    q.enqueue(mk('x'))
    expect(q.size).toBe(1)
    q.enqueue(mk('y'))
    expect(q.size).toBe(2)
    q.dequeue()
    expect(q.size).toBe(1)
    q.dequeue()
    expect(q.size).toBe(0)
    expect(q.isEmpty).toBe(true)
  })

  it('peek returns head without consuming', () => {
    const q = new SubmissionQueue()
    q.enqueue(mk('a'))
    q.enqueue(mk('b'))
    expect(q.peek()?.text).toBe('a')
    expect(q.peek()?.text).toBe('a')
    expect(q.size).toBe(2)
  })
})

describe('SubmissionQueue — ring-buffer overflow', () => {
  it(`drops oldest when adding beyond MAX_QUEUE_SIZE (${MAX_QUEUE_SIZE})`, () => {
    const q = new SubmissionQueue()
    for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
      expect(q.enqueue(mk(`item-${i}`))).toBe(true)
    }
    expect(q.size).toBe(MAX_QUEUE_SIZE)
    // The (MAX+1)-th enqueue returns false (overflow signal).
    expect(q.enqueue(mk('overflow'))).toBe(false)
    expect(q.size).toBe(MAX_QUEUE_SIZE)
    // The OLDEST item was dropped.
    expect(q.dequeue()?.text).toBe('item-1')
  })

  it('consumeOverflowFlag is sticky until consumed (one-shot)', () => {
    const q = new SubmissionQueue()
    for (let i = 0; i < MAX_QUEUE_SIZE + 1; i++) q.enqueue(mk(`item-${i}`))
    // First call returns true (and resets internal flag).
    expect(q.consumeOverflowFlag()).toBe(true)
    // Subsequent calls return false until another overflow.
    expect(q.consumeOverflowFlag()).toBe(false)
    expect(q.consumeOverflowFlag()).toBe(false)
  })

  it('overflow flag re-arms on each new overflow', () => {
    const q = new SubmissionQueue()
    for (let i = 0; i < MAX_QUEUE_SIZE + 1; i++) q.enqueue(mk(`item-${i}`))
    expect(q.consumeOverflowFlag()).toBe(true)
    // Trigger another overflow.
    q.enqueue(mk('more-overflow'))
    expect(q.consumeOverflowFlag()).toBe(true)
  })
})

describe('SubmissionQueue — clear', () => {
  it('drops all items', () => {
    const q = new SubmissionQueue()
    q.enqueue(mk('a'))
    q.enqueue(mk('b'))
    q.clear()
    expect(q.size).toBe(0)
    expect(q.isEmpty).toBe(true)
    expect(q.dequeue()).toBeUndefined()
  })

  it('resets overflow flag', () => {
    const q = new SubmissionQueue()
    for (let i = 0; i < MAX_QUEUE_SIZE + 1; i++) q.enqueue(mk(`item-${i}`))
    q.clear()
    expect(q.consumeOverflowFlag()).toBe(false)
  })
})

describe('SubmissionQueue — snapshot', () => {
  it('returns array with current items in order', () => {
    const q = new SubmissionQueue()
    q.enqueue(mk('a'))
    q.enqueue(mk('b'))
    q.enqueue(mk('c'))
    const snap = q.snapshot()
    expect(snap.map(s => s.text)).toEqual(['a', 'b', 'c'])
  })

  it('snapshot is a defensive copy (mutations do not leak into the queue)', () => {
    const q = new SubmissionQueue()
    q.enqueue(mk('a'))
    const snap = q.snapshot() as QueuedSubmission[]
    expect(() => { snap.push(mk('hijack')) }).not.toThrow()
    expect(q.size).toBe(1)
    expect(q.peek()?.text).toBe('a')
  })
})

describe('SubmissionQueue — origin discriminator', () => {
  it('preserves the user vs auto_drain distinction round-trip', () => {
    const q = new SubmissionQueue()
    q.enqueue(mk('user-input', 'user'))
    q.enqueue(mk('auto-restart', 'auto_drain'))
    expect(q.dequeue()?.origin).toBe('user')
    expect(q.dequeue()?.origin).toBe('auto_drain')
  })
})
