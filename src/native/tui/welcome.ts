/**
 * OwlCoda TUI Welcome Banner
 *
 * Compact first-screen identity block. Adapts to terminal width and keeps
 * live project/session truth visible without turning the transcript into a
 * large framed splash screen.
 *
 * Features theme-aware coloring: the owl art picks up the active
 * brand color for eyes and accent lines.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { sgr, themeColor, themed, dim } from './colors.js'
import { padRight, truncate } from './text.js'
import { visibleWidth, stripAnsi } from './colors.js'
import { formatMarker } from './message.js'

// ─── Onboarding hero ─────────────────────────────────────────
//
// Terminal port of the design's `oc-onboarding` first-run screen:
//
//   {owl art}     OwlCoda v0.13.0
//                 terminal coding agent, in your shell
//   ─────────────────────────────────────────────────────────
//   01  Try a slash command          type / to see all commands
//   02  Reference a file             type @ to attach from your repo
//   03  Switch model                 /model opens the picker
//   04  Manage settings              /settings · /theme · /mcp
//   ─────────────────────────────────────────────────────────
//   ↵  send                          ⌃C  interrupt
//   ⇧↵ newline                       ⌃L  clear
//
// The owl art is reused verbatim from `renderLogo` — same Braille glyph
// the product ships in welcome.ts since the CLI's first version.

interface OnboardingStep {
  title: string
  desc: string
}

const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  { title: 'Ask anything',        desc: 'OwlCoda reads, writes, and runs code for you' },
  { title: 'See every command',   desc: 'type / or /help to browse the slash palette' },
  { title: 'Reference a file',    desc: 'type @ to attach a file from your repo' },
  { title: 'Switch model',        desc: '/model opens the picker · /why-native explains the runtime' },
  { title: 'Manage settings',     desc: '/settings · /theme · /mcp · /permissions' },
]

const ONBOARDING_HOTKEYS: ReadonlyArray<{ key: string; desc: string }> = [
  { key: '↵',  desc: 'send'      },
  { key: '⇧↵', desc: 'newline'   },
  { key: '⌃C', desc: 'interrupt' },
  { key: '⌃L', desc: 'clear'     },
  { key: '⌃,', desc: 'settings'  },
  { key: '⌃D', desc: 'quit'      },
]

function renderOnboardingHeroLines(opts: WelcomeOptions, columns: number): string[] {
  const width = Math.max(40, Math.min(columns, 96))
  const art = renderLogo(opts.logoFrame ?? 'dot-left')
  const artWidth = art.reduce((max, line) => Math.max(max, visibleWidth(stripAnsi(line))), 0)

  // ── Hero block ─────────────────────────────────────────────
  // Right column: brand h1 (textHi bold) + version dim + lede textDim.
  // Lowercase "owlcoda" matches the wordmark already used by the
  // compact welcome and the rest of the product chrome.
  const brand = `${themeColor('textHi')}${sgr.bold}owlcoda${sgr.reset} `
    + `${themeColor('textDim')}v${opts.version}${sgr.reset}`
  const lede  = `${themeColor('textDim')}terminal coding agent, in your shell${sgr.reset}`

  const heroRightLines = ['', brand, lede, '']
  const heroRowCount = Math.max(art.length, heroRightLines.length)
  const hero: string[] = []
  for (let i = 0; i < heroRowCount; i++) {
    const left = art[i] ? padRight(art[i]!, artWidth) : ' '.repeat(artWidth)
    const right = heroRightLines[i] ?? ''
    hero.push(`${left}    ${right}`)
  }

  // ── Hair-faint divider ─────────────────────────────────────
  const rule = `${themeColor('hairFaint')}${'─'.repeat(width)}${sgr.reset}`

  // ── Counter-stepped list ───────────────────────────────────
  // Each row: `01  Try a slash command          type / to see all commands`
  // - counter in accent (mono, leading-zero per CSS counter(decimal-leading-zero))
  // - title in ink
  // - desc in mute
  const titleCol = Math.max(20, Math.min(28, Math.floor(width * 0.32)))
  const descCol  = Math.max(16, width - titleCol - 6)
  const stepLines: string[] = []
  ONBOARDING_STEPS.forEach((step, i) => {
    const counter = `${themeColor('owl')}${String(i + 1).padStart(2, '0')}${sgr.reset}`
    const title   = padRight(`${themeColor('text')}${truncate(step.title, titleCol)}${sgr.reset}`, titleCol + 12)
    const desc    = `${themeColor('textMute')}${truncate(step.desc, descCol)}${sgr.reset}`
    stepLines.push(`  ${counter}  ${title}${desc}`)
  })

  // ── Hotkeys grid (2 columns) ───────────────────────────────
  // Each cell: `{key in accent}  {desc in dim}` — paired into rows.
  const hotkeyCellWidth = Math.max(20, Math.floor(width / 2) - 2)
  const hotkeyLines: string[] = []
  for (let i = 0; i < ONBOARDING_HOTKEYS.length; i += 2) {
    const left  = formatHotkeyCell(ONBOARDING_HOTKEYS[i]!, hotkeyCellWidth)
    const right = ONBOARDING_HOTKEYS[i + 1]
      ? formatHotkeyCell(ONBOARDING_HOTKEYS[i + 1]!, hotkeyCellWidth)
      : ''
    hotkeyLines.push(`  ${left}    ${right}`)
  }

  return [
    ...hero,
    rule,
    '',
    ...stepLines,
    '',
    rule,
    '',
    ...hotkeyLines,
  ]
}

function formatHotkeyCell(entry: { key: string; desc: string }, width: number): string {
  const key = `${themeColor('owl')}${sgr.bold}${entry.key}${sgr.reset}`
  const keyWidth = visibleWidth(stripAnsi(key))
  const descBudget = Math.max(6, width - keyWidth - 2)
  const desc = `${themeColor('textDim')}${truncate(entry.desc, descBudget)}${sgr.reset}`
  return `${key}  ${desc}`
}

/** Render the full first-run onboarding hero. Public so callers can opt
 *  in explicitly when they want the long form (e.g. `/help` could reuse
 *  it later without going through the renderWelcome routing). */
