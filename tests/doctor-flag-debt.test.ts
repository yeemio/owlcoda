import { describe, expect, it } from 'vitest'
import { checkGateFlagDebt } from '../src/doctor.js'

describe('checkGateFlagDebt', () => {
  it('passes when no opt-in gate is past its review date yet', () => {
    const r = checkGateFlagDebt(Date.parse('2026-01-01T00:00:00Z'))
    expect(r.status).toBe('pass')
    expect(r.name).toBe('Gate flag-debt')
  })

  it('warns and names an overdue gate with the decide-or-kill prompt', () => {
    const r = checkGateFlagDebt(Date.parse('2030-01-01T00:00:00Z'))
    expect(r.status).toBe('warn')
    expect(r.detail).toContain('gate_v2')
    expect(r.detail).toContain('cutover or kill')
  })
})
