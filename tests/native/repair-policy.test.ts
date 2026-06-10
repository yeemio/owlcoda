import { describe, expect, it } from 'vitest'
import { decideRepairPolicy } from '../../src/native/repair-policy.js'
import type { VerificationCheckResult, VerificationPackResult } from '../../src/native/verification-packs/types.js'

function check(overrides: Partial<VerificationCheckResult>): VerificationCheckResult {
  return {
    checkId: 'sample_check',
    passed: true,
    severity: 'error',
    detail: 'ok',
    ...overrides,
  }
}

function htmlDeckResult(overrides: Partial<VerificationPackResult> = {}): VerificationPackResult {
  const checks = overrides.checks ?? [
    check({ checkId: 'section_count', passed: true, detail: 'found expected 46 sections' }),
    check({ checkId: 'title_placeholder', passed: true, detail: 'title is present and does not contain known placeholders' }),
  ]
  const passed = overrides.passed ?? checks.every(entry => entry.passed)

  return {
    packId: 'html_deck',
    status: passed ? 'passed' : 'failed',
    passed,
    artifactPath: '/tmp/owlcoda/deck.html',
    checkedAt: '2026-05-15T00:00:00.000Z',
    checks,
    ...overrides,
  }
}

describe('repair policy', () => {
  it('returns passed when all verification checks passed', () => {
    const decision = decideRepairPolicy({
      verification: htmlDeckResult(),
      attemptCount: 2,
      maxAttempts: 2,
    })

    expect(decision).toEqual({
      action: 'passed',
      artifactPath: '/tmp/owlcoda/deck.html',
      failedCheckIds: [],
    })
  })

  it('returns repair for a failed first attempt below maxAttempts', () => {
    const decision = decideRepairPolicy({
      verification: htmlDeckResult({
        passed: false,
        checks: [
          check({ checkId: 'section_count', passed: false, detail: 'expected 46 sections, got 45' }),
        ],
      }),
      attemptCount: 0,
      maxAttempts: 2,
    })

    expect(decision.action).toBe('repair')
    expect(decision.failedCheckIds).toEqual(['section_count'])
    expect(decision.repairPrompt).toContain('Artifact path: /tmp/owlcoda/deck.html')
    expect(decision.repairPrompt).toContain('Failed checkIds: section_count')
    expect(decision.repairPrompt).toContain('expected 46 sections, got 45')
    expect(decision.repairPrompt).toContain('修复后再次运行 ArtifactVerify/TaskVerify')
  })

  it('returns blocked for repeated failure at maxAttempts', () => {
    const decision = decideRepairPolicy({
      verification: htmlDeckResult({
        passed: false,
        checks: [
          check({ checkId: 'section_count', passed: false, detail: 'expected 46 sections, got 45' }),
        ],
      }),
      attemptCount: 2,
      maxAttempts: 2,
    })

    expect(decision.action).toBe('blocked')
    expect(decision.failedCheckIds).toEqual(['section_count'])
    expect(decision.repairPrompt).toBeUndefined()
    expect(decision.blockedReason).toContain('attemptCount=2')
    expect(decision.blockedReason).toContain('maxAttempts=2')
  })

  it('builds a title_placeholder repair prompt with artifact path, checkId, detail, and rerun instruction', () => {
    const decision = decideRepairPolicy({
      verification: htmlDeckResult({
        passed: false,
        checks: [
          check({
            checkId: 'title_placeholder',
            passed: false,
            detail: 'title contains placeholder pattern: required-placeholder',
          }),
        ],
      }),
      attemptCount: 1,
      maxAttempts: 3,
    })

    expect(decision.action).toBe('repair')
    expect(decision.repairPrompt).toContain('Artifact path: /tmp/owlcoda/deck.html')
    expect(decision.repairPrompt).toContain('Failed checkIds: title_placeholder')
    expect(decision.repairPrompt).toContain('title_placeholder: title contains placeholder pattern: required-placeholder')
    expect(decision.repairPrompt).toContain('修复后再次运行 ArtifactVerify/TaskVerify')
    expect(decision.repairPrompt).toContain('After fixing, run ArtifactVerify/TaskVerify again')
  })

  it('builds a section_count repair prompt with artifact path, checkId, detail, and rerun instruction', () => {
    const decision = decideRepairPolicy({
      verification: htmlDeckResult({
        artifactPath: '/tmp/owlcoda/report/deck.html',
        passed: false,
        checks: [
          check({
            checkId: 'section_count',
            passed: false,
            detail: 'expected 46 sections, got 47',
          }),
        ],
      }),
      attemptCount: 1,
      maxAttempts: 3,
    })

    expect(decision.action).toBe('repair')
    expect(decision.artifactPath).toBe('/tmp/owlcoda/report/deck.html')
    expect(decision.repairPrompt).toContain('Artifact path: /tmp/owlcoda/report/deck.html')
    expect(decision.repairPrompt).toContain('Failed checkIds: section_count')
    expect(decision.repairPrompt).toContain('section_count: expected 46 sections, got 47')
    expect(decision.repairPrompt).toContain('修复后再次运行 ArtifactVerify/TaskVerify')
  })
})
