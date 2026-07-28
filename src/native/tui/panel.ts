/**
 * Full-screen panels — terminal port of the design's `oc-panel` blocks.
 *
 * The panels share a common chrome:
 *   {accent}OC{reset} {ink-hi bold}{title}{reset}  {ink-dim}{subtitle}
 *   {hairFaint horizontal rule}
 *
 * Sessions panel maps to `oc-sess` (5-col row: mark / title / repo / time / turns).
 * MCP panel maps to `oc-mcp` (●/✗/◌ dot + name + desc + tools + act).
 */

import { sgr, stripAnsi, themeColor, visibleWidth } from './colors.js'
import { padRight, truncate } from './text.js'
import stripAnsiSequences from 'strip-ansi'

export interface SessionPanelItem {
  id: string
  title?: string
  turns: unknown[]
  createdAt: string | number | Date
  updatedAt: string | number | Date
  model?: string
}

export interface McpPanelServer {
  name: string
  status: string
  serverInfo?: {
    name?: string
    version?: string
  } | null
  tools: Array<{ name: string }>
  resources: unknown[]
  error?: string
}

export function sanitizeMcpDisplayValue(value: string): string {
  return stripAnsiSequences(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function columnsOrDefault(columns?: number): number {
  return Math.max(60, Math.min(columns ?? process.stdout.columns ?? 100, 120))
}

function clip(line: string, columns: number): string {
  if (visibleWidth(stripAnsi(line)) <= columns) return line
  return truncate(stripAnsi(line), columns)
}

/**
 * Panel header — accent OC monogram + bold ink-hi title + ink-dim subtitle,
 * followed by a hairFaint horizontal rule (matches the design's
 * `oc-panel-head { border-bottom: 1px solid var(--hair-faint) }`).
 */
function renderPanelHeader(title: string, subtitle: string, columns: number): string[] {
  const ruleWidth = Math.min(columns, 96)
  const rule = `${themeColor('hairFaint')}${'─'.repeat(ruleWidth)}${sgr.reset}`
  return [
    `${themeColor('owl')}${sgr.bold}OC${sgr.reset} `
    + `${themeColor('textHi')}${sgr.bold}${title}${sgr.reset} `
    + `${themeColor('textDim')}${subtitle}${sgr.reset}`,
    rule,
  ].map((row) => clip(row, columns))
}

/**
 * Section group title (small caps + dashed underline) — terminal port of
 * `oc-set-group-title { letter-spacing: 0.14em; text-transform: uppercase;
 * border-bottom: 1px dashed var(--hair-faint); }`.
 */
function formatDate(value: string | number | Date): string {
  return new Date(value).toLocaleString()
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function renderEmptyPanel(title: string, subtitle: string, body: string, columns?: number): string {
  const width = columnsOrDefault(columns)
  return [
    ...renderPanelHeader(title, subtitle, width),
    `${themeColor('textMute')}${body}${sgr.reset}`,
  ].join('\n')
}

// ─── Sessions ────────────────────────────────────────────────

export function renderSessionsPanel(
  sessions: SessionPanelItem[],
  opts: { columns?: number; limit?: number; selectedIndex?: number } = {},
): string {
  const width = columnsOrDefault(opts.columns)
  if (sessions.length === 0) {
    return renderEmptyPanel('/sessions', 'saved conversations', 'No saved sessions.', width)
  }

  // Layout (matches `oc-sess` 14px-gap grid):
  //   {▎ accent bar · 1}  {mark · 2}  {title+id · flex}  {turns · 7}  {time · 20}
  const barWidth   = 1
  const markWidth  = 2
  const turnsWidth = 7
  const dateWidth  = 20
  // 2 cells of separator + 1 per gap (4 gaps × 2 = 8) → reserve 9 for whitespace
  const titleWidth = Math.max(20, width - barWidth - markWidth - turnsWidth - dateWidth - 10)

  const limit = opts.limit ?? 10
  const selectedIndex = typeof opts.selectedIndex === 'number'
    ? Math.max(0, Math.min(opts.selectedIndex, Math.min(sessions.length, limit) - 1))
    : -1

  const lines = [
    ...renderPanelHeader('/sessions', `${sessions.length} saved`, width),
    // Column header — small caps in mute ink. Skip the bar column on the
    // header row; it's a per-row affordance.
    `${themeColor('textMute')}${padRight('', barWidth + markWidth)}  `
    + `${padRight('TITLE', titleWidth)}  `
    + `${padRight('TURNS', turnsWidth)}  `
    + `UPDATED${sgr.reset}`,
  ]

  sessions.slice(0, limit).forEach((session, i) => {
    const isSelected = i === selectedIndex
    const id = truncate(session.id, 10)
    const title = truncate(singleLine(session.title ?? '') || 'Untitled', Math.max(8, titleWidth - 12))
    // Selected row: accent ▎ left bar + textHi title + accent dot mark.
    // Unselected: faint vertical bar + textSubtle dot + ink title.
    const bar  = isSelected
      ? `${themeColor('owl')}▎${sgr.reset}`
      : ` `
    const mark = isSelected
      ? `${themeColor('owl')}▸${sgr.reset}`
      : `${themeColor('textSubtle')}·${sgr.reset}`
    const titleColor = isSelected ? themeColor('textHi') : themeColor('text')
    const titleCell = `${titleColor}${title}${sgr.reset} ${themeColor('textDim')}${id}${sgr.reset}`
    const turnsCell = `${themeColor('textDim')}${padRight(`${session.turns.length}t`, turnsWidth)}${sgr.reset}`
    const dateCell  = `${themeColor('textMute')}${truncate(formatDate(session.updatedAt), dateWidth)}${sgr.reset}`
    lines.push(
      clip(`${bar} ${mark}  ${padRight(titleCell, titleWidth + 24)}  ${turnsCell}  ${dateCell}`, width),
    )
  })

  if (sessions.length > limit) {
    lines.push(`${themeColor('textMute')}... and ${sessions.length - limit} more${sgr.reset}`)
  }
  lines.push('')
  lines.push(`${themeColor('textDim')}Usage: /sessions info <id> · /sessions delete <id> · /resume <id>${sgr.reset}`)
  return lines.join('\n')
}

export function renderSessionInfoPanel(session: SessionPanelItem, columns?: number): string {
  const width = columnsOrDefault(columns)
  const rows: Array<[string, string]> = [
    ['ID',       session.id],
    ['Model',    session.model ?? '(unknown)'],
    ['Title',    singleLine(session.title ?? '') || '(none)'],
    ['Turns',    String(session.turns.length)],
    ['Created',  formatDate(session.createdAt)],
    ['Updated',  formatDate(session.updatedAt)],
  ]
  return [
    ...renderPanelHeader('/sessions info', session.id, width),
    ...rows.map(([key, value]) => clip(
      `${themeColor('textDim')}${padRight(`${key}:`, 9)}${sgr.reset} `
      + `${themeColor('text')}${value}${sgr.reset}`,
      width,
    )),
  ].join('\n')
}

// ─── MCP ─────────────────────────────────────────────────────

export function renderMcpPanel(servers: McpPanelServer[], columns?: number): string {
  const width = columnsOrDefault(columns)
  if (servers.length === 0) {
    return renderEmptyPanel(
      '/mcp',
      'model context protocol',
      'No MCP servers configured. Add servers to .mcp.json or ~/.owlcoda/mcp.json.',
      width,
    )
  }

  const lines = renderPanelHeader('/mcp', `${servers.length} server${servers.length === 1 ? '' : 's'}`, width)
  for (const server of servers) {
    const name = sanitizeMcpDisplayValue(server.name)
    // Status dot mirrors design's `oc-mcp .dot` (success=on, error=err, neutral=subtle)
    const dot = server.status === 'connected'
      ? `${themeColor('success')}●${sgr.reset}`
      : server.status === 'error'
        ? `${themeColor('error')}✗${sgr.reset}`
        : `${themeColor('warning')}◌${sgr.reset}`
    const infoName = server.serverInfo?.name ? sanitizeMcpDisplayValue(server.serverInfo.name) : ''
    const infoVersion = server.serverInfo?.version ? sanitizeMcpDisplayValue(server.serverInfo.version) : ''
    const info = infoName
      ? ` ${themeColor('textMute')}${infoName}${infoVersion ? ` v${infoVersion}` : ''}${sgr.reset}`
      : ''
    lines.push(clip(`${dot}  ${themeColor('text')}${sgr.bold}${name}${sgr.reset}${info}`, width))
    if (server.status === 'connected') {
      const tools = server.tools.map((tool) => sanitizeMcpDisplayValue(tool.name)).join(', ')
      lines.push(`${themeColor('textDim')}    tools ${server.tools.length}: ${truncate(tools || 'none', Math.max(20, width - 14))}${sgr.reset}`)
      lines.push(`${themeColor('textDim')}    resources ${server.resources.length}${sgr.reset}`)
    } else if (server.error) {
      lines.push(`${themeColor('error')}    ${truncate(sanitizeMcpDisplayValue(server.error), Math.max(10, width - 4))}${sgr.reset}`)
    }
  }
  lines.push('')
  lines.push(`${themeColor('textDim')}Usage: /mcp reconnect${sgr.reset}`)
  return lines.join('\n')
}
