/**
 * SubmissionGuard unit tests.
 *
 * Covers all 5 legal transitions, generation increment contract, and the
 * cancel+resubmit race pattern (forceEnd → stale end(gen) returns false).
 */
import { describe, it, expect } from 'vitest'
import { SubmissionGuard } from '../../src/native/submission-guard.js'

describe('SubmissionGuard — initial state', () => {
  it('starts idle with generation 0', () => {
    const g = new SubmissionGuard()
    expect(g.status).toBe('idle')
    expect(g.generation).toBe(0)
    expect(g.isActive).toBe(false)
  })
})

describe('SubmissionGuard — transitions', () => {
  it('reserve(): idle → dispatching', () => {
    const g = new SubmissionGuard()
    expect(g.reserve()).toBe(true)
    expect(g.status).toBe('dispatching')
    expect(g.isActive).toBe(true)
  })

  it('reserve() while dispatching returns false (no reentrant reserve)', () => {
    const g = new SubmissionGuard()
    g.reserve()
    expect(g.reserve()).toBe(false)
    expect(g.status).toBe('dispatching')
  })

  it('reserve() while running returns false', () => {
    const g = new SubmissionGuard()
    g.tryStart()
    expect(g.reserve()).toBe(false)
    expect(g.status).toBe('running')
  })

  it('cancelReservation(): dispatching → idle', () => {
    const g = new SubmissionGuard()
    g.reserve()
    g.cancelReservation()
    expect(g.status).toBe('idle')
    expect(g.isActive).toBe(false)
  })

  it('cancelReservation() is a no-op when idle', () => {
    const g = new SubmissionGuard()
    g.cancelReservation()
    expect(g.status).toBe('idle')
  })

  it('cancelReservation() is a no-op when running (does NOT tear down active turn)', () => {
    const g = new SubmissionGuard()
    g.tryStart()
    g.cancelReservation()
    expect(g.status).toBe('running')
  })

  it('tryStart(): idle → running directly (user-submit shortcut)', () => {
    const g = new SubmissionGuard()
    const gen = g.tryStart()
    expect(gen).toBe(1)
    expect(g.status).toBe('running')
    expect(g.isActive).toBe(true)
  })

  it('tryStart(): dispatching → running (queue-processor path)', () => {
    const g = new SubmissionGuard()
    g.reserve()
    const gen = g.tryStart()
    expect(gen).toBe(1)
    expect(g.status).toBe('running')
  })

  it('tryStart() while running returns null (concurrent guard)', () => {
    const g = new SubmissionGuard()
    g.tryStart()
    expect(g.tryStart()).toBe(null)
    expect(g.status).toBe('running')
  })

  it('end(gen): running → idle when generation matches', () => {
    const g = new SubmissionGuard()
    const gen = g.tryStart()!
    expect(g.end(gen)).toBe(true)
    expect(g.status).toBe('idle')
    expect(g.isActive).toBe(false)
  })

  it('end(gen) returns false when generation does not match (stale finally)', () => {
    const g = new SubmissionGuard()
    const stale = g.tryStart()!
    g.forceEnd()
    g.tryStart() // new turn
    // now an old finally calls end(stale) — should be rejected
    expect(g.end(stale)).toBe(false)
    // current turn still owns the slot
    expect(g.status).toBe('running')
  })

  it('end() is no-op when not running', () => {
    const g = new SubmissionGuard()
    expect(g.end(0)).toBe(false)
    expect(g.end(99)).toBe(false)
    g.reserve()
    expect(g.end(0)).toBe(false)
    expect(g.status).toBe('dispatching')
  })

  it('forceEnd(): running → idle, bumps generation', () => {
    const g = new SubmissionGuard()
    g.tryStart()
    expect(g.generation).toBe(1)
    g.forceEnd()
    expect(g.status).toBe('idle')
    expect(g.generation).toBe(2) // bumped so stale finally sees mismatch
  })

  it('forceEnd(): dispatching → idle, bumps generation', () => {
    const g = new SubmissionGuard()
    g.reserve()
    g.forceEnd()
    expect(g.status).toBe('idle')
    expect(g.generation).toBe(1)
  })

  it('forceEnd() is no-op when already idle', () => {
    const g = new SubmissionGuard()
    g.forceEnd()
    expect(g.status).toBe('idle')
    expect(g.generation).toBe(0)
  })
})

