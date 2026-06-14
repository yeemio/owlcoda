import { describe, expect, it } from 'vitest'
import { nextDailyFireDelayMs } from '../server/review/scheduler.js'

describe('nextDailyFireDelayMs (target HH:MM at tz offset minutes)', () => {
  // BJT(+480). 目标 10:00 BJT = 02:00 UTC.
  it('fires later today when target is ahead', () => {
    const now = new Date('2026-06-14T00:00:00Z') // 08:00 BJT
    expect(nextDailyFireDelayMs(now, '10:00', 480)).toBe(2 * 60 * 60 * 1000) // 2h to 10:00 BJT
  })
  it('rolls to tomorrow when target already passed', () => {
    const now = new Date('2026-06-14T05:00:00Z') // 13:00 BJT, 已过 10:00
    expect(nextDailyFireDelayMs(now, '10:00', 480)).toBe(21 * 60 * 60 * 1000) // 到次日 10:00 BJT
  })
  it('always returns a positive delay', () => {
    const now = new Date('2026-06-14T02:00:00Z') // 恰好 10:00 BJT
    expect(nextDailyFireDelayMs(now, '10:00', 480)).toBe(24 * 60 * 60 * 1000)
  })
})