export function renderOnboardingHero(opts: WelcomeOptions): string {
  const columns = opts.columns ?? (process.stdout.columns || 100)
  return renderOnboardingHeroLines(opts, columns).join('\n')
}

// ─── Owl ASCII art ────────────────────────────────────────────

export type LogoFrame = 'dot-left' | 'dot-left-mid' | 'dot-mid' | 'dot-right-mid' | 'dot-right'

const WELCOME_TITLE_ICON_COLS = 2
const WELCOME_TITLE_ICON_ROWS = 1

export const WELCOME_TITLE_ICON_PATH = fileURLToPath(
  new URL('../../../assets/branding/oc-title-icon.png', import.meta.url),
)

export interface WelcomeTitleIconPlacement {
  path: string
  rowOffset: number
  colOffset: number
  cols: number
  rows: number
}

export interface WelcomeMarkerOptions {
  cwd: string
  branch?: string | null
  pendingChanges?: number | null
}

export function supportsTerminalImages(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env['KITTY_WINDOW_ID']
    || env['TERM_PROGRAM'] === 'ghostty'
    || env['TERM']?.includes('kitty'),
  )
}

export function hasTitleIconAsset(path = WELCOME_TITLE_ICON_PATH): boolean {
  return existsSync(path)
}

/** Eye-overlay positions, kept available for callers that want them but
 *  NOT applied by default. We tried both single-eye and dual-eye static
 *  overlays; in every monospace terminal the available glyphs (`⬤` U+2B24
 *  is the largest filled circle in Unicode) render too small relative to
 *  the Braille body to read as actual eyes. Stacking glyphs to fake size
 *  reads as cartoonish, not as an owl. The honest fix would be a font
 *  that ships an oversized eye glyph — outside our scope.
 *
 *  Default render: no overlay, abstract Braille silhouette only. The
 *  `withDot=true` opt-in still exists for the legacy 5-frame animation
 *  cycle (singleEye=true) if a caller ever wants to revive it. */
