import { describe, expect, it } from 'vitest'
import { selectMcNemarMethod } from '../../src/native/statistical-test-policy.js'

describe('selectMcNemarMethod', () => {
  it('defaults to exact for one discordant pair', () => {
    expect(selectMcNemarMethod(1, 0)).toMatchObject({ method: 'exact', discordantPairs: 1 })
  })

  it('fails closed when sparse data explicitly requests the approximation', () => {
    expect(() => selectMcNemarMethod(1, 0, 'asymptotic')).toThrow(/refused.*use exact/i)
  })

  it('allows the approximation only after the minimum sample guard', () => {
    expect(selectMcNemarMethod(13, 12, 'asymptotic')).toMatchObject({ method: 'asymptotic', discordantPairs: 25 })
  })
})
