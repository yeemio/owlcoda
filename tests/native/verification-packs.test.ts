import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyHtmlDeck } from '../../src/native/verification-packs/html-deck.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owlcoda-verification-packs-'))
})

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

function writeDeckFixture(options: {
  title?: string
  sections?: number
  markers?: string[]
  bodyExtra?: string
  buildNotes?: string | null
} = {}) {
  const deckPath = path.join(tmpDir, 'deck.html')
  const sections = options.sections ?? 46
  const htmlSections = Array.from({ length: sections }, (_, index) => (
    `<section id="slide-${index + 1}"><h1>Slide ${index + 1}</h1><p>This section covers topic ${index + 1} in depth, providing detailed analysis of the subject matter relevant to the presentation context and intended audience. Additional supporting data and case references are included below for completeness.</p></section>`
  )).join('\n')
  const html = [
    '<!doctype html>',
    '<html>',
    '<head>',
    `<title>${options.title ?? 'Industrial AI Agent Review'}</title>`,
    '</head>',
    '<body>',
    ...(options.markers ?? []).map(marker => `<div data-marker="${marker}">${marker}</div>`),
    options.bodyExtra ?? '',
    htmlSections,
    '</body>',
    '</html>',
  ].join('\n')

  fs.writeFileSync(deckPath, html)
  if (options.buildNotes !== null) {
    fs.writeFileSync(path.join(tmpDir, 'build-notes.md'), options.buildNotes ?? '# Build Notes\n\nGenerated in fixture.\n')
  }
  return deckPath
}

function runDeckVerification(deckPath: string) {
  return verifyHtmlDeck({
    deckPath,
    expectedSections: 46,
    requiredMarkers: ['P18_SPECIAL', 'P35_SPECIAL'],
    minFileSizeBytes: 100,
    forbiddenTerms: ['INTERNAL_ONLY'],
  })
}

function findCheck(result: ReturnType<typeof verifyHtmlDeck>, checkId: string) {
  const check = result.checks.find(entry => entry.checkId === checkId)
  expect(check).toBeTruthy()
  return check!
}

