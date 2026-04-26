/**
 * OwlCoda TUI Permission Prompt
 *
 * Rich permission request dialogs with:
 * - Full bordered dialog (for standalone prompts)
 * - Top-border-only dialog for compact approval prompts
 * - Per-tool-type renderers (bash, file, web)
 * - Inline compact prompt for readline contexts
 */

import { sgr, themeColor, themed, dim, visibleWidth } from './colors.js'
import { renderBox, BORDER_STYLES } from './box.js'
import { padRight, truncate } from './text.js'
import { userFacingToolName } from './message.js'
import { classifyBashCommand } from '../bash-risk.js'

export interface PermissionChoice {
  key: string    // keyboard shortcut (e.g. 'y', 'n', 'a')
  label: string  // display label
  isDefault?: boolean
}

export interface PermissionDialogOptions {
  /** Tool name requesting permission. */
  toolName: string
  /** Short description of what the tool wants to do. */
  action: string
  /** Optional detail text (e.g. file path, command). */
  detail?: string
  /** Available choices. Default: [Approve (y), Reject (n)] */
  choices?: PermissionChoice[]
  /** Max width for the dialog. */
  width?: number
}

/**
 * Render a full-bordered permission dialog.
 *
 * ```
 * ╭─── 🔐 Permission Required ─────╮
 * │                                  │
 * │  bash wants to execute:          │
 * │  rm -rf /tmp/old-files           │
 * │                                  │
 * │  [Y] Approve  [N] Reject        │
 * │  [A] Always approve this tool    │
 * │                                  │
 * ╰──────────────────────────────────╯
 * ```
 */
export function renderPermissionDialog(opts: PermissionDialogOptions): string {
  const width = opts.width ?? Math.min(process.stdout.columns ?? 80, 70)
  const innerWidth = width - 4 // borders + padding

  const choices = opts.choices ?? [
    { key: 'y', label: 'Approve', isDefault: true },
    { key: 'n', label: 'Reject' },
    { key: 'a', label: 'Always approve this tool' },
  ]

  const lines: string[] = []
  lines.push('')
  lines.push(
    `${themeColor('warning')}${userFacingToolName(opts.toolName)}${sgr.reset} ${dim('wants to')} ${opts.action}`,
  )

  if (opts.detail) {
    const detailTrunc = truncate(opts.detail, innerWidth)
    lines.push(`${themeColor('text')}${detailTrunc}${sgr.reset}`)
  }

  lines.push('')

  // Choice buttons
  for (const choice of choices) {
    const keyDisplay = choice.isDefault
      ? `${themeColor('success')}[${choice.key.toUpperCase()}]${sgr.reset}`
      : `${themeColor('textDim')}[${choice.key.toUpperCase()}]${sgr.reset}`
    lines.push(`  ${keyDisplay} ${choice.label}`)
  }

  lines.push('')

  return renderBox(lines, {
    width,
    border: 'round',
    title: '🔐 Permission Required',
    titleColor: themeColor('warning'),
    borderColor: themeColor('warning'),
    paddingX: 1,
  })
}

// ─── Top-border-only dialogs ─────────────────

export interface TopBorderDialogOptions {
  /** Title displayed in/after the top border line. */
  title: string
  /** Optional subtitle (dimmed, below title). */
  subtitle?: string
  /** Border color token. Default: 'permission'. */
  color?: string
  /** Content lines to render below the border. */
  content: string[]
  /** Inner horizontal padding. Default: 2. */
  paddingX?: number
}

/**
 * Render a top-border-only dialog for compact approval prompts.
 *
 * ```
 * ╭─ 🔐 Bash ────────────────────────────╮
 *   rm -rf /tmp/old-files
 *
 *   [Y] Allow  [N] Deny  [A] Always
 * ```
 *
 * Only the top border is drawn (with rounded corners). Content below
 * has indented padding but no side or bottom borders.
 */