describe('SubmissionGuard — generation counter contract', () => {
  it('every successful tryStart() increments generation', () => {
    const g = new SubmissionGuard()
    const a = g.tryStart()!
    g.end(a)
    const b = g.tryStart()!
    g.end(b)
    const c = g.tryStart()!
    expect(a).toBe(1)
    expect(b).toBe(2)
    expect(c).toBe(3)
  })

  it('failed tryStart() does NOT increment generation', () => {
    const g = new SubmissionGuard()
    g.tryStart()
    const before = g.generation
    expect(g.tryStart()).toBe(null)
    expect(g.generation).toBe(before)
  })

  it('end() with successful match does not increment generation', () => {
    const g = new SubmissionGuard()
    const gen = g.tryStart()!
    expect(g.generation).toBe(1)
    g.end(gen)
    expect(g.generation).toBe(1)
  })

  it('end() with stale generation does not increment generation', () => {
    const g = new SubmissionGuard()
    const stale = g.tryStart()!
    g.forceEnd()
    g.tryStart() // gen 3
    const before = g.generation
    g.end(stale)
    expect(g.generation).toBe(before)
  })
})

describe('SubmissionGuard — race patterns', () => {
  it('cancel+resubmit: stale finally from cancelled turn does NOT tear down new turn', () => {
    const g = new SubmissionGuard()

    // Turn A starts
    const genA = g.tryStart()!
    expect(genA).toBe(1)
    expect(g.isActive).toBe(true)

    // User Ctrl+C → forceEnd
    g.forceEnd()
    expect(g.isActive).toBe(false)
    expect(g.generation).toBe(2)

    // User submits turn B
    const genB = g.tryStart()!
    expect(genB).toBe(3)
    expect(g.isActive).toBe(true)

    // Turn A's finally finally fires (was awaiting tool, abort propagated)
    // It calls end(genA)
    const aCleanupOk = g.end(genA)
    expect(aCleanupOk).toBe(false) // skip A's cleanup
    // Turn B is still running
    expect(g.status).toBe('running')
    expect(g.generation).toBe(3)

    // Turn B's finally fires normally
    expect(g.end(genB)).toBe(true)
    expect(g.status).toBe('idle')
  })

  it('concurrent submit: second tryStart returns null without side effects', () => {
    const g = new SubmissionGuard()

    // User submit A wins
    const winner = g.tryStart()!
    expect(winner).toBe(1)

    // Auto-retry timer fires concurrently → its tryStart returns null
    expect(g.tryStart()).toBe(null)
    // Guard unchanged
    expect(g.status).toBe('running')
    expect(g.generation).toBe(1) // not bumped

    // Winner's finally cleans up normally
    expect(g.end(winner)).toBe(true)
  })

  it('queue processor pattern: reserve → tryStart → end', () => {
    const g = new SubmissionGuard()

    // Queue processor sees idle, reserves the slot
    expect(g.reserve()).toBe(true)
    expect(g.status).toBe('dispatching')

    // Other components see isActive=true and skip their work
    expect(g.isActive).toBe(true)

    // Async chain eventually calls tryStart inside onQuery
    const gen = g.tryStart()!
    expect(gen).toBe(1)
    expect(g.status).toBe('running')

    // onQuery's finally
    expect(g.end(gen)).toBe(true)
    expect(g.status).toBe('idle')
  })

  it('queue processor cancel path: reserve → cancelReservation when peek returned nothing', () => {
    const g = new SubmissionGuard()
    g.reserve()
    g.cancelReservation()
    expect(g.status).toBe('idle')
    // Next attempt works
    expect(g.tryStart()).toBe(1)
  })

  it('forceEnd during dispatching: timer cancelled before tryStart', () => {
    const g = new SubmissionGuard()
    g.reserve()
    g.forceEnd() // user pressed /clear during the dispatching window
    expect(g.status).toBe('idle')
    expect(g.generation).toBe(1)
  })
})

describe('SubmissionGuard — reset helper', () => {
  it('reset() returns to initial state', () => {
    const g = new SubmissionGuard()
    g.tryStart()
    g.tryStart() // no-op, returns null
    expect(g.generation).toBe(1)
    g.reset()
    expect(g.status).toBe('idle')
    expect(g.generation).toBe(0)
  })
})
