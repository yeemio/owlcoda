/**
 * Test-assertion-strength lint.
 *
 * Background — issue #6, third piece (private):
 *   Hostile-QA against earlier versions kept finding tests that
 *   advertised wide coverage in their name ("covers all 8 scenarios",
 *   "happy path works", "全部场景") but whose body only asserted the
 *   shape was non-null. Examples we actually saw:
 *     it('covers source=model annotation', () => {
 *       const r = run()
 *       expect(r.source).toBeDefined()  // ← passes for model OR fallback
 *     })
 *
 *   The agent then summarized these as "8 scenarios fully covered",
 *   which the operator believed until they shipped and a real failure
 *   slipped through.
 *
 * What this module DOES:
 *   - Parses `it('name', ...)` / `test('name', ...)` blocks via cheap
 *     regex (no AST) and pulls the body roughly via brace balancing.
 *   - Flags a test when:
 *       (a) its name contains a wide-coverage word (covers, works,
 *           happy path, complete, all, supported, verified, 场景,
 *           覆盖, 全部, …) AND
 *       (b) the body's ONLY `expect(...)` calls use vacuous matchers
 *           (toBeDefined / toBeTruthy / not.toBeNull /
 *           not.toBeUndefined / toBeOk — anything that passes when
 *           the value is bare-defined).
 *   - Returns a list of `{file, testName, line, reason}` warnings.
 *
 * What it does NOT do:
 *   - Run the tests
 *   - Understand semantic equivalence (a test that asserts `r.source`
 *     equals 'model' OR 'fallback' is not vacuous by this lint, but
 *     it's also not strong; that's a higher-tier check we don't try
 *     to do here)
 *   - Walk imports / shared helpers
 *
 * Intentional. False positives are acceptable because the user-facing
 * surface is "warning in the DeliveryAudit report" — the model can
 * acknowledge or refute. False negatives are also acceptable: a stronger
 * lint can be layered later without changing this module.
 */

const WIDE_COVERAGE_PATTERNS = [
  /\bcovers?\b/i,
  /\bwork(?:s|ed|ing)?\b/i,
  /\bhappy[ -]?path\b/i,
  /\ball\s+(?:cases|paths|scenarios|behaviou?rs|tests)\b/i,
  /\bevery\b/i,
  /\bcomplete(?:ly)?\s+(?:cover|verified|tested)/i,
  /\bsupports?\b/i,
  /\bverified\b/i,
  /\bend[ -]?to[ -]?end\b/i,
  /场景/,
  /覆盖/,
  /全部/,
  /(?:验证|验过)/,
]

const VACUOUS_MATCHER_PATTERNS = [
  /\.toBeDefined\s*\(\s*\)/,
  /\.toBeTruthy\s*\(\s*\)/,
  /\.toBeOk\s*\(\s*\)/,
  /\.not\.toBeNull\s*\(\s*\)/,
  /\.not\.toBeUndefined\s*\(\s*\)/,
  /\.toBeNull\s*\(\s*\)/, // toBeNull is also weak — "I expected this to be null and it is" without context
]

