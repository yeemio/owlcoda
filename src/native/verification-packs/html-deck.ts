import * as fs from 'node:fs'
import * as path from 'node:path'
import type { VerificationCheckResult, VerificationPackResult } from './types.js'

export interface HtmlDeckRequiredMarker {
  marker: string
  label?: string
}

export interface HtmlDeckVerificationInput {
  deckPath: string
  expectedSections: number
  buildNotesPath?: string
  requiredMarkers?: readonly (string | HtmlDeckRequiredMarker)[]
  minFileSizeBytes?: number
  forbiddenTerms?: readonly string[]
  /** Minimum inner-HTML bytes per section. Default: 200. Set to 0 to skip. */
  minSectionBytes?: number
}

interface TitlePlaceholderPattern {
  id: string
  pattern: RegExp
}

const DEFAULT_MIN_FILE_SIZE_BYTES = 1

const TITLE_PLACEHOLDER_PATTERNS: readonly TitlePlaceholderPattern[] = [
  { id: 'required-placeholder', pattern: /\[必填\]/i },
  { id: 'template-braces', pattern: /\{\{\s*[^}]+?\s*\}\}/ },
  { id: 'template-expression', pattern: /\$\{\s*[^}]+?\s*\}/ },
  { id: 'template-ejs', pattern: /<%=?\s*[^%]+?\s*%>/ },
  { id: 'placeholder-token', pattern: /\b(?:title|deck|presentation)[_-]?placeholder\b/i },
  { id: 'stock-title-copy', pattern: /\b(?:untitled|your title|presentation title|deck title|insert title here)\b/i },
  { id: 'semantic-placeholder-en', pattern: /\b(?:repaired|repair|fixed|fix|to be filled|tbd|placeholder)\b/i },
  { id: 'semantic-placeholder-zh', pattern: /(?:占位|待填|待补)/ },
]

/** Repair-attempt markers that indicate a deck was not genuinely fixed. */
const REPAIR_MARKER_SELECTORS = [
  /<title\b[^>]*>([\s\S]*?)<\/title>/i,
  /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
  /<h2\b[^>]*>([\s\S]*?)<\/h2>/i,
]
const REPAIR_MARKER_TERMS = [
  'repaired html deck',
  '修复后的 deck',
  '已修复',
]

/** Regex: a section whose trimmed inner HTML matches ONLY a single h1 or h2 element (nothing else). */
const ONLY_HEADING_PATTERN = /^\s*<h[12]\b[^>]*>[\s\S]*?<\/h[12]>\s*$/i

const DEFAULT_MIN_SECTION_BYTES = 200

export function verifyHtmlDeck(input: HtmlDeckVerificationInput): VerificationPackResult {
  const deckPath = path.resolve(input.deckPath)
  const buildNotesPath = path.resolve(input.buildNotesPath ?? path.join(path.dirname(deckPath), 'build-notes.md'))
  const deckRead = readDeck(deckPath)
  const minFileSizeBytes = Math.max(0, input.minFileSizeBytes ?? DEFAULT_MIN_FILE_SIZE_BYTES)

  const minSectionBytes = input.minSectionBytes ?? DEFAULT_MIN_SECTION_BYTES

  const checks: VerificationCheckResult[] = [
    checkMinFileSize(deckRead, deckPath, minFileSizeBytes),
    checkSectionCount(deckRead.content, input.expectedSections),
    checkTitlePlaceholder(deckRead.content),
    checkTitleSemanticPlaceholder(deckRead.content),
    checkBuildNotes(buildNotesPath),
    checkRequiredMarkers(deckRead.content, input.requiredMarkers ?? []),
    checkForbiddenTerms(deckRead.content, buildNotesPath, input.forbiddenTerms ?? []),
    checkSectionMinBytes(deckRead.content, minSectionBytes),
    checkSectionPlaceholderPattern(deckRead.content),
    checkForbiddenRepairMarker(deckRead.content),
  ]

  const passed = checks.every(check => check.passed)

  return {
    packId: 'html_deck',
    status: passed ? 'passed' : 'failed',
    passed,
    artifactPath: deckPath,
    checkedAt: new Date().toISOString(),
    checks,
  }
}

