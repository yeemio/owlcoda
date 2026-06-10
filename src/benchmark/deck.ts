import { existsSync, readFileSync, statSync } from 'node:fs'
import type { BenchmarkVerification } from './types.js'

const DEFAULT_TITLE_PLACEHOLDER_PATTERNS = [
  /\[必填\]/i,
  /替换为/i,
  /PPT\s*标题/i,
  /Deck\s*Title/i,
  /\bTODO\b/i,
  /\bUntitled\b/i,
]

export interface DeckInspectionOptions {
  titlePlaceholderPatterns?: RegExp[]
  requiredMarkers?: string[]
}

export interface DeckInspection {
  sectionCount: number
  title: string | null
  titleHasPlaceholder: boolean
  titlePlaceholderMatches: string[]
  requiredMarkers: Array<{ marker: string; present: boolean }>
  byteLength: number
}

export interface DeckArtifactCheckOptions extends DeckInspectionOptions {
  htmlPath: string
  buildNotesPath?: string
  expectedSections?: number
  minBytes?: number
}

export function countHtmlDeckSections(html: string): number {
  return stripHtmlComments(html).match(/<section(?:\s|>|\/)/gi)?.length ?? 0
}

export function extractHtmlTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!match) return null
  return match[1]!.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

export function inspectHtmlDeck(html: string, opts: DeckInspectionOptions = {}): DeckInspection {
  const patterns = opts.titlePlaceholderPatterns ?? DEFAULT_TITLE_PLACEHOLDER_PATTERNS
  const title = extractHtmlTitle(html)
  const titlePlaceholderMatches = title
    ? patterns.filter(pattern => pattern.test(title)).map(pattern => pattern.source)
    : []

  return {
    sectionCount: countHtmlDeckSections(html),
    title,
    titleHasPlaceholder: title === null || titlePlaceholderMatches.length > 0,
    titlePlaceholderMatches,
    requiredMarkers: (opts.requiredMarkers ?? []).map(marker => ({
      marker,
      present: html.includes(marker),
    })),
    byteLength: Buffer.byteLength(html, 'utf8'),
  }
}

export function checkDeckArtifacts(opts: DeckArtifactCheckOptions): BenchmarkVerification[] {
  const results: BenchmarkVerification[] = []
  const htmlExists = existsSync(opts.htmlPath)

  results.push(makeVerification({
    id: 'html_deck.file_exists',
    kind: 'html_deck.file_exists',
    passed: htmlExists,
    expected: true,
    actual: htmlExists,
    message: htmlExists ? 'HTML deck exists.' : `HTML deck is missing: ${opts.htmlPath}`,
  }))

  if (!htmlExists) {
    if (opts.buildNotesPath) results.push(checkBuildNotes(opts.buildNotesPath))
    return results
  }

  const html = readFileSync(opts.htmlPath, 'utf8')
  const inspection = inspectHtmlDeck(html, opts)

  if (typeof opts.expectedSections === 'number') {
    results.push(makeVerification({
      id: 'html_deck.section_count',
      kind: 'html_deck.section_count',
      passed: inspection.sectionCount === opts.expectedSections,
      expected: opts.expectedSections,
      actual: inspection.sectionCount,
      message: inspection.sectionCount === opts.expectedSections
        ? `HTML deck has ${opts.expectedSections} sections.`
        : `HTML deck has ${inspection.sectionCount} sections; expected ${opts.expectedSections}.`,
    }))
  }

  results.push(makeVerification({
    id: 'html_deck.title_placeholder',
    kind: 'html_deck.title_placeholder',
    passed: !inspection.titleHasPlaceholder,
    expected: false,
    actual: inspection.titleHasPlaceholder,
    message: !inspection.titleHasPlaceholder
      ? 'HTML title does not contain a template placeholder.'
      : `HTML title is missing or still looks like a placeholder: ${inspection.title ?? '(missing)'}`,
  }))

  if (typeof opts.minBytes === 'number') {
    const bytes = statSync(opts.htmlPath).size
    results.push(makeVerification({
      id: 'html_deck.min_bytes',
      kind: 'html_deck.min_bytes',
      passed: bytes >= opts.minBytes,
      expected: opts.minBytes,
      actual: bytes,
      message: bytes >= opts.minBytes
        ? `HTML deck is at least ${opts.minBytes} bytes.`
        : `HTML deck is ${bytes} bytes; expected at least ${opts.minBytes}.`,
    }))
  }

  for (const marker of inspection.requiredMarkers) {
    results.push(makeVerification({
      id: `html_deck.required_marker.${normalizeMarkerId(marker.marker)}`,
      kind: 'html_deck.required_marker',
      passed: marker.present,
      expected: true,
      actual: marker.present,
      message: marker.present ? `Required marker is present: ${marker.marker}` : `Required marker is missing: ${marker.marker}`,
    }))
  }

  if (opts.buildNotesPath) results.push(checkBuildNotes(opts.buildNotesPath))

  return results
}

function checkBuildNotes(buildNotesPath: string): BenchmarkVerification {
  const exists = existsSync(buildNotesPath)
  return makeVerification({
    id: 'html_deck.build_notes_exists',
    kind: 'html_deck.build_notes_exists',
    passed: exists,
    expected: true,
    actual: exists,
    message: exists ? 'Build notes file exists.' : `Build notes file is missing: ${buildNotesPath}`,
  })
}

function makeVerification(input: Omit<BenchmarkVerification, 'status'>): BenchmarkVerification {
  return {
    ...input,
    status: input.passed ? 'passed' : 'failed',
  }
}

function normalizeMarkerId(marker: string): string {
  return marker.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'marker'
}

function stripHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '')
}