const SUBSTANTIVE_MATCHER_PATTERNS = [
  /\.toBe\s*\(/,
  /\.toEqual\s*\(/,
  /\.toStrictEqual\s*\(/,
  /\.toMatch(?:Object)?\s*\(/,
  /\.toContain(?:Equal)?\s*\(/,
  /\.toHaveLength\s*\(/,
  /\.toHaveProperty\s*\(/,
  /\.toThrow(?:Error)?\s*\(/,
  /\.toBeGreaterThan(?:OrEqual)?\s*\(/,
  /\.toBeLessThan(?:OrEqual)?\s*\(/,
  /\.toBeCloseTo\s*\(/,
  /\.toBeInstanceOf\s*\(/,
  /\.toMatchSnapshot\s*\(/,
  /\.toMatchInlineSnapshot\s*\(/,
  /\.rejects\.\w/,
  /\.resolves\.\w/,
]

export interface VacuousAssertionFinding {
  file: string
  testName: string
  line: number
  reason: string
}

export interface LintResult {
  file: string
  testCount: number
  findings: VacuousAssertionFinding[]
}

/**
 * Lint a single test file's content. `filePath` is included in
 * findings for downstream reporting; the function does no fs I/O.
 */
export function lintTestStrength(filePath: string, content: string): LintResult {
  const findings: VacuousAssertionFinding[] = []
  const blocks = extractTestBlocks(content)
  for (const block of blocks) {
    if (!hasWideCoverageName(block.name)) continue
    const expects = countAssertions(block.body)
    if (expects.substantive > 0) continue
    if (expects.vacuous === 0) continue
    findings.push({
      file: filePath,
      testName: block.name,
      line: block.line,
      reason: `wide-coverage test name "${block.name}" but only ${expects.vacuous} vacuous matcher(s) (${expects.matcherList.join(', ')}) and zero substantive assertions`,
    })
  }
  return {
    file: filePath,
    testCount: blocks.length,
    findings,
  }
}

interface TestBlock {
  name: string
  body: string
  line: number
}

/**
 * Extract `it('name', ...)` / `test('name', ...)` blocks via regex +
 * brace balancing. Misses some edge cases (concatenated strings,
 * template literals with embedded braces, nested describes) by design
 * — the lint is heuristic, false negatives are tolerable.
 */
function extractTestBlocks(content: string): TestBlock[] {
  const blocks: TestBlock[] = []
  // Match it('name', or it('name', async or it.skip('name', etc.
  const headerRe = /\b(?:it|test)(?:\.\w+)?\s*\(\s*(['"`])((?:\\.|[^\\])*?)\1\s*,/g
  let match: RegExpExecArray | null
  while ((match = headerRe.exec(content)) !== null) {
    const name = match[2]!
    const cursor = match.index + match[0].length
    const body = extractCallbackBody(content, cursor)
    if (body === null) continue
    const line = content.slice(0, match.index).split('\n').length
    blocks.push({ name, body, line })
  }
  return blocks
}

/**
 * Skip past the callback's parameters and return the body delimited
 * by `{ ... }`. Handles arrow functions and `function` keyword.
 */
function extractCallbackBody(content: string, start: number): string | null {
  let i = start
  // Skip whitespace.
  while (i < content.length && /\s/.test(content[i]!)) i += 1
  // Skip `async`.
  if (content.slice(i, i + 5) === 'async') {
    i += 5
    while (i < content.length && /\s/.test(content[i]!)) i += 1
  }
  // Skip `function` keyword if present.
  if (content.slice(i, i + 8) === 'function') {
    i += 8
    while (i < content.length && /\s/.test(content[i]!)) i += 1
  }
  // Skip parameter list `(...)` or single param.
  if (content[i] === '(') {
    let depth = 1
    i += 1
    while (i < content.length && depth > 0) {
      if (content[i] === '(') depth += 1
      else if (content[i] === ')') depth -= 1
      i += 1
    }
  } else {
    while (i < content.length && /[\w$]/.test(content[i]!)) i += 1
  }
  // Skip `=>` or whitespace before `{`.
  while (i < content.length && /[\s=>]/.test(content[i]!)) i += 1
  if (content[i] !== '{') return null
  // Brace-balanced body extraction. String/comment skipping is partial
  // (template literals with embedded `${...}` and braces would confuse
  // us, but for normal test bodies this is fine).
  return extractBracedBlock(content, i)
}

function extractBracedBlock(content: string, start: number): string | null {
  if (content[start] !== '{') return null
  let i = start + 1
  let depth = 1
  while (i < content.length && depth > 0) {
    const ch = content[i]
    if (ch === '{') {
      depth += 1
      i += 1
    } else if (ch === '}') {
      depth -= 1
      i += 1
    } else if (ch === '\'' || ch === '"' || ch === '`') {
      i = skipString(content, i)
    } else if (ch === '/' && content[i + 1] === '/') {
      while (i < content.length && content[i] !== '\n') i += 1
    } else if (ch === '/' && content[i + 1] === '*') {
      i += 2
      while (i < content.length - 1 && !(content[i] === '*' && content[i + 1] === '/')) i += 1
      i += 2
    } else {
      i += 1
    }
  }
  if (depth !== 0) return null
  return content.slice(start + 1, i - 1)
}

function skipString(content: string, start: number): number {
  const quote = content[start]
  let i = start + 1
  while (i < content.length) {
    const ch = content[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === quote) {
      return i + 1
    }
    if (quote === '`' && ch === '$' && content[i + 1] === '{') {
      // Template literal interpolation — skip braced expression.
      let depth = 1
      i += 2
      while (i < content.length && depth > 0) {
        if (content[i] === '{') depth += 1
        else if (content[i] === '}') depth -= 1
        i += 1
      }
      continue
    }
    i += 1
  }
  return i
}

interface AssertionCounts {
  substantive: number
  vacuous: number
  matcherList: string[]
}

function countAssertions(body: string): AssertionCounts {
  let substantive = 0
  let vacuous = 0
  const matcherList: string[] = []
  for (const re of SUBSTANTIVE_MATCHER_PATTERNS) {
    const matches = body.match(new RegExp(re.source, 'g'))
    if (matches) {
      substantive += matches.length
      for (const m of matches) {
        const trimmed = m.replace(/\s*\(.*$/, '').replace(/^\./, '')
        if (!matcherList.includes(trimmed)) matcherList.push(trimmed)
      }
    }
  }
  for (const re of VACUOUS_MATCHER_PATTERNS) {
    const matches = body.match(new RegExp(re.source, 'g'))
    if (matches) {
      vacuous += matches.length
      for (const m of matches) {
        const trimmed = m.replace(/\s*\(.*$/, '').replace(/^\./, '')
        if (!matcherList.includes(trimmed)) matcherList.push(trimmed)
      }
    }
  }
  return { substantive, vacuous, matcherList }
}

function hasWideCoverageName(name: string): boolean {
  for (const re of WIDE_COVERAGE_PATTERNS) {
    if (re.test(name)) return true
  }
  return false
}