export function renderTopBorderDialog(opts: TopBorderDialogOptions): string {
  const cols = process.stdout.columns ?? 80
  const width = Math.min(cols - 2, 80)
  const padX = opts.paddingX ?? 2
  const color = opts.color ?? 'permission'
  const borderColor = themeColor(color as any)
  const chars = BORDER_STYLES['round']

  // Build top border: ╭─ Title ───────────╮
  const titleStr = ` ${opts.title} `
  const titleVisWidth = visibleWidth(titleStr)
  const rightWidth = Math.max(0, width - 2 - titleVisWidth)
  const topBorder = `${borderColor}${chars.topLeft}${chars.top}${sgr.reset}${opts.title}${borderColor} ${chars.top.repeat(rightWidth)}${chars.topRight}${sgr.reset}`

  const lines: string[] = ['', topBorder]
  const pad = ' '.repeat(padX)

  // Optional subtitle
  if (opts.subtitle) {
    lines.push(`${pad}${dim(opts.subtitle)}`)
  }

  // Content lines (indented)
  for (const line of opts.content) {
    lines.push(`${pad}${line}`)
  }

  return lines.join('\n')
}

// ─── Per-tool-type permission renderers ───────────────────────

/**
 * Render a bash permission dialog with command preview.
 */
/**
 * Detect potentially destructive bash commands.
 *
 * Delegates to `classifyBashCommand` (single source of truth — issue #2)
 * and returns a short warning string when the level is `dangerous`,
 * preserving the previous "null = no warning" contract this module's
 * callers depend on.
 *
 * `needs_approval` and `unknown` deliberately do NOT produce a warning
 * banner here: the permission card itself is already asking for consent,
 * so duplicating "this writes a file" copy on every `git commit` would
 * be noise. `dangerous` is reserved for things the operator should pause
 * over even when consenting (rm -rf, force-push, sudo, …).
 *
 * For headless callers and any new code that needs structured detail,
 * import `classifyBashCommand` directly from `../bash-risk.js`.
 */
export function detectDestructiveCommand(command: string): string | null {
  const verdict = classifyBashCommand(command)
  if (verdict.level !== 'dangerous') return null
  return verdict.reasons[0] ?? 'Potentially destructive command'
}

export function renderBashPermission(command: string, cwd?: string, selectedIndex = 1): string {
  const content: string[] = []
  content.push('')

  // Destructive command warning
  const warning = detectDestructiveCommand(command)
  if (warning) {
    content.push(`${themeColor('error')}${sgr.bold}⚠ ${warning}${sgr.reset}`)
    content.push('')
  }

  // Command preview with bash border color
  const cmdColor = themeColor('bashBorder')
  const cmdLines = command.split('\n').slice(0, 5)
  for (const line of cmdLines) {
    content.push(`${cmdColor}${sgr.bold}$ ${truncate(line, 70)}${sgr.reset}`)
  }
  if (command.split('\n').length > 5) {
    content.push(dim(`  … (${command.split('\n').length - 5} more lines)`))
  }

  if (cwd) {
    content.push('')
    content.push(dim(`in ${truncate(cwd, 60)}`))
  }

  content.push('')
  content.push(...formatChoiceList(selectedIndex))
  content.push('')
  content.push(formatChoiceHints())

  // Use error color border for destructive commands
  const borderColor = warning ? 'error' : 'bashBorder'
  return renderTopBorderDialog({
    title: `🔐 ${themeColor(borderColor)}Bash${sgr.reset}`,
    color: borderColor,
    content,
  })
}

/**
 * Render a file permission dialog with path and action.
 */
export function renderFilePermission(
  filePath: string,
  action: 'read' | 'write' | 'create' | 'edit',
  selectedIndex = 1,
): string {
  const content: string[] = []
  content.push('')

  const actionLabel = action === 'read' ? 'Read file' :
    action === 'write' ? 'Write file' :
    action === 'create' ? 'Create file' : 'Edit file'

  content.push(`${themeColor('info')}${actionLabel}${sgr.reset}`)
  content.push(`${themeColor('text')}${truncate(filePath, 70)}${sgr.reset}`)
  content.push('')
  content.push(...formatChoiceList(selectedIndex))
  content.push('')
  content.push(formatChoiceHints())

  return renderTopBorderDialog({
    title: `🔐 ${themeColor('permission')}File${sgr.reset}`,
    color: 'permission',
    content,
  })
}

