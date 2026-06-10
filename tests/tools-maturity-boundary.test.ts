import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ToolDispatcher } from '../src/native/dispatch.js'
import { buildNativeToolDefs, NATIVE_TOOL_SCHEMAS } from '../src/native/tool-defs.js'

type Maturity = 'production' | 'beta' | 'stub' | 'experimental'

interface ToolRow {
  name: string
  maturity: Maturity
  realIo: string
  notes: string
}

const REPO_ROOT = join(import.meta.dirname, '..')
const TOOLS_DOC = join(REPO_ROOT, 'docs', 'TOOLS.md')
// The public GPL source tree ships no docs/ (public-mirror manifest denies all
// of docs/**), so the doc-sync assertions below are private-repo guards. The
// honest-stub-disclosure test reads only code and runs everywhere.
const HAS_TOOLS_DOC = existsSync(TOOLS_DOC)

function normalizeMaturity(raw: string): Maturity {
  const lower = raw.toLowerCase()
  if (lower.startsWith('production')) return 'production'
  if (lower.startsWith('beta')) return 'beta'
  if (lower.startsWith('stub')) return 'stub'
  if (lower.startsWith('experimental')) return 'experimental'
  throw new Error(`Unknown maturity value in docs/TOOLS.md: ${raw}`)
}

function parseToolRows(markdown: string): ToolRow[] {
  const start = markdown.indexOf('## Tool-by-tool')
  const end = markdown.indexOf('### Infrastructure', start)
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('docs/TOOLS.md must contain a Tool-by-tool table before Infrastructure')
  }

  return markdown
    .slice(start, end)
    .split('\n')
    .filter(line => line.startsWith('| '))
    .filter(line => !line.startsWith('| Name ') && !line.startsWith('| --- '))
    .map((line) => {
      const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
      if (cells.length < 6) {
        throw new Error(`Malformed docs/TOOLS.md tool row: ${line}`)
      }
      return {
        name: cells[0]!,
        maturity: normalizeMaturity(cells[2]!),
        realIo: cells[3]!,
        notes: cells[5]!,
      }
    })
}

function parseSummaryCounts(markdown: string): Record<Maturity, number> {
  const counts: Partial<Record<Maturity, number>> = {}
  const pattern = /^- \*\*(production|beta|stub|experimental)\*\*: (\d+)/gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(markdown)) !== null) {
    counts[match[1] as Maturity] = Number.parseInt(match[2]!, 10)
  }
  return {
    production: counts.production ?? -1,
    beta: counts.beta ?? -1,
    stub: counts.stub ?? -1,
    experimental: counts.experimental ?? -1,
  }
}

function countRowsByMaturity(rows: ToolRow[]): Record<Maturity, number> {
  return rows.reduce<Record<Maturity, number>>((acc, row) => {
    acc[row.maturity] += 1
    return acc
  }, { production: 0, beta: 0, stub: 0, experimental: 0 })
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b))
}

describe('native tool maturity and registration boundary', () => {
  it.skipIf(!HAS_TOOLS_DOC)('documents every schema surface and the current default registration count', async () => {
    const markdown = await readFile(TOOLS_DOC, 'utf-8')
    const rows = parseToolRows(markdown)
    const rowNames = rows.map(row => row.name)
    const schemaNames = Object.keys(NATIVE_TOOL_SCHEMAS)

    expect(new Set(rowNames).size).toBe(rowNames.length)
    expect(sorted(rowNames)).toEqual(sorted(schemaNames))

    const dispatcher = new ToolDispatcher()
    const registeredNames = dispatcher.getToolNames()
    const advertisedNames = buildNativeToolDefs(dispatcher).map(def => def.name)

    expect(advertisedNames).toEqual(registeredNames)
    expect(registeredNames).toHaveLength(45)
    expect(schemaNames).toHaveLength(47)

    const schemaOnlyRows = rows
      .filter(row => !registeredNames.includes(row.name))
      .map(row => row.name)

    expect(sorted(schemaOnlyRows)).toEqual(['Agent', 'REPL'])
    expect(markdown).toContain('45 registered tool_defs')
    expect(markdown).toContain('47 schema rows')
  })

  it.skipIf(!HAS_TOOLS_DOC)('keeps docs summary counts aligned with the tool-by-tool table', async () => {
    const markdown = await readFile(TOOLS_DOC, 'utf-8')
    const rows = parseToolRows(markdown)

    expect(parseSummaryCounts(markdown)).toEqual(countRowsByMaturity(rows))
    expect(parseSummaryCounts(markdown)).toEqual({
      production: 13,
      beta: 26,
      stub: 3,
      experimental: 5,
    })
  })

  it.skipIf(!HAS_TOOLS_DOC)('does not count stub or orphan surfaces as production', async () => {
    const markdown = await readFile(TOOLS_DOC, 'utf-8')
    const rows = parseToolRows(markdown)
    const rowsByName = new Map(rows.map(row => [row.name, row]))
    const registered = new Set(new ToolDispatcher().getToolNames())

    for (const row of rows) {
      const riskText = `${row.realIo} ${row.notes}`.toLowerCase()
      const documentedStubOrOrphan =
        row.maturity === 'stub' ||
        /\bstub\b|\borphan\b|not default-registered|not registered|no scheduler|rubber-stamp/.test(riskText)

      if (documentedStubOrOrphan) {
        expect(row.maturity, `${row.name} is documented as stub/orphan-like`).not.toBe('production')
      }

      if (row.maturity === 'production') {
        expect(registered.has(row.name), `${row.name} is production but not default-registered`).toBe(true)
        expect(riskText, `${row.name} production notes should not disclose stub/orphan behavior`)
          .not.toMatch(/\bstub\b|\borphan\b|not default-registered|not registered|no scheduler|rubber-stamp/)
      }
    }

    for (const name of ['SendMessage', 'ScheduleCron', 'McpAuth', 'RemoteTrigger', 'LSP', 'REPL']) {
      expect(rowsByName.get(name)?.maturity, `${name} is an ADR-007 stub/orphan boundary`).not.toBe('production')
    }
  })

  it('passes honest registered stub descriptions through to advertised tool_defs', () => {
    const defsByName = new Map(
      buildNativeToolDefs(new ToolDispatcher()).map(def => [def.name, def.description]),
    )

    const expectedDisclosures: Array<[string, RegExp]> = [
      ['SendMessage', /no consumer wired up|not real inter-agent communication/i],
      ['ScheduleCron', /no cron daemon|scheduler thread|will never fire/i],
      ['McpAuth', /not validated|rubber-stamps/i],
    ]

    for (const [name, pattern] of expectedDisclosures) {
      const description = defsByName.get(name)
      expect(description).toBeDefined()
      expect(description).not.toBe(`Native ${name} tool`)
      expect(description).toMatch(pattern)
    }
  })
})
