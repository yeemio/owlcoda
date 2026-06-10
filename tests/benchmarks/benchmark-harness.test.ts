import { describe, expect, it } from 'vitest'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BENCHMARK_CASE_IDS,
  benchmarkResultToJson,
  checkDeckArtifacts,
  countHtmlDeckSections,
  inspectHtmlDeck,
  listBenchmarkCases,
  runBenchmarkCaseDryRun,
  runBenchmarkSuiteDryRun,
  validateBenchmarkResultSchema,
} from '../../src/benchmark/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, 'fixtures')

describe('runtime benchmark harness', () => {
  it('defines the required benchmark case ids', () => {
    expect(BENCHMARK_CASE_IDS).toEqual([
      'deck-46p',
      'deck-12p',
      'code-fix-tests',
      'readonly-review',
      'research-note',
      'data-report',
      'deck-46p-realistic',
      'smoke-provenance-article',
      'smoke-provenance-known-file',
    ])
    expect(listBenchmarkCases()).toHaveLength(9)
  })

  it('dry-runs every case into the benchmark JSON schema', () => {
    const results = runBenchmarkSuiteDryRun({ packageVersion: '0.14.test', binaryBuild: 'dry-run-test' })

    expect(results).toHaveLength(9)
    for (const result of results) {
      expect(validateBenchmarkResultSchema(result)).toEqual({ ok: true, issues: [] })
      expect(result.packageVersion).toBe('0.14.test')
      expect(result.binaryBuild).toBe('dry-run-test')
      expect(result.taskNoProgress).toHaveProperty('hard')
      expect(result.taskNoProgress).toHaveProperty('suppressed')

      const parsed = JSON.parse(benchmarkResultToJson(result))
      expect(parsed).toMatchObject({
        caseId: result.caseId,
        packageVersion: '0.14.test',
        binaryBuild: 'dry-run-test',
        finalStatus: result.finalStatus,
      })
    }
  })

  it('records deck-46p verification signals required by Slice A', () => {
    const result = runBenchmarkCaseDryRun('deck-46p', { packageVersion: '0.14.test', binaryBuild: 'dry-run-test' })

    expect(result.selectedSkill).toBe('guizang-ppt-skill')
    expect(result.verification.map(v => v.kind)).toEqual(expect.arrayContaining([
      'html_deck.section_count',
      'html_deck.title_placeholder',
      'html_deck.build_notes_exists',
      'html_deck.required_marker',
    ]))
    expect(result.taskNoProgress).toEqual({ hard: 0, suppressed: 0 })
  })

  it('rejects malformed benchmark result objects', () => {
    const validation = validateBenchmarkResultSchema({
      caseId: 'deck-12p',
      packageVersion: '',
      binaryBuild: 'dry-run-test',
      selectedSkill: 42,
      timeToFirstWriteMs: -1,
      readCallsBeforeFirstWrite: 1.2,
      artifacts: [{ path: '', kind: 'html_deck', exists: true }],
      verification: [{ id: 'x', kind: 'html_deck.section_count', status: 'maybe', passed: true, message: 'x' }],
      taskNoProgress: { hard: 0, suppressed: -1 },
      finalStatus: 'done',
    })

    expect(validation.ok).toBe(false)
    expect(validation.issues.length).toBeGreaterThan(5)
  })
})

describe('html deck benchmark helper', () => {
  it('counts sections and detects a clean title', () => {
    const html = '<title>Real Deck</title><section>1</section><section>2</section>'
    const inspection = inspectHtmlDeck(html, { requiredMarkers: ['Real Deck', 'P18'] })

    expect(countHtmlDeckSections(html)).toBe(2)
    expect(inspection.title).toBe('Real Deck')
    expect(inspection.titleHasPlaceholder).toBe(false)
    expect(inspection.requiredMarkers).toEqual([
      { marker: 'Real Deck', present: true },
      { marker: 'P18', present: false },
    ])
  })

  it('ignores section-like HTML comments when counting sections', () => {
    const html = [
      '<!doctype html>',
      '<!-- <section>template example</section> -->',
      '<section>1</section>',
      '<section>2</section>',
    ].join('\n')

    expect(countHtmlDeckSections(html)).toBe(2)
    expect(inspectHtmlDeck(html).sectionCount).toBe(2)
  })

  it('passes section, title, and build-note checks for a good deck fixture', () => {
    const results = checkDeckArtifacts({
      htmlPath: join(fixturesDir, 'good-deck', 'deck.html'),
      buildNotesPath: join(fixturesDir, 'good-deck', 'build-notes.md'),
      expectedSections: 12,
      requiredMarkers: ['Operating Model'],
    })

    expect(results.every(result => result.passed)).toBe(true)
    expect(results.map(result => result.kind)).toEqual(expect.arrayContaining([
      'html_deck.section_count',
      'html_deck.title_placeholder',
      'html_deck.build_notes_exists',
      'html_deck.required_marker',
    ]))
  })

  it('fails section, title placeholder, missing marker, and build-note checks for a bad deck fixture', () => {
    const results = checkDeckArtifacts({
      htmlPath: join(fixturesDir, 'bad-deck', 'deck.html'),
      buildNotesPath: join(fixturesDir, 'bad-deck', 'build-notes.md'),
      expectedSections: 12,
      requiredMarkers: ['P18'],
    })

    expect(results.find(result => result.kind === 'html_deck.section_count')?.passed).toBe(false)
    expect(results.find(result => result.kind === 'html_deck.title_placeholder')?.passed).toBe(false)
    expect(results.find(result => result.kind === 'html_deck.required_marker')?.passed).toBe(false)
    expect(results.find(result => result.kind === 'html_deck.build_notes_exists')?.passed).toBe(false)
  })
})