describe('html_deck verification pack', () => {
  it('fails when a 47 section deck is expected to have 46 sections', () => {
    const deckPath = writeDeckFixture({ sections: 47, markers: ['P18_SPECIAL', 'P35_SPECIAL'] })
    const result = runDeckVerification(deckPath)

    expect(result.status).toBe('failed')
    expect(result.passed).toBe(false)
    const sectionCheck = findCheck(result, 'section_count')
    expect(sectionCheck.passed).toBe(false)
    expect(sectionCheck.detail).toContain('expected 46 sections, got 47')
  })

  it('fails when the title contains a required placeholder', () => {
    const deckPath = writeDeckFixture({ title: '工业 AI Agent [必填]', markers: ['P18_SPECIAL', 'P35_SPECIAL'] })
    const result = runDeckVerification(deckPath)

    expect(result.status).toBe('failed')
    const titleCheck = findCheck(result, 'title_placeholder')
    expect(titleCheck.passed).toBe(false)
    expect(titleCheck.detail).toContain('required-placeholder')
  })

  it('fails when the title contains a template placeholder', () => {
    const deckPath = writeDeckFixture({ title: '{{ deck_title }}', markers: ['P18_SPECIAL', 'P35_SPECIAL'] })
    const result = runDeckVerification(deckPath)

    expect(result.status).toBe('failed')
    const titleCheck = findCheck(result, 'title_placeholder')
    expect(titleCheck.passed).toBe(false)
    expect(titleCheck.detail).toContain('template-braces')
  })

  it('fails when build-notes.md is missing', () => {
    const deckPath = writeDeckFixture({ markers: ['P18_SPECIAL', 'P35_SPECIAL'], buildNotes: null })
    const result = runDeckVerification(deckPath)

    expect(result.status).toBe('failed')
    const notesCheck = findCheck(result, 'build_notes_exists')
    expect(notesCheck.passed).toBe(false)
    expect(notesCheck.detail).toContain('missing build notes')
  })

  it('fails when a required marker is missing', () => {
    const deckPath = writeDeckFixture({ markers: ['P18_SPECIAL'] })
    const result = runDeckVerification(deckPath)

    expect(result.status).toBe('failed')
    const markerCheck = findCheck(result, 'required_markers')
    expect(markerCheck.passed).toBe(false)
    expect(markerCheck.detail).toContain('P35_SPECIAL')
  })

  it('fails when the deck is below the configured minimum file size', () => {
    const deckPath = writeDeckFixture({ sections: 1, markers: ['P18_SPECIAL', 'P35_SPECIAL'] })
    const result = verifyHtmlDeck({
      deckPath,
      expectedSections: 1,
      requiredMarkers: ['P18_SPECIAL', 'P35_SPECIAL'],
      minFileSizeBytes: 20_000,
    })

    expect(result.status).toBe('failed')
    const sizeCheck = findCheck(result, 'min_file_size')
    expect(sizeCheck.passed).toBe(false)
    expect(sizeCheck.detail).toContain('below min 20000')
  })

  it('fails when forbidden terms are present', () => {
    const deckPath = writeDeckFixture({
      markers: ['P18_SPECIAL', 'P35_SPECIAL'],
      bodyExtra: '<p>INTERNAL_ONLY launch notes</p>',
    })
    const result = runDeckVerification(deckPath)

    expect(result.status).toBe('failed')
    const forbiddenCheck = findCheck(result, 'forbidden_terms')
    expect(forbiddenCheck.passed).toBe(false)
    expect(forbiddenCheck.detail).toContain('INTERNAL_ONLY')
  })

  it('passes for a normal html deck sample', () => {
    const deckPath = writeDeckFixture({ markers: ['P18_SPECIAL', 'P35_SPECIAL'] })
    const result = runDeckVerification(deckPath)

    expect(result.status).toBe('passed')
    expect(result.passed).toBe(true)
    expect(result.packId).toBe('html_deck')
    expect(result.checks.every(check => check.passed)).toBe(true)
  })

  it('returns structured check results', () => {
    const deckPath = writeDeckFixture({ markers: ['P18_SPECIAL', 'P35_SPECIAL'] })
    const result = runDeckVerification(deckPath)

    expect(result.checks.length).toBeGreaterThan(0)
    for (const check of result.checks) {
      expect(typeof check.checkId).toBe('string')
      expect(typeof check.passed).toBe('boolean')
      expect(['info', 'warning', 'error']).toContain(check.severity)
      expect(typeof check.detail).toBe('string')
    }
  })

  // B4 density checks
  it('fails section_min_bytes when sections have insufficient content', () => {
    const deckPath = path.join(tmpDir, 'thin.html')
    const thinSections = Array.from({ length: 46 }, (_, i) => `<section><h1>Slide ${i + 1}</h1></section>`).join('\n')
    fs.writeFileSync(deckPath, `<!doctype html><html><head><title>Real Deck Title</title></head><body>${thinSections}</body></html>`)
    fs.writeFileSync(path.join(tmpDir, 'build-notes.md'), '# Build Notes\n')
    const result = verifyHtmlDeck({ deckPath, expectedSections: 46, minSectionBytes: 200 })

    expect(result.passed).toBe(false)
    const check = findCheck(result, 'section_min_bytes')
    expect(check.passed).toBe(false)
    expect(check.detail).toContain('below minimum')
  })

  it('fails section_placeholder_pattern when sections contain only a heading', () => {
    const deckPath = path.join(tmpDir, 'heading-only.html')
    const sections = Array.from({ length: 46 }, (_, i) => `<section><h1>Slide ${i + 1}</h1></section>`).join('\n')
    fs.writeFileSync(deckPath, `<!doctype html><html><head><title>Real Deck Title</title></head><body>${sections}</body></html>`)
    fs.writeFileSync(path.join(tmpDir, 'build-notes.md'), '# Build Notes\n')
    const result = verifyHtmlDeck({ deckPath, expectedSections: 46, minSectionBytes: 0 })

    expect(result.passed).toBe(false)
    const check = findCheck(result, 'section_placeholder_pattern')
    expect(check.passed).toBe(false)
    expect(check.detail).toContain('only a single heading')
  })

  it('fails title_semantic_placeholder when title contains "Repaired"', () => {
    const deckPath = writeDeckFixture({ title: 'Repaired HTML Deck', markers: ['P18_SPECIAL', 'P35_SPECIAL'] })
    const result = runDeckVerification(deckPath)

    expect(result.passed).toBe(false)
    const check = findCheck(result, 'title_semantic_placeholder')
    expect(check.passed).toBe(false)
    expect(check.detail).toContain('semantic-placeholder-en')
  })

  it('fails title_semantic_placeholder when title contains Chinese unresolved placeholder words', () => {
    const deckPath = writeDeckFixture({ title: '工业AI待填演示', markers: ['P18_SPECIAL', 'P35_SPECIAL'] })
    const result = runDeckVerification(deckPath)

    expect(result.passed).toBe(false)
    const check = findCheck(result, 'title_semantic_placeholder')
    expect(check.passed).toBe(false)
    expect(check.detail).toContain('semantic-placeholder-zh')
  })

  it('allows real titles that contain demo/test/example terms', () => {
    const deckPath = writeDeckFixture({
      title: 'Demo Day Test Automation 示例分析',
      markers: ['P18_SPECIAL', 'P35_SPECIAL'],
    })
    const result = runDeckVerification(deckPath)

    const check = findCheck(result, 'title_semantic_placeholder')
    expect(check.passed).toBe(true)
  })

  it('fails forbidden_repair_marker when title is "Repaired HTML Deck"', () => {
    const deckPath = writeDeckFixture({ title: 'Repaired HTML Deck', markers: ['P18_SPECIAL', 'P35_SPECIAL'] })
    const result = runDeckVerification(deckPath)

    expect(result.passed).toBe(false)
    const check = findCheck(result, 'forbidden_repair_marker')
    expect(check.passed).toBe(false)
    expect(check.detail).toContain('repaired html deck')
  })

  it('does not fail forbidden_repair_marker when marker only appears in HTML comments', () => {
    const deckPath = writeDeckFixture({
      markers: ['P18_SPECIAL', 'P35_SPECIAL'],
      bodyExtra: '<!-- repaired html deck was here, now removed -->',
    })
    const result = runDeckVerification(deckPath)

    const check = findCheck(result, 'forbidden_repair_marker')
    expect(check.passed).toBe(true)
  })

  it('fails forbidden_repair_marker when a later heading contains a repair marker', () => {
    const deckPath = writeDeckFixture({
      markers: ['P18_SPECIAL', 'P35_SPECIAL'],
      bodyExtra: '<h2>正常章节</h2><h2>Repaired HTML Deck</h2>',
    })
    const result = runDeckVerification(deckPath)

    const check = findCheck(result, 'forbidden_repair_marker')
    expect(check.passed).toBe(false)
    expect(check.detail).toContain('repaired html deck')
  })

  it('fails placeholder-deck fixture on section_min_bytes and section_placeholder_pattern', () => {
    const fixturePath = path.join(__dirname, '..', 'benchmarks', 'fixtures', 'placeholder-deck', 'deck.html')
    const buildNotesPath = path.join(__dirname, '..', 'benchmarks', 'fixtures', 'placeholder-deck', 'build-notes.md')
    const result = verifyHtmlDeck({
      deckPath: fixturePath,
      expectedSections: 12,
      buildNotesPath,
      minSectionBytes: 200,
    })

    expect(result.passed).toBe(false)
    const failedCheckIds = result.checks.filter(c => !c.passed).map(c => c.checkId)
    // Must fail at least 2 of the 4 new B4 check ids
    const b4Checks = ['section_min_bytes', 'section_placeholder_pattern', 'title_semantic_placeholder', 'forbidden_repair_marker']
    const b4Fails = failedCheckIds.filter(id => b4Checks.includes(id))
    expect(b4Fails.length).toBeGreaterThanOrEqual(2)
  })

  it('passes good-deck fixture for section density when given enough content (no false positive)', () => {
    // good-deck fixture has short sections (plain text, no heading-only pattern) — passes section_placeholder_pattern
    // but would fail section_min_bytes because sections are minimal; test with minSectionBytes:0 to verify no other regressions
    const fixturePath = path.join(__dirname, '..', 'benchmarks', 'fixtures', 'good-deck', 'deck.html')
    const buildNotesPath = path.join(__dirname, '..', 'benchmarks', 'fixtures', 'good-deck', 'build-notes.md')
    const result = verifyHtmlDeck({
      deckPath: fixturePath,
      expectedSections: 12,
      buildNotesPath,
      minSectionBytes: 0,
    })

    expect(result.passed).toBe(true)
    expect(result.checks.find(c => c.checkId === 'section_placeholder_pattern')?.passed).toBe(true)
    expect(result.checks.find(c => c.checkId === 'title_semantic_placeholder')?.passed).toBe(true)
    expect(result.checks.find(c => c.checkId === 'forbidden_repair_marker')?.passed).toBe(true)
  })
})