function readDeck(deckPath: string): { content: string | null; sizeBytes: number | null; error?: string } {
  try {
    const stat = fs.statSync(deckPath)
    if (!stat.isFile()) {
      return { content: null, sizeBytes: null, error: `not a file: ${deckPath}` }
    }
    return {
      content: fs.readFileSync(deckPath, 'utf-8'),
      sizeBytes: stat.size,
    }
  } catch (err) {
    return { content: null, sizeBytes: null, error: `cannot read deck: ${String(err)}` }
  }
}

function checkMinFileSize(
  deckRead: { sizeBytes: number | null; error?: string },
  deckPath: string,
  minFileSizeBytes: number,
): VerificationCheckResult {
  if (deckRead.sizeBytes === null) {
    return failed('min_file_size', deckRead.error ?? `cannot stat deck: ${deckPath}`)
  }
  const passed = deckRead.sizeBytes >= minFileSizeBytes
  return {
    checkId: 'min_file_size',
    passed,
    severity: 'error',
    detail: passed
      ? `file size ${deckRead.sizeBytes} bytes meets min ${minFileSizeBytes}`
      : `file size ${deckRead.sizeBytes} bytes is below min ${minFileSizeBytes}`,
    metadata: { sizeBytes: deckRead.sizeBytes, minFileSizeBytes },
  }
}

function checkSectionCount(content: string | null, expectedSections: number): VerificationCheckResult {
  if (content === null) {
    return failed('section_count', 'cannot count sections because deck was not readable')
  }
  const observedSections = countSections(content)
  const passed = observedSections === expectedSections
  return {
    checkId: 'section_count',
    passed,
    severity: 'error',
    detail: passed
      ? `found expected ${expectedSections} sections`
      : `expected ${expectedSections} sections, got ${observedSections}`,
    metadata: { expectedSections, observedSections },
  }
}

function checkTitlePlaceholder(content: string | null): VerificationCheckResult {
  if (content === null) {
    return failed('title_placeholder', 'cannot inspect <title> because deck was not readable')
  }
  const title = extractTitle(content)
  if (title === null || title.length === 0) {
    return failed('title_placeholder', 'missing non-empty <title>')
  }

  const matched = TITLE_PLACEHOLDER_PATTERNS.find(entry => entry.pattern.test(title))
  if (matched) {
    return {
      checkId: 'title_placeholder',
      passed: false,
      severity: 'error',
      detail: `title contains placeholder pattern: ${matched.id}`,
      metadata: { title, patternId: matched.id },
    }
  }

  return {
    checkId: 'title_placeholder',
    passed: true,
    severity: 'error',
    detail: 'title is present and does not contain known placeholders',
    metadata: { title },
  }
}

function checkBuildNotes(buildNotesPath: string): VerificationCheckResult {
  try {
    const stat = fs.statSync(buildNotesPath)
    const passed = stat.isFile()
    return {
      checkId: 'build_notes_exists',
      passed,
      severity: 'error',
      detail: passed ? `found build notes: ${buildNotesPath}` : `build notes path is not a file: ${buildNotesPath}`,
      metadata: { buildNotesPath },
    }
  } catch {
    return failed('build_notes_exists', `missing build notes: ${buildNotesPath}`, { buildNotesPath })
  }
}

function checkRequiredMarkers(
  content: string | null,
  requiredMarkers: readonly (string | HtmlDeckRequiredMarker)[],
): VerificationCheckResult {
  if (content === null) {
    return failed('required_markers', 'cannot inspect markers because deck was not readable')
  }

  const markers = requiredMarkers.map(marker => typeof marker === 'string' ? { marker } : marker)
  if (markers.length === 0) {
    return {
      checkId: 'required_markers',
      passed: true,
      severity: 'error',
      detail: 'no required markers configured',
      metadata: { requiredMarkers: [] },
    }
  }

  const missing = markers.filter(entry => !content.includes(entry.marker))
  const passed = missing.length === 0
  return {
    checkId: 'required_markers',
    passed,
    severity: 'error',
    detail: passed
      ? `all ${markers.length} required markers found`
      : `missing required markers: ${missing.map(markerLabel).join(', ')}`,
    metadata: {
      requiredMarkers: markers.map(markerLabel),
      missingMarkers: missing.map(markerLabel),
    },
  }
}

