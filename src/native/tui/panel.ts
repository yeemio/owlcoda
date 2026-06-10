/**
 * Full-screen panels — terminal port of the design's `oc-panel` blocks.
 *
 * Three panels share a common chrome:
 *   {accent}OC{reset} {ink-hi bold}{title}{reset}  {ink-dim}{subtitle}
 *   {hairFaint horizontal rule}
 *
 * Sessions panel maps to `oc-sess` (5-col row: mark / title / repo / time / turns).
 * Settings panel maps to `oc-set` (label : value rows + a dashed group separator).
 * MCP panel maps to `oc-mcp` (●/✗/◌ dot + name + desc + tools + act).
 */

import { dim, sgr, stripAnsi, themeColor, themed, visibleWidth } from './colors.js'
import { padRight, truncate, truncateMiddle } from './text.js'

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

export interface SettingsPanelOptions {
  version: string
  model: string
  maxTokens: number
  mode: string
  trace: boolean
  owlcodaHome: string
  apiBaseUrl?: string
  approveMode: 'auto-approve' | 'ask-before-execute'
  theme: string
  alwaysApprovedTools: string[]
  columns?: number
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
function renderGroupTitle(title: string, columns: number): string[] {
  const ruleWidth = Math.min(columns, 96)
  const dash = `${themeColor('hairFaint')}${'┄'.repeat(ruleWidth)}${sgr.reset}`
  return [
    `${themeColor('textDim')}${title.toUpperCase()}${sgr.reset}`,
    dash,
  ]
}

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
    // Status dot mirrors design's `oc-mcp .dot` (success=on, error=err, neutral=subtle)
    const dot = server.status === 'connected'
      ? `${themeColor('success')}●${sgr.reset}`
      : server.status === 'error'
        ? `${themeColor('error')}✗${sgr.reset}`
        : `${themeColor('warning')}◌${sgr.reset}`
    const info = server.serverInfo?.name
      ? ` ${themeColor('textMute')}${server.serverInfo.name}${server.serverInfo.version ? ` v${server.serverInfo.version}` : ''}${sgr.reset}`
      : ''
    lines.push(clip(`${dot}  ${themeColor('text')}${sgr.bold}${server.name}${sgr.reset}${info}`, width))
    if (server.status === 'connected') {
      const tools = server.tools.map((tool) => tool.name).join(', ')
      lines.push(`${themeColor('textDim')}    tools ${server.tools.length}: ${truncate(tools || 'none', Math.max(20, width - 14))}${sgr.reset}`)
      lines.push(`${themeColor('textDim')}    resources ${server.resources.length}${sgr.reset}`)
    } else if (server.error) {
      lines.push(`${themeColor('error')}    ${truncate(server.error.split('\n')[0] ?? '', Math.max(10, width - 4))}${sgr.reset}`)
    }
  }
  lines.push('')
  lines.push(`${themeColor('textDim')}Usage: /mcp reconnect${sgr.reset}`)
  return lines.join('\n')
}

// ─── Settings ────────────────────────────────────────────────

export function renderSettingsPanel(opts: SettingsPanelOptions): string {
  const width = columnsOrDefault(opts.columns)

  // Two row groups separated by a dashed divider — mirrors the design's
  // `oc-set` group title pattern.
  const runtimeRows: Array<[string, string]> = [
    ['Version',    `v${opts.version}`],
    ['Mode',       opts.mode],
    ['Model',      opts.model],
    ['Max tokens', String(opts.maxTokens)],
  ]
  if (opts.apiBaseUrl) {
    runtimeRows.push(['Proxy', opts.apiBaseUrl])
  }
  const uiRows: Array<[string, string]> = [
    ['Theme',   opts.theme],
    ['Trace',   opts.trace ? 'on' : 'off'],
    ['Approve', opts.approveMode],
    ['Home',    opts.owlcodaHome],
  ]

  const lines = [
    ...renderPanelHeader('/settings', 'runtime and UI controls', width),
    ...renderGroupTitle('Runtime', width),
    ...runtimeRows.map(([key, value]) => renderSettingsRow(key, value, width)),
    '',
    ...renderGroupTitle('UI', width),
    ...uiRows.map(([key, value]) => renderSettingsRow(key, value, width)),
    '',
    `${themeColor('textHi')}${sgr.bold}Commands${sgr.reset}`,
    `${themeColor('textDim')}/theme <name> · /approve on|off · /permissions · /config · /login${sgr.reset}`,
  ]

  if (opts.alwaysApprovedTools.length > 0) {
    lines.push('')
    lines.push(`${themeColor('textHi')}${sgr.bold}Always-approved tools${sgr.reset}`)
    lines.push(`${themeColor('textDim')}${truncate(opts.alwaysApprovedTools.join(', '), width)}${sgr.reset}`)
  }

  return lines.map((line) => clip(line, width)).join('\n')
}

function renderSettingsRow(key: string, value: string, width: number): string {
  const labelWidth = 14
  const labelCell = `${themeColor('text')}${padRight(`${key}:`, labelWidth)}${sgr.reset}`
  // Values render in the accent color (mono) to match the design's
  // `.oc-set-row .value { color: var(--accent); font-family: mono }`.
  const valueCell = `${themeColor('owl')}${truncateMiddle(value, Math.max(10, width - labelWidth - 2))}${sgr.reset}`
  // Reference dim alias to keep import live during incremental rollout.
  void dim
  void themed
  return clip(`${labelCell} ${valueCell}`, width)
}
