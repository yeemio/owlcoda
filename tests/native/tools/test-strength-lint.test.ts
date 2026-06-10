/**
 * Tests for the lite test-strength lint.
 *
 * Pin the wide-coverage-name + vacuous-only-assertion detection.
 * False positives are tolerable; false negatives are tolerable; the
 * lint is a heuristic warning, not a CI gate.
 */
import { describe, it, expect } from 'vitest'
import { lintTestStrength } from '../../../src/native/tools/test-strength-lint.js'

describe('lintTestStrength: flags vacuous wide-coverage tests', () => {
  it('flags "covers source=model" with only toBeDefined', () => {
    const content = `
import { describe, it, expect } from 'vitest'

describe('annotation', () => {
  it('covers source=model annotation', () => {
    const r = run()
    expect(r.source).toBeDefined()
  })
})
`
    const result = lintTestStrength('a.test.ts', content)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]!).toMatchObject({
      file: 'a.test.ts',
      testName: 'covers source=model annotation',
    })
    expect(result.findings[0]!.reason).toMatch(/vacuous/)
  })

  it('flags "happy path works" with only toBeTruthy', () => {
    const content = `
it('happy path works for source annotation', async () => {
  const r = await run()
  expect(r).toBeTruthy()
})
`
    const result = lintTestStrength('b.test.ts', content)
    expect(result.findings).toHaveLength(1)
  })

  it('flags Chinese 场景 with only not.toBeNull', () => {
    const content = `
it('覆盖8个场景', () => {
  const r = run()
  expect(r).not.toBeNull()
})
`
    const result = lintTestStrength('c.test.ts', content)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]!.testName).toBe('覆盖8个场景')
  })
})

describe('lintTestStrength: does NOT flag', () => {
  it('substantive matcher present (toBe)', () => {
    const content = `
it('covers source=model annotation', () => {
  const r = run()
  expect(r.source).toBe('model')
})
`
    expect(lintTestStrength('x.test.ts', content).findings).toEqual([])
  })

  it('substantive matcher present (toEqual)', () => {
    const content = `
it('happy path works', () => {
  const r = run()
  expect(r).toEqual({ ok: true })
})
`
    expect(lintTestStrength('x.test.ts', content).findings).toEqual([])
  })

  it('non-wide test name even with vacuous assertion', () => {
    const content = `
it('returns a value', () => {
  const r = run()
  expect(r).toBeDefined()
})
`
    expect(lintTestStrength('x.test.ts', content).findings).toEqual([])
  })

  it('test with no assertions at all (smoke test)', () => {
    const content = `
it('covers everything', () => {
  run()
})
`
    expect(lintTestStrength('x.test.ts', content).findings).toEqual([])
  })

  it('substantive AND vacuous together is OK (substantive wins)', () => {
    const content = `
it('covers all paths', () => {
  const r = run()
  expect(r.value).toBe(42)
  expect(r.detail).toBeDefined()
})
`
    expect(lintTestStrength('x.test.ts', content).findings).toEqual([])
  })

  it('toMatch / toContain / toThrow are all substantive', () => {
    const content = `
it('covers full output', () => {
  expect(run()).toMatch(/done/)
})
it('covers list', () => {
  expect(arr).toContain(1)
})
it('covers throw path', () => {
  expect(() => boom()).toThrow()
})
`
    expect(lintTestStrength('x.test.ts', content).findings).toEqual([])
  })
})

describe('lintTestStrength: parsing edge cases', () => {
  it('handles async arrow functions', () => {
    const content = `
it('covers async path', async () => {
  const r = await run()
  expect(r).toBeDefined()
})
`
    expect(lintTestStrength('x.test.ts', content).findings).toHaveLength(1)
  })

  it('handles function-keyword callbacks', () => {
    const content = `
it('covers fn-keyword', function () {
  const r = run()
  expect(r).toBeDefined()
})
`
    expect(lintTestStrength('x.test.ts', content).findings).toHaveLength(1)
  })

  it('handles it.skip / it.only modifiers', () => {
    const content = `
it.only('covers focused path', () => {
  expect(run()).toBeTruthy()
})
`
    expect(lintTestStrength('x.test.ts', content).findings).toHaveLength(1)
  })

  it('counts test blocks correctly', () => {
    const content = `
it('one', () => { expect(x).toBe(1) })
it('two', () => { expect(y).toBe(2) })
test('three', () => { expect(z).toBe(3) })
`
    expect(lintTestStrength('x.test.ts', content).testCount).toBe(3)
  })

  it('strings inside the body do not break brace balancing', () => {
    const content = `
it('covers stringy edge', () => {
  const s = '{ this is a string with { braces inside }'
  expect(s).toBeDefined()
})
`
    expect(lintTestStrength('x.test.ts', content).findings).toHaveLength(1)
  })
})