const DEFAULT_EYE_POSITIONS: ReadonlyArray<[number, number, number]> = []

function renderLogo(
  frame: LogoFrame,
  opts: { withDot?: boolean; singleEye?: boolean } = {},
): string[] {
  const main = themeColor('owl')
  const accent = themeColor('owlShimmer')
  const reset = sgr.reset
  const rows = [
    '⢦⣤⣀⣠⣤⣤⣤⣀ ⣠⣶⣿⣿⣿⣶⣄⣤⡶',
    ' ⣻⣿⣿⠿⠿⢿⣿⣿⣿⡿⠛⠛⠛⢿⣿⣿⠄',
    '⢠⣿⡟⠁   ⠙⣿⣿⠁    ⠉⠁ ',
    '⢸⣿⡁     ⣿⣷        ',
    '⠸⣿⣇     ⣿⣿⣦⣀ ⢀⣴⣿⣦ ',
    ' ⢻⣿⣷⣄⣀⣀⣀⡈⠻⢿⣿⣿⣿⣿⠟⠁ ',
    '  ⠙⢿⣿⣿⣿⣿⣿⣿⣶⣦⣤⡤⠖   ',
    '    ⠙⠻⠿⣿⣿⣿⡛⠛⠂     ',
  ]
  // Eye-dot positions across the 5 animation frames. Used only when
  // singleEye=true (the legacy gaze-tracking effect).
  const dotPositions: Record<LogoFrame, [number, number]> = {
    'dot-left': [3, 3],
    'dot-left-mid': [3, 5],
    'dot-mid': [3, 7],
    'dot-right-mid': [3, 10],
    'dot-right': [3, 12],
  }

  // Resolve eye positions:
  //   default        → two static WIDE eyes (DEFAULT_EYE_POSITIONS) — each
  //                    eye spans 2 cells so it reads as a real eye, not a
  //                    punctuation dot.
  //   singleEye=true → original single-cell animation frame (1-cell wide).
  //   withDot=false  → no overlay, abstract Braille only.
  const noEyes = opts.withDot === false
  const eyePositions: ReadonlyArray<[number, number, number]> = noEyes
    ? []
    : opts.singleEye
      ? [[dotPositions[frame][0], dotPositions[frame][1], 1]]
      : DEFAULT_EYE_POSITIONS

  const overlayRows = eyePositions.length === 0
    ? rows
    : rows.map((row, index) => {
        const eyesHere = eyePositions.filter(([r]) => r === index)
        if (eyesHere.length === 0) return row
        const chars = Array.from(row)
        for (const [, startCol, width] of eyesHere) {
          for (let i = 0; i < width; i++) {
            const c = startCol + i
            if (c >= 0 && c < chars.length) chars[c] = '⬤'
          }
        }
        return chars.join('')
      })

  return overlayRows.map((row) => Array.from(row).map((ch) => {
    if (ch === '⬤') return `${sgr.bold}${accent}${ch}${reset}`
    if (ch === ' ') return ch
    return `${main}${ch}${reset}`
  }).join(''))
}

/**
 * OwlCoda mark rendered as a fixed-size product icon.
 * We deliberately keep it small and simple so it still reads cleanly on large
 * terminals instead of turning into a giant blocky mascot.
 */
function owlArtLarge(frame: LogoFrame): string[] {
  return owlArtSmall(frame)
}

/** Compact owl for narrow terminals. */
function owlArtSmall(frame: LogoFrame): string[] {
  return renderLogo(frame)
}

// ─── Layout ───────────────────────────────────────────────────

