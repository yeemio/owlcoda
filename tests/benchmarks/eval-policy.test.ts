import { describe, expect, it } from 'vitest'
import { basename } from 'node:path'
import {
  BENCHMARK_CASE_FIXTURES,
  buildBenchmarkEvalPacket,
  renderBenchmarkTaskPrompt,
  validateBenchmarkFixtureMethodology,
} from '../../src/benchmark/index.js'

describe('benchmark eval methodology policy', () => {
  it('keeps every fixture compliant with D1-D5 eval rules', () => {
    for (const fixture of BENCHMARK_CASE_FIXTURES) {
      expect(validateBenchmarkFixtureMethodology(fixture)).toEqual({ ok: true, issues: [] })
    }
  })

  it('renders clean model prompts with exact absolute output paths', () => {
    const workspace = '/tmp/owlcoda-eval-policy-test'

    for (const fixture of BENCHMARK_CASE_FIXTURES) {
      const prompt = renderBenchmarkTaskPrompt(fixture, workspace)
      expect(prompt).not.toContain('__WORKSPACE__')
      expect(prompt).not.toMatch(/\btask_no_progress\b|\btelemetry\b|\baudit fields?\b|\btool sequence\b/i)

      for (const artifactPath of fixture.evalPolicy.expectedArtifactPaths) {
        const rendered = artifactPath.replaceAll('__WORKSPACE__', workspace)
        expect(prompt).toContain(rendered)
        expect(rendered.startsWith(`${workspace}/`)).toBe(true)
        expect(basename(rendered).length).toBeGreaterThan(0)
      }
    }
  })

  it('builds eval packets that keep audit hooks outside the model prompt', () => {
    const fixture = BENCHMARK_CASE_FIXTURES.find((f) => f.caseId === 'deck-46p')!
    const packet = buildBenchmarkEvalPacket(fixture, '/tmp/owlcoda-eval')

    expect(packet.taskPrompt).toContain('/tmp/owlcoda-eval/deck.html')
    expect(packet.taskPrompt).not.toContain('task_no_progress')
    expect(packet.evalHooks.auditFields).toEqual(expect.arrayContaining([
      'artifact_list',
      'final_status',
      'section_count',
      'task_no_progress',
      'tool_sequence',
      'verification_results',
    ]))
    expect(packet.evalHooks.timeoutMs).toBeGreaterThanOrEqual(15 * 60 * 1000)
    expect(packet.evalHooks.keepalive).toBe('progress_sentinel')
  })

  it('pins long-deck smoke to quality minimum while keeping exact 46 pages in heavy eval', () => {
    for (const caseId of ['deck-46p', 'deck-46p-realistic'] as const) {
      const fixture = BENCHMARK_CASE_FIXTURES.find((f) => f.caseId === caseId)!
      expect(fixture.prompt).not.toMatch(/\b46 page\b|\b46-page\b/i)
      expect(fixture.evalPolicy.sectionPolicy).toMatchObject({
        smokeMinSections: 30,
        heavyExactSections: 46,
        exactSectionsGate: 'heavy_eval',
      })
    }
  })
})
