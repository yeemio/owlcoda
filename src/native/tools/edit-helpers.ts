/**
 * Edit-tool helpers (0.13.59) — line-ending detection + fuzzy match.
 *
 * Background. Pre-0.13.59 the edit tool returned `Error: oldStr not
 * found in <path>` with no further information. The model couldn't
 * tell whether the miss was due to whitespace, surrounding context,
 * or — the case that bit us in the sieracMes-AI dogfood — a CRLF
 * file read against an LF oldStr. The model then made several edits
 * with slightly varied oldStr, all silently mismatching the same
 * way, until the soft loop intercept kicked in.
 *
 * 0.13.59 enriches the error message with two diagnostics:
 *   1. Line-ending mismatch: if the file uses CRLF and oldStr appears
 *      to use LF (or has no newline), state that explicitly and tell
 *      the model how to fix.
 *   2. Closest-match candidates: top-3 lines from the file with the
 *      smallest Levenshtein distance to oldStr's first non-empty
 *      line. Caps both line length and search length at 80 chars to
 *      stay cheap on big files.
 *
 * 'C-non-aggressive': we do NOT silently normalize line endings in
 * the edit tool itself. The diagnostic is enough; if the operator
 * wants normalization they re-read the file (which now annotates
 * line endings) and emit a CRLF-aware oldStr.
 */

export type LineEndingKind = 'LF' | 'CRLF' | 'mixed' | 'none'

/** Detect the dominant line ending in a string. */
export function detectLineEnding(content: string): LineEndingKind {
  if (content.length === 0) return 'none'
  const hasCRLF = /\r\n/.test(content)
  // LF without preceding CR — explicit lookbehind so CRLF doesn't
  // double-count as both CRLF and LF.
  const hasLF = /(?<!\r)\n/.test(content)
  if (hasCRLF && hasLF) return 'mixed'
  if (hasCRLF) return 'CRLF'
  if (hasLF) return 'LF'
  return 'none'
}

export interface FuzzyMatch {
  /** 1-based line number in the original content. */
  lineNumber: number
  /** Levenshtein distance between needle (truncated) and line (truncated). */
  distance: number
  /** Truncated preview of the line, ≤80 chars. */
  preview: string
}

/**
 * Find the top-N lines in `content` that look most like `oldStr`'s
 * first non-empty line. Returns at most `topN` results sorted by
 * distance ascending. Empty array if no candidates pass the
 * similarity threshold (>50% relative distance is rejected).
 *
 * Caps:
 *   - oldStr's first-non-empty line is truncated to 80 chars before
 *     comparison (full Levenshtein on long oldStrs would be slow).
 *   - Each file line is similarly truncated.
 *   - Files with millions of lines are still O(N×80²) per call;
 *     practical files (<100K lines) finish in well under 100ms.
 */
export function findFuzzyMatches(
  content: string,
  oldStr: string,
  topN: number,
): FuzzyMatch[] {
  const oldLines = oldStr.split(/\r?\n/)
  const needleLine = oldLines.find((l) => l.trim().length > 0) ?? oldStr
  const needle = needleLine.trim().slice(0, 80)
  // Lines shorter than 4 chars rarely produce useful "did you mean"
  // matches — too many spurious near-misses.
  if (needle.length < 4) return []

  const fileLines = content.split(/\r?\n/)
  const scored: FuzzyMatch[] = []

  for (let i = 0; i < fileLines.length; i++) {
    const rawLine = fileLines[i] ?? ''
    const line = rawLine.trim()
    if (line.length === 0) continue
    const truncatedLine = line.slice(0, 80)
    const distance = levenshtein(needle, truncatedLine)
    const denom = Math.max(needle.length, truncatedLine.length, 1)
    if (distance / denom > 0.5) continue
    scored.push({
      lineNumber: i + 1,
      distance,
      preview: rawLine.length > 80 ? rawLine.slice(0, 77) + '...' : rawLine,
    })
  }

  scored.sort((a, b) => a.distance - b.distance)
  return scored.slice(0, topN)
}

/**
 * Build the structured "oldStr not found" error message with
 * line-ending diagnostic + fuzzy-match suggestions.
 */
export function buildOldStrNotFoundError(
  filePath: string,
  fileContent: string,
  oldStr: string,
): string {
  const fileEnding = detectLineEnding(fileContent)
  const oldStrEnding = detectLineEnding(oldStr)

  const lines: string[] = [`Error: oldStr not found in ${filePath}.`]

  // CRLF-vs-LF mismatch hint. This is the specific failure mode that
  // bit us in the sieracMes-AI dogfood (admin_routes.py was CRLF, the
  // model's oldStr was LF, every edit silently missed).
  if (fileEnding === 'CRLF' && (oldStrEnding === 'LF' || oldStrEnding === 'none')) {
    lines.push(
      'Hint: the file uses CRLF line endings (\\r\\n), but your oldStr ' +
      'appears to use LF (\\n) or has no newline. Either re-read the ' +
      'file (the read tool annotates line endings) and copy the exact ' +
      'CRLF block into oldStr, or pick a single-line oldStr that has no ' +
      'newline at all.',
    )
  } else if (fileEnding === 'mixed') {
    lines.push(
      'Hint: the file has MIXED line endings (some lines end in CRLF, ' +
      'others in LF). Pick an oldStr that does not span a line boundary, ' +
      'or write the file fresh to normalize.',
    )
  }

  const candidates = findFuzzyMatches(fileContent, oldStr, 3)
  if (candidates.length > 0) {
    lines.push('')
    lines.push(`Closest matches in file (oldStr first-line length ${oldStr.split(/\r?\n/)[0]?.length ?? 0}):`)
    for (const c of candidates) {
      lines.push(`  line ${c.lineNumber} (Δ${c.distance}): ${c.preview}`)
    }
    lines.push('')
    lines.push(
      'If one of these is the line you meant, re-read the surrounding ' +
      'context with `read({path, startLine: N-2, endLine: N+5})` and ' +
      'copy the exact bytes into oldStr.',
    )
  } else {
    lines.push(
      'No similar lines found. The text you tried to edit may not exist ' +
      'in this file at all — re-read the file before retrying.',
    )
  }

  return lines.join('\n')
}

/**
 * Levenshtein distance with two-row matrix (O(min(m,n)) space).
 * Both inputs already truncated by the caller; no further capping
 * here.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  const m = a.length
  const n = b.length
  let prev = new Array<number>(n + 1)
  let curr = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      )
    }
    const tmp = prev
    prev = curr
    curr = tmp
  }
  return prev[n] ?? 0
}