const MIN_HORIZONTAL_WIDTH = 70
// First-run hero is ~21 rows. Gate it to wider terminals so 80x30 still
// shows the full welcome/marker/composer/rail in the first viewport.
const FIRST_RUN_HERO_MIN_WIDTH = 96

export type LayoutMode = 'horizontal' | 'compact'

export interface WelcomeOptions {
  version: string
  model: string
  mode: string
  sessionId: string
  cwd: string
  /** User display name (optional). */
  username?: string
  /** True on the very first launch (no prior sessions). Affects greeting copy. */
  isFirstRun?: boolean
  /** Recent sessions for the feed column. */
  recentSessions?: Array<{
    id: string
    title?: string
    turns: number
    date: string
  }>
  /** Tips to show in the right column. */
  tips?: string[]
  /** Terminal width override (default: process.stdout.columns). */
  columns?: number
  /** Optional welcome-mark frame, used for the idle dot animation. */
  logoFrame?: LogoFrame
}

/**
 * Render the compact welcome block.
 */
export function renderWelcome(opts: WelcomeOptions): string {
  const columns = opts.columns ?? (process.stdout.columns || 100)

  // First-run gets the full onboarding hero (design's `oc-onboarding`):
  // owl + brand h1 + lede, hair-faint rule, counter-stepped steps,
  // hair-faint rule, 2-column hotkeys grid. We only do this when there
  // are no recent sessions — returning users see the compact welcome
  // they're already used to.
  if (opts.isFirstRun && columns >= FIRST_RUN_HERO_MIN_WIDTH) {
    return renderOnboardingHero(opts)
  }

  const layout: LayoutMode = columns >= MIN_HORIZONTAL_WIDTH ? 'horizontal' : 'compact'
  const banner = layout === 'horizontal'
    ? renderHorizontal(opts, columns)
    : renderCompact(opts, columns)

  return centerBanner(banner, columns)
}

export function getWelcomeTitleIconPlacement(opts: WelcomeOptions): WelcomeTitleIconPlacement {
  void opts

  return {
    path: WELCOME_TITLE_ICON_PATH,
    rowOffset: 0,
    colOffset: 0,
    cols: WELCOME_TITLE_ICON_COLS,
    rows: WELCOME_TITLE_ICON_ROWS,
  }
}

export function readWelcomeMarkerOptions(cwd: string = process.cwd()): WelcomeMarkerOptions {
  return {
    cwd,
    branch: readGitBranch(cwd),
    pendingChanges: readGitPendingChangeCount(cwd),
  }
}

export function formatWelcomeMarker(opts: WelcomeMarkerOptions): string {
  const parts = [`CWD ${formatCwd(opts.cwd).toUpperCase()}`]
  if (opts.branch) {
    parts.push(`BRANCH ${opts.branch.toUpperCase()}`)
  }
  if (typeof opts.pendingChanges === 'number') {
    parts.push(opts.pendingChanges === 0
      ? 'NO PENDING CHANGES'
      : `${opts.pendingChanges} PENDING CHANGE${opts.pendingChanges === 1 ? '' : 'S'}`)
  }
  return formatMarker(parts.join(' · '), 'info')
}

// ─── Horizontal ───────────────────────────────────────────────

function renderHorizontal(opts: WelcomeOptions, columns: number): string {
  const width = Math.min(columns, 118)
  return buildWelcomeLines(opts, width, 'horizontal').join('\n')
}

// ─── Compact ─────────────────────────────────────────────────

function renderCompact(opts: WelcomeOptions, columns: number): string {
  const width = Math.min(columns, 60)
  return buildWelcomeLines(opts, width, 'compact').join('\n')
}

function centerBanner(banner: string, columns: number): string {
  void columns
  return banner
}

// ─── Line builders ────────────────────────────────────────────