function checkForbiddenTerms(
  content: string | null,
  buildNotesPath: string,
  forbiddenTerms: readonly string[],
): VerificationCheckResult {
  if (content === null) {
    return failed('forbidden_terms', 'cannot inspect forbidden terms because deck was not readable')
  }

  const terms = forbiddenTerms.map(term => term.trim()).filter(Boolean)
  if (terms.length === 0) {
    return {
      checkId: 'forbidden_terms',
      passed: true,
      severity: 'error',
      detail: 'no forbidden terms configured',
      metadata: { forbiddenTerms: [] },
    }
  }

  const haystack = `${content}\n${readOptionalText(buildNotesPath)}`.toLocaleLowerCase()
  const foundTerms = terms.filter(term => haystack.includes(term.toLocaleLowerCase()))
  const passed = foundTerms.length === 0
  return {
    checkId: 'forbidden_terms',
    passed,
    severity: 'error',
    detail: passed ? 'no forbidden terms found' : `found forbidden terms: ${foundTerms.join(', ')}`,
    metadata: { forbiddenTerms: terms, foundTerms },
  }
}

/**
 * Check 1: section_min_bytes
 * Each section's inner HTML must be >= minSectionBytes.
 */
function checkSectionMinBytes(content: string | null, minSectionBytes: number): VerificationCheckResult {
  if (content === null) {
    return failed('section_min_bytes', 'cannot inspect sections because deck was not readable')
  }
  if (minSectionBytes <= 0) {
    return {
      checkId: 'section_min_bytes',
      passed: true,
      severity: 'error',
      detail: 'section_min_bytes check skipped (threshold is 0)',
      metadata: { minSectionBytes },
    }
  }

  const strippedContent = stripHtmlComments(content)
  const sectionInnerHtmls = extractSectionInnerHtmls(strippedContent)

  const thinSections: Array<{ index: number; bytes: number }> = []
  for (let i = 0; i < sectionInnerHtmls.length; i++) {
    const bytes = Buffer.byteLength(sectionInnerHtmls[i]!, 'utf-8')
    if (bytes < minSectionBytes) {
      thinSections.push({ index: i + 1, bytes })
    }
  }

  const passed = thinSections.length === 0
  return {
    checkId: 'section_min_bytes',
    passed,
    severity: 'error',
    detail: passed
      ? `all ${sectionInnerHtmls.length} sections meet minimum ${minSectionBytes} bytes`
      : `${thinSections.length} section(s) below minimum ${minSectionBytes} bytes: ${thinSections.map(s => `section ${s.index} (${s.bytes}B)`).join(', ')}`,
    metadata: { minSectionBytes, thinSections },
  }
}

/**
 * Check 2: section_placeholder_pattern
 * A section whose trimmed inner HTML is ONLY a single h1/h2 element is a placeholder.
 */
function checkSectionPlaceholderPattern(content: string | null): VerificationCheckResult {
  if (content === null) {
    return failed('section_placeholder_pattern', 'cannot inspect sections because deck was not readable')
  }

  const strippedContent = stripHtmlComments(content)
  const sectionInnerHtmls = extractSectionInnerHtmls(strippedContent)

  const placeholderSections: number[] = []
  for (let i = 0; i < sectionInnerHtmls.length; i++) {
    if (ONLY_HEADING_PATTERN.test(sectionInnerHtmls[i]!)) {
      placeholderSections.push(i + 1)
    }
  }

  const passed = placeholderSections.length === 0
  return {
    checkId: 'section_placeholder_pattern',
    passed,
    severity: 'error',
    detail: passed
      ? `no sections contain only a single heading element`
      : `${placeholderSections.length} section(s) contain only a single heading (placeholder pattern): sections ${placeholderSections.join(', ')}`,
    metadata: { placeholderSections },
  }
}