/**
 * Render a web permission dialog with URL.
 */
export function renderWebPermission(url: string, method = 'GET', selectedIndex = 1): string {
  const content: string[] = []
  content.push('')
  content.push(`${themeColor('info')}${method}${sgr.reset} ${truncate(url, 65)}`)
  content.push('')
  content.push(...formatChoiceList(selectedIndex))
  content.push('')
  content.push(formatChoiceHints())

  return renderTopBorderDialog({
    title: `🔐 ${themeColor('permission')}Web${sgr.reset}`,
    color: 'permission',
    content,
  })
}

/** Permission choices in canonical order. Index 0 default-highlight is
 *  Deny (index 1) — safer than defaulting to Allow when the user just
 *  hits Enter. Number-key shortcuts map 1→Allow, 2→Deny, 3→Always. */
export const PERMISSION_CHOICES: ReadonlyArray<{
  key: string
  label: string
  description: string
  decision: 'allow' | 'deny' | 'always'
}> = [
  { key: 'y', label: 'Allow once',        description: 'run this one call', decision: 'allow' },
  { key: 'n', label: 'Deny',              description: 'reject, tell the model',         decision: 'deny'  },
  { key: 'a', label: 'Always allow this tool', description: 'remembered across sessions', decision: 'always' },
]

/** Format the choice list vertically with a highlight arrow pointing at
 *  the current selection. Arrow keys (and 1/2/3 numeric shortcuts) move
 *  the selection; Enter confirms. Previous horizontal `[Y] Allow [N] Deny
 *  [A] Always` format conflated "here are the keys" with "here is what
 *  will happen if you just press Enter", and the old handler treated
 *  empty Enter as Allow — which made arrow-key presses (useInput's
 *  `input` is '' for special keys) silently run the tool. */
export function formatChoiceList(selectedIndex: number): string[] {
  const idx = clampIndex(selectedIndex, PERMISSION_CHOICES.length)
  const lines: string[] = []
  for (let i = 0; i < PERMISSION_CHOICES.length; i += 1) {
    const choice = PERMISSION_CHOICES[i]!
    const selected = i === idx
    const arrow = selected ? `${themeColor('success')}▶${sgr.reset} ` : '  '
    const numberKey = `${themeColor('textDim')}${i + 1}.${sgr.reset}`
    const keyBadge = selected
      ? `${themeColor('success')}${sgr.bold}[${choice.key.toUpperCase()}]${sgr.reset}`
      : `${themeColor('textDim')}[${choice.key.toUpperCase()}]${sgr.reset}`
    const label = selected
      ? `${sgr.bold}${choice.label}${sgr.reset}`
      : `${choice.label}`
    const desc = dim(`· ${choice.description}`)
    lines.push(`${arrow}${numberKey} ${keyBadge} ${label} ${desc}`)
  }
  return lines
}

function clampIndex(i: number, n: number): number {
  if (!Number.isFinite(i) || i < 0) return 0
  if (i >= n) return n - 1
  return i
}

function formatChoiceHints(): string {
  return dim('↑/↓ move · Enter confirm · 1/2/3 quick · Y/N/A direct · Esc deny')
}

/**
 * Render a compact inline permission prompt (single line).
 * For use in readline contexts.
 */
export function renderInlinePermission(
  toolName: string,
  detail?: string,
  selectedIndex = 1,
): string {
  const displayName = userFacingToolName(toolName)
  const content: string[] = []
  content.push('')
  content.push(`${themeColor('info')}${displayName}${sgr.reset}`)
  if (detail) content.push(`${themeColor('text')}${truncate(detail, 120)}${sgr.reset}`)
  content.push('')
  content.push(...formatChoiceList(selectedIndex))
  content.push('')
  content.push(formatChoiceHints())

  return renderTopBorderDialog({
    title: `🔐 ${themeColor('permission')}Tool${sgr.reset}`,
    color: 'permission',
    content,
  })
}