function buildWelcomeLines(opts: WelcomeOptions, width: number, layout: LayoutMode): string[] {
  // Brand uses textHi (highest-contrast ink) — matches the design's
  // onboarding hero `h1 { color: var(--ink-hi) }`. The version sits dim
  // beside it so it reads as metadata, not part of the wordmark.
  const brand = `${themeColor('textHi')}${sgr.bold}owlcoda${sgr.reset} ${dim(`v${opts.version}`)}`
  const hotkeys = opts.isFirstRun
    ? `${themed('/help', 'owl')} commands · ${themed('/why-native', 'owl')} guide · ${themed('@', 'owl')} files`
    : layout === 'horizontal'
      ? `${themed('/help', 'owl')} for commands · ${themed('@', 'owl')} for files · ${themed('Shift+Enter', 'owl')} newline`
      : `${themed('/help', 'owl')} · ${themed('@', 'owl')} files · ${themed('Shift+Enter', 'owl')}`
  const infoLines = [
    truncateAnsi(brand, Math.max(20, width)),
    dim(truncate(hotkeys, width)),
  ]
  if (opts.isFirstRun) {
    // Lede uses ink-dim (textDim) per design; sits one line below the hotkey row.
    infoLines.push(`${themeColor('textDim')}${truncate('terminal coding agent, in your shell', width)}${sgr.reset}`)
  }

  const art = owlArtSmall(opts.logoFrame ?? 'dot-left')
  if (layout === 'compact') {
    return [...art, ...infoLines.map((line) => clipAnsi(line, width))]
  }

  // Offset info by one row so the wordmark lands on owl row 2. Ink's
  // Static pipeline can steal owl row 1 on narrow tmux panes (80x30);
  // keeping the wordmark off row 1 preserves identity in that case and
  // mirrors the onboarding hero's blank-top-row rhythm at wider widths.
  const offsetInfoLines = ['', ...infoLines]
  const artWidth = art.reduce((max, line) => Math.max(max, visibleWidth(stripAnsi(line))), 0)
  const textWidth = Math.max(24, width - artWidth - 3)
  const rows = Math.max(art.length, offsetInfoLines.length)
  const merged: string[] = []
  for (let i = 0; i < rows; i++) {
    const left = art[i] ? padRight(art[i]!, artWidth) : ' '.repeat(artWidth)
    const right = offsetInfoLines[i] ? clipAnsi(offsetInfoLines[i]!, textWidth) : ''
    merged.push(clipAnsi(`${left}  ${right}`, width))
  }
  return merged
}

function truncateAnsi(text: string, width: number): string {
  if (visibleWidth(stripAnsi(text)) <= width) return text
  return truncate(stripAnsi(text), width)
}

function clipAnsi(text: string, width: number): string {
  return visibleWidth(stripAnsi(text)) <= width ? text : truncateAnsi(text, width)
}

function formatCwd(cwd: string): string {
  const home = process.env['HOME']
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) {
    return `~${cwd.slice(home.length)}`
  }
  return cwd
}

function readGitBranch(cwd: string): string | null {
  const gitDir = findGitDir(cwd)
  if (!gitDir) return null
  try {
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    if (head.startsWith('ref: refs/heads/')) return head.slice('ref: refs/heads/'.length)
    return `${head.slice(0, 8)} detached`
  } catch {
    return null
  }
}

function readGitPendingChangeCount(cwd: string): number | null {
  if (!findGitDir(cwd)) return null
  try {
    const status = execFileSync('git', ['status', '--short'], {
      cwd,
      encoding: 'utf8',
      timeout: 600,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (!status) return 0
    return status.split('\n').filter(Boolean).length
  } catch {
    return null
  }
}

function findGitDir(start: string): string | null {
  let dir = start
  for (let i = 0; i < 12; i++) {
    const dotGit = path.join(dir, '.git')
    if (existsSync(dotGit)) {
      try {
        const stat = statSync(dotGit)
        if (stat.isDirectory()) return dotGit
        if (stat.isFile()) {
          const match = readFileSync(dotGit, 'utf8').trim().match(/^gitdir:\s*(.+)$/)
          if (match?.[1]) return path.resolve(dir, match[1])
        }
      } catch {
        return null
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}
