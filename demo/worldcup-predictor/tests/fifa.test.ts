import { describe, expect, it } from 'vitest'
import { firstLastNumbers, parseKeyStatistics, parsePhasesOfPlay } from '../server/review/fifa.js'

// 真实 pdftotext -f 3 -l 3 -layout 输出(PMSR-M01 MEX V RSA.pdf)
const P3 = `                                   11 June 2026 - Mexico City Stadium - 13:00
Match Summary - Key Statistics
   Mexico                                  2                             0                    South Africa
                                                 Possession
      Total                57.1%                                         6.8%         36.1%          Total
         2                                               Goals                                          0
        1.78                                      xG (Expected Goals)                                   0.1
       16 (4)                                Attempts at Goal (On Target)                              3 (2)
      547 (495)                                 Total Passes (Complete)                              351 (290)
       90 %                                       Pass Completion %                                    83 %
        105                                     Completed Line Breaks                                   57
         10                                      Defensive Line Breaks                                  3
         117                                  Receptions in the Final Third                             36
         13                                             Crosses                                         8
         23                                        Ball Progressions                                    8
      170 (26)                       Defensive Pressures Applied (Direct Pressures)                  306 (45)
         31                                        Forced Turnovers                                     32
         56                                          Second Balls                                       45
      107.3 km                                  Total Distance Covered                               97.1 km
       5.3 km                          Zone 4 – Low Speed Sprinting: 20-25 km/h                       5.1 km`

describe('firstLastNumbers (ignores label-embedded digits)', () => {
  it('grabs first and last numeric expressions, with paren/unit', () => {
    expect(firstLastNumbers('       16 (4)        Attempts at Goal (On Target)        3 (2)')).toEqual({ first: { value: 16, paren: 4 }, last: { value: 3, paren: 2 } })
    expect(firstLastNumbers('      107.3 km    Total Distance Covered    97.1 km')).toEqual({ first: { value: 107.3, paren: null }, last: { value: 97.1, paren: null } })
    expect(firstLastNumbers('       5.3 km    Zone 4 – Low Speed Sprinting: 20-25 km/h    5.1 km')).toEqual({ first: { value: 5.3, paren: null }, last: { value: 5.1, paren: null } })
  })
})

describe('parseKeyStatistics (real p3 fixture)', () => {
  const { home, away, contested } = parseKeyStatistics(P3)
  it('possession with contested middle value', () => {
    expect(home.possession_pct).toBeCloseTo(57.1, 5)
    expect(away.possession_pct).toBeCloseTo(36.1, 5)
    expect(contested).toBeCloseTo(6.8, 5)
  })
  it('goals / xg', () => {
    expect(home.goals).toBe(2); expect(away.goals).toBe(0)
    expect(home.xg).toBeCloseTo(1.78, 5); expect(away.xg).toBeCloseTo(0.1, 5)
  })
  it('paired metrics split primary + parenthetical', () => {
    expect(home.attempts).toBe(16); expect(home.attempts_on_target).toBe(4)
    expect(away.attempts).toBe(3); expect(away.attempts_on_target).toBe(2)
    expect(home.passes).toBe(547); expect(home.passes_complete).toBe(495)
    expect(home.defensive_pressures).toBe(170); expect(home.direct_pressures).toBe(26)
    expect(away.direct_pressures).toBe(45)
  })
  it('percent + integer + km metrics', () => {
    expect(home.pass_completion_pct).toBe(90); expect(away.pass_completion_pct).toBe(83)
    expect(home.completed_line_breaks).toBe(105); expect(away.completed_line_breaks).toBe(57)
    expect(home.receptions_final_third).toBe(117)
    expect(home.total_distance_km).toBeCloseTo(107.3, 5); expect(away.total_distance_km).toBeCloseTo(97.1, 5)
    expect(home.low_speed_sprint_km).toBeCloseTo(5.3, 5); expect(away.low_speed_sprint_km).toBeCloseTo(5.1, 5)
  })
})

// 真实 pdftotext -f 4 -l 4 -layout 输出(PMSR-M01 MEX V RSA.pdf)
const P4 = `      Mexico                                                     Phases of Play                                                        South Africa
                                                                     IN POSSESSION
47%                                                                     Build Up Unopposed                                                            43%
                           13%                                           Build Up Opposed                                       13%
                     16%                                                    Progression                                          14%
                                 11%                                         Final Third                            7%
                                                      3%                     Long Ball                          6%
                                  10%                                   Attacking Transition                                   12%
                                                           1%             Counter Attack                 2%
                                                 5%                          Set Piece                         5%
                                                                 OUT OF POSSESSION
                                       9%                                   High Press                          6%
                                                      3%                     Mid Press                    3%
                                                           0%                Low Press               1%
                                            7%                              High Block                         5%
               25%                                                           Mid Block                                                       30%
                             11%                                             Low Block                                           14%
                                                 5%                          Recovery                    2%
                           12%                                          Defensive Transition                             10%
                                       8%                                 Counter-press                             7%`

describe('parseKeyStatistics – Goals/xG ordering robustness', () => {
  it('Goals spec does not capture the xG row even if xG appears first', () => {
    const reordered = `   Mexico                 2            0      South Africa
                                Possession
      Total      57.1%                 6.8%    36.1%     Total
        1.78               xG (Expected Goals)            0.1
         2                       Goals                     0`
    const r = parseKeyStatistics(reordered)
    expect(r.home.goals).toBe(2); expect(r.away.goals).toBe(0)
    expect(r.home.xg).toBeCloseTo(1.78, 5); expect(r.away.xg).toBeCloseTo(0.1, 5)
  })
})

describe('parsePhasesOfPlay (real p4 fixture)', () => {
  const { home, away } = parsePhasesOfPlay(P4)
  it('in-possession phases', () => {
    expect(home.in_possession.build_up_unopposed).toBe(47); expect(away.in_possession.build_up_unopposed).toBe(43)
    expect(home.in_possession.progression).toBe(16); expect(away.in_possession.final_third).toBe(7)
    expect(home.in_possession.counter_attack).toBe(1); expect(away.in_possession.attacking_transition).toBe(12)
  })
  it('out-of-possession phases', () => {
    expect(home.out_of_possession.high_press).toBe(9); expect(away.out_of_possession.high_press).toBe(6)
    expect(home.out_of_possession.mid_block).toBe(25); expect(away.out_of_possession.mid_block).toBe(30)
    expect(home.out_of_possession.counter_press).toBe(8); expect(away.out_of_possession.counter_press).toBe(7)
  })
})