/**
 * Check 3: title_semantic_placeholder
 * Title must not contain semantic placeholder keywords (repaired, demo, tbd, etc.).
 */
function checkTitleSemanticPlaceholder(content: string | null): VerificationCheckResult {
  if (content === null) {
    return failed('title_semantic_placeholder', 'cannot inspect <title> because deck was not readable')
  }
  const title = extractTitle(content)
  if (title === null || title.length === 0) {
    // Missing title is caught by title_placeholder; pass here to avoid double-failing
    return {
      checkId: 'title_semantic_placeholder',
      passed: true,
      severity: 'error',
      detail: 'no title to check for semantic placeholders',
      metadata: {},
    }
  }

  // Only check the semantic patterns (last 2 entries in TITLE_PLACEHOLDER_PATTERNS)
  const semanticPatterns = TITLE_PLACEHOLDER_PATTERNS.filter(p =>
    p.id === 'semantic-placeholder-en' || p.id === 'semantic-placeholder-zh',
  )

  const matched = semanticPatterns.find(entry => entry.pattern.test(title))
  if (matched) {
    return {
      checkId: 'title_semantic_placeholder',
      passed: false,
      severity: 'error',
      detail: `title contains semantic placeholder keyword (${matched.id}): "${title}"`,
      metadata: { title, patternId: matched.id },
    }
  }

  return {
    checkId: 'title_semantic_placeholder',
    passed: true,
    severity: 'error',
    detail: 'title does not contain semantic placeholder keywords',
    metadata: { title },
  }
}

/**
 * Check 4: forbidden_repair_marker
 * Deck must not contain repair-attempt markers in visible heading/title positions.
 */
function checkForbiddenRepairMarker(content: string | null): VerificationCheckResult {
  if (content === null) {
    return failed('forbidden_repair_marker', 'cannot inspect deck because it was not readable')
  }

  const contentNoComments = stripHtmlComments(content)
  const foundMarkers: string[] = []

  for (const term of REPAIR_MARKER_TERMS) {
    const termLower = term.toLocaleLowerCase()
    for (const selectorPattern of REPAIR_MARKER_SELECTORS) {
      for (const match of contentNoComments.matchAll(toGlobalPattern(selectorPattern))) {
        const innerText = match[1]!.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
        if (innerText.includes(termLower)) {
          foundMarkers.push(term)
          break
        }
      }
    }
  }

  const uniqueFound = [...new Set(foundMarkers)]
  const passed = uniqueFound.length === 0
  return {
    checkId: 'forbidden_repair_marker',
    passed,
    severity: 'error',
    detail: passed
      ? 'no repair-attempt markers found in title/headings'
      : `deck contains repair-attempt markers in title/headings: ${uniqueFound.map(m => `"${m}"`).join(', ')}`,
    metadata: { foundMarkers: uniqueFound },
  }
}

/**
 * Extract inner HTML of each <section>…</section> in the content.
 * Uses a simple regex approach — sufficient for well-formed single-file decks.
 */
function extractSectionInnerHtmls(content: string): string[] {
  const results: string[] = []
  const sectionPattern = /<section(?:\s[^>]*)?>(?<inner>[\s\S]*?)<\/section>/gi
  for (const match of content.matchAll(sectionPattern)) {
    results.push(match.groups?.['inner'] ?? '')
  }
  return results
}

function toGlobalPattern(pattern: RegExp): RegExp {
  return pattern.global ? pattern : new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
}

function countSections(content: string): number {
  return [...stripHtmlComments(content).matchAll(/<section(?:\s|>|\/)/gi)].length
}

function extractTitle(content: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(content)
  if (!match) return null
  return match[1]!.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function stripHtmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '')
}

function readOptionalText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

function markerLabel(marker: HtmlDeckRequiredMarker): string {
  return marker.label ?? marker.marker
}

function failed(checkId: string, detail: string, metadata?: Record<string, unknown>): VerificationCheckResult {
  return {
    checkId,
    passed: false,
    severity: 'error',
    detail,
    metadata,
  }
}
