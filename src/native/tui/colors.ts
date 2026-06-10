/**
 * OwlCoda TUI Color System
 *
 * Direct ANSI escape code rendering with RGB support, semantic color tokens,
 * and a multi-theme palette. No external dependencies (no chalk, no ink).
 *
 * Architecture: imperative string-building — every function returns a plain
 * string that can be written to stdout. This is fundamentally different from
 * React-component-based renderers; we own every byte of output.
 */

// ─── ANSI primitives ──────────────────────────────────────────

const ESC = '\x1b['

/** SGR (Select Graphic Rendition) control sequences. */
export const sgr = {
  reset:        `${ESC}0m`,
  bold:         `${ESC}1m`,
  dim:          `${ESC}2m`,
  italic:       `${ESC}3m`,
  underline:    `${ESC}4m`,
  blink:        `${ESC}5m`,
  inverse:      `${ESC}7m`,
  hidden:       `${ESC}8m`,
  strikethrough:`${ESC}9m`,

  // Reset individual attributes
  noBold:       `${ESC}22m`,
  noItalic:     `${ESC}23m`,
  noUnderline:  `${ESC}24m`,
  noInverse:    `${ESC}27m`,
} as const

// ─── Color application ────────────────────────────────────────

/** Apply 24-bit RGB foreground. */
export function fg(r: number, g: number, b: number): string {
  return `${ESC}38;2;${r};${g};${b}m`
}

/** Apply 24-bit RGB background. */
export function bg(r: number, g: number, b: number): string {
  return `${ESC}48;2;${r};${g};${b}m`
}

/** Apply ANSI-256 foreground. */
export function fg256(n: number): string {
  return `${ESC}38;5;${n}m`
}

/** Apply ANSI-256 background. */
export function bg256(n: number): string {
  return `${ESC}48;5;${n}m`
}

/** Standard 16-color foreground codes. */
export const fgBasic = {
  black:   `${ESC}30m`, red:     `${ESC}31m`, green:   `${ESC}32m`,
  yellow:  `${ESC}33m`, blue:    `${ESC}34m`, magenta: `${ESC}35m`,
  cyan:    `${ESC}36m`, white:   `${ESC}37m`,
  // Bright variants
  brightBlack:   `${ESC}90m`, brightRed:     `${ESC}91m`,
  brightGreen:   `${ESC}92m`, brightYellow:  `${ESC}93m`,
  brightBlue:    `${ESC}94m`, brightMagenta: `${ESC}95m`,
  brightCyan:    `${ESC}96m`, brightWhite:   `${ESC}97m`,
} as const

/** Standard 16-color background codes. */
export const bgBasic = {
  black:   `${ESC}40m`, red:     `${ESC}41m`, green:   `${ESC}42m`,
  yellow:  `${ESC}43m`, blue:    `${ESC}44m`, magenta: `${ESC}45m`,
  cyan:    `${ESC}46m`, white:   `${ESC}47m`,
  brightBlack:   `${ESC}100m`, brightRed:     `${ESC}101m`,
  brightGreen:   `${ESC}102m`, brightYellow:  `${ESC}103m`,
  brightBlue:    `${ESC}104m`, brightMagenta: `${ESC}105m`,
  brightCyan:    `${ESC}106m`, brightWhite:   `${ESC}107m`,
} as const

// ─── Convenience wrappers ─────────────────────────────────────

/** Wrap text with foreground color + reset. */
export function colorize(text: string, color: string): string {
  return `${color}${text}${sgr.reset}`
}

/** Wrap text with bold + foreground color + reset. */
export function bold(text: string, color?: string): string {
  const prefix = color ? `${sgr.bold}${color}` : sgr.bold
  return `${prefix}${text}${sgr.reset}`
}

/** Wrap text with dim + reset. */
export function dim(text: string): string {
  return `${sgr.dim}${text}${sgr.reset}`
}

/** Wrap text with italic + reset. */
export function italic(text: string): string {
  return `${sgr.italic}${text}${sgr.reset}`
}

/** Wrap text with underline + reset. */
export function underline(text: string): string {
  return `${sgr.underline}${text}${sgr.reset}`
}

/** Wrap text with strikethrough + reset. */
export function strikethrough(text: string): string {
  return `${sgr.strikethrough}${text}${sgr.reset}`
}

// ─── Parse color strings ──────────────────────────────────────

/**
 * Parse an `rgb(r,g,b)` string into [r,g,b] tuple.
 * Returns null if the string doesn't match.
 */
export function parseRgb(s: string): [number, number, number] | null {
  const m = s.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/)
  if (!m) return null
  return [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)]
}

/**
 * Parse a hex color `#RRGGBB` or `#RGB` into [r,g,b] tuple.
 */
export function parseHex(s: string): [number, number, number] | null {
  const m6 = s.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/)
  if (m6) {
    return [parseInt(m6[1]!, 16), parseInt(m6[2]!, 16), parseInt(m6[3]!, 16)]
  }
  const m3 = s.match(/^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/)
  if (m3) {
    return [
      parseInt(m3[1]! + m3[1]!, 16),
      parseInt(m3[2]! + m3[2]!, 16),
      parseInt(m3[3]! + m3[3]!, 16),
    ]
  }
  return null
}

/**
 * Resolve a color token to an ANSI escape string.
 * Supports: rgb(r,g,b), #RRGGBB, #RGB, ansi-256 numbers, named basic colors.
 */
export function resolveColor(token: string): string {
  // Already an escape sequence
  if (token.startsWith('\x1b[')) return token

  // rgb() notation
  const rgb = parseRgb(token)
  if (rgb) return fg(rgb[0], rgb[1], rgb[2])

  // Hex notation
  const hex = parseHex(token)
  if (hex) return fg(hex[0], hex[1], hex[2])

  // ANSI-256 number
  const n = parseInt(token, 10)
  if (!isNaN(n) && n >= 0 && n <= 255) return fg256(n)

  // Named basic color
  const basic = (fgBasic as Record<string, string>)[token]
  if (basic) return basic

  // Fallback: no color
  return ''
}

/**
 * Resolve a color token to an ANSI background escape string.
 */
export function resolveBgColor(token: string): string {
  const rgb = parseRgb(token)
  if (rgb) return bg(rgb[0], rgb[1], rgb[2])
  const hex = parseHex(token)
  if (hex) return bg(hex[0], hex[1], hex[2])
  const n = parseInt(token, 10)
  if (!isNaN(n) && n >= 0 && n <= 255) return bg256(n)
  const basic = (bgBasic as Record<string, string>)[token]
  if (basic) return basic
  return ''
}

// ─── Strip ANSI ───────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*m/g

/** Remove all ANSI escape sequences from a string. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

/** Visible character width (strips ANSI, counts chars). */
export function visibleWidth(s: string): number {
  return stringWidth(stripAnsi(s))
}

// ─── Theme system ─────────────────────────────────────────────

/**
 * OwlCoda semantic color palette. Every color is an `rgb()` or hex string
 * that gets resolved through `resolveColor()` at render time.
 *
 * Our palette is inspired by owl/forest/night-vision aesthetics —
 * deliberately distinct from any upstream project's palette.
 */
export type OwlTheme = {
  // Brand
  owl:          string   // Primary brand accent (alias of `accent`)
  owlShimmer:   string   // Lighter variant for animation (alias of `shimmer`)
  shimmer:      string   // Lighter accent for inline code highlight
  purple:       string   // Secondary accent (purple/violet)
  pink:         string   // Tertiary accent (pink)
  // Surface ramp — quoted from design tokens (app.css / app.light.css)
  bgApp:        string   // Workspace bg, terminal canvas
  bgCard:       string   // Elevated panels, banners, picker header, todo
  bgCard2:      string   // Hover surface
  bgRaise:      string   // Picker body, diff head
  bgInput:      string   // Code blocks, perm target, diff gutter, sunken
  bgSidebar:    string
  bgChrome:     string
  bgInspector:  string
  // Hairlines
  hair:         string   // Default rule
  hairStrong:   string   // Stronger rule (hover/focus)
  hairFaint:    string   // Faintest rule (interior dividers)
  hairAccent:   string   // Accent-tinted rule (active state)
  // Borders and chrome (legacy aliases retained for compatibility)
  border:       string   // Panel borders (alias of `hair`)
  borderDim:    string   // Subtle borders (alias of `hairFaint`)
  borderActive: string   // Focused/active borders
  // Text / ink
  text:         string   // Primary text (--ink)
  textHi:       string   // High-contrast text (--ink-hi)
  textDim:      string   // Secondary/muted text (--ink-dim)
  textMute:     string   // More muted (--ink-mute)
  textInverse:  string   // Inverse (on highlight bg)
  subtle:       string   // Very muted text — alias of textSubtle
  textSubtle:   string   // Faintest text (--ink-subtle)
  suggestion:   string   // Auto-complete suggestion color
  // Semantic
  success:      string
  error:        string
  warning:      string
  warningShimmer: string // Lighter warning for shimmer/animation
  info:         string
  merged:       string   // Merged/combined status (violet)
  // Soft tints (pre-blended over bgApp at ~0.14 opacity, since terminals
  // can't composite). Use for diff hunk bg, banner bg, perm danger bg,
  // picker selection bg, accent-soft hover targets.
  accentSoft:   string
  successSoft:  string
  warnSoft:     string
  errSoft:      string
  infoSoft:     string
  purpleSoft:   string
  // Diff
  diffAdded:      string
  diffRemoved:    string
  diffAddedDim:   string  // Very light diff added (background hints)
  diffRemovedDim: string  // Very light diff removed (background hints)
  diffAddedWord:  string
  diffRemovedWord:string
  // Agent colors (for sub-agent visual distinction)
  agentRed:    string
  agentBlue:   string
  agentGreen:  string
  agentYellow: string
  agentPurple: string
  agentOrange: string
  agentPink:   string
  agentCyan:   string
  // Prompt / input
  promptBorder:       string
  promptBorderFocus:  string
  promptBorderShimmer:string // Lighter border for shimmer
  // Backgrounds
  userMsgBg:       string
  userMsgBgHover:  string  // Hover/focus state for user messages
  selectionBg:     string
  codeBg:          string
  bashMsgBg:       string  // Background for bash output blocks
  memoryBg:        string  // Background for memory/context markers
  // Permission & mode indicators
  permission:       string   // Permission dialog border & accent
  permissionShimmer:string   // Lighter permission for shimmer
  bashBorder:       string   // Bash tool border accent
  planMode:         string   // Plan mode indicator
  fastMode:         string   // Compact/fast mode indicator
  fastModeShimmer:  string   // Lighter fast mode for shimmer
  autoAccept:       string   // Auto-accept/approve indicator
  // Labels
  briefLabelYou:    string   // "You" label in brief mode
  briefLabelAssist: string   // Assistant label in brief mode
  // Rate limits
  rateLimitFill:    string   // Rate limit bar filled portion
  rateLimitEmpty:   string   // Rate limit bar empty portion
  // Spinner
  spinnerBase:  string   // Spinner base color
  spinnerStall: string   // Spinner stalled color (approaching error)
  // Inline code
  inlineCode:   string   // Inline code (`code`) foreground color
  inlineCodeBg: string   // Inline code background
}

/** Dark theme — OwlCoda night vision palette (muted for readability).
 *  Surface / ink / hairline tokens are sourced verbatim from the design
 *  tokens (OwlTheme.swift dark + design canvas app.css). */
const darkTheme: OwlTheme = {
  owl:            'rgb(92,184,196)',
  owlShimmer:     'rgb(138,208,214)',
  shimmer:        'rgb(138,208,214)',
  purple:         'rgb(156,144,212)',
  pink:           'rgb(194,132,178)',
  permission:     'rgb(124,138,206)',
  bgApp:          'rgb(18,22,36)',
  bgCard:         'rgb(26,34,52)',
  bgCard2:        'rgb(30,40,60)',
  bgRaise:        'rgb(36,46,70)',
  bgInput:        'rgb(14,18,30)',
  bgSidebar:      'rgb(11,14,22)',
  bgChrome:       'rgb(15,18,28)',
  bgInspector:    'rgb(36,46,70)',
  hair:           'rgb(76,108,124)',          // approx 108,146,162 @ 0.42 over bgApp
  hairStrong:     'rgb(98,134,150)',          // approx @ 0.68
  hairFaint:      'rgb(52,66,90)',
  hairAccent:     'rgb(86,142,158)',          // 126,196,206 @ 0.55 over bgApp
  selectionBg:    'rgb(43,57,77)',            // 60,84,112 @ 0.50 over bgApp
  border:         'rgb(76,108,124)',          // alias → hair
  borderDim:      'rgb(52,66,90)',            // alias → hairFaint
  borderActive:   'rgb(126,196,206)',
  text:           'rgb(214,216,224)',
  textHi:         'rgb(232,234,240)',
  textDim:        'rgb(144,152,176)',
  textMute:       'rgb(108,116,142)',
  textSubtle:     'rgb(94,106,132)',
  textInverse:    'rgb(30,34,52)',
  subtle:         'rgb(94,106,132)',
  suggestion:     'rgb(106,188,194)',
  success:        'rgb(88,198,162)',          // design's --success (was cyan, now proper green)
  error:          'rgb(200,75,75)',
  warning:        'rgb(198,168,74)',
  warningShimmer: 'rgb(224,196,108)',
  info:           'rgb(124,198,206)',
  merged:         'rgb(156,144,212)',
  accentSoft:     'rgb(28,45,58)',            // accent @ 0.14 over bgApp
  successSoft:    'rgb(28,47,54)',
  warnSoft:       'rgb(43,42,41)',
  errSoft:        'rgb(43,29,41)',
  infoSoft:       'rgb(33,47,60)',
  purpleSoft:     'rgb(37,39,61)',
  diffAdded:      'rgb(92,184,196)',
  diffRemoved:    'rgb(200,75,75)',
  diffAddedDim:   'rgb(34,56,66)',
  diffRemovedDim: 'rgb(65,32,38)',
  diffAddedWord:  'rgb(104,194,202)',
  diffRemovedWord:'rgb(165,48,48)',
  agentRed:       'rgb(200,50,50)',
  agentBlue:      'rgb(118,190,214)',
  agentGreen:     'rgb(92,184,196)',
  agentYellow:    'rgb(200,185,50)',
  agentPurple:    'rgb(152,128,202)',
  agentOrange:    'rgb(210,130,40)',
  agentPink:      'rgb(194,132,178)',
  agentCyan:      'rgb(126,202,210)',
  promptBorder:        'rgb(160,166,198)',
  promptBorderFocus:   'rgb(196,200,228)',
  promptBorderShimmer: 'rgb(184,190,220)',
  userMsgBg:       'rgb(34,42,62)',
  userMsgBgHover:  'rgb(38,48,70)',
  codeBg:          'rgb(32,40,58)',
  bashMsgBg:       'rgb(34,42,60)',
  memoryBg:        'rgb(36,44,62)',
  permissionShimmer:'rgb(154,166,224)',
  bashBorder:       'rgb(200,55,120)',
  planMode:         'rgb(170,148,222)',
  fastMode:         'rgb(106,188,194)',
  fastModeShimmer:  'rgb(150,210,216)',
  autoAccept:       'rgb(130,75,210)',
  briefLabelYou:    'rgb(92,184,196)',
  briefLabelAssist: 'rgb(164,154,214)',
  rateLimitFill:    'rgb(92,184,196)',
  rateLimitEmpty:   'rgb(58,74,96)',
  spinnerBase:    'rgb(92,184,196)',
  spinnerStall:   'rgb(155,50,60)',
  // Inline code — shimmer fg per design intent, but bg is `bg-card`
  // (elevated panel) instead of the spec's `bg-input` (sunken). The
  // design's CSS pairs bg-input with a 1px hair-faint border + 4px
  // padding which softens the well into a "code groove"; terminal cells
  // can't paint a sub-cell border or padding, so any bg darker than
  // bg-app reads as a black hole the eye keeps catching on. bg-card
  // sits one step ABOVE main bg, so code reads as a raised chip — the
  // intended "this is verbatim" signal stays, the visual noise drops.
  inlineCode:     'rgb(138,208,214)',
  inlineCodeBg:   'rgb(26,34,52)',
}

/** Light theme — OwlCoda day palette. */
const lightTheme: OwlTheme = {
  owl:            'rgb(68,176,148)',
  owlShimmer:     'rgb(112,206,180)',
  shimmer:        'rgb(112,206,180)',
  purple:         'rgb(130,60,190)',
  pink:           'rgb(200,80,140)',
  bgApp:          'rgb(244,246,250)',
  bgCard:         'rgb(255,255,255)',
  bgCard2:        'rgb(248,250,253)',
  bgRaise:        'rgb(252,253,255)',
  bgInput:        'rgb(255,255,255)',
  bgSidebar:      'rgb(226,230,238)',
  bgChrome:       'rgb(236,240,246)',
  bgInspector:    'rgb(252,253,255)',
  hair:           'rgb(178,200,212)',
  hairStrong:     'rgb(158,182,196)',
  hairFaint:      'rgb(206,216,224)',
  hairAccent:     'rgb(167,210,220)',
  border:         'rgb(164,214,202)',
  borderDim:      'rgb(214,236,232)',
  borderActive:   'rgb(68,176,148)',
  text:           'rgb(30,30,25)',
  textHi:         'rgb(18,22,38)',
  textDim:        'rgb(118,138,142)',
  textMute:       'rgb(128,140,162)',
  textSubtle:     'rgb(94,106,132)',
  textInverse:    'rgb(245,249,252)',
  subtle:         'rgb(178,194,198)',
  accentSoft:     'rgb(220,237,232)',          // owl @ 0.14 over bgApp(244,246,250)
  successSoft:    'rgb(220,237,232)',
  warnSoft:       'rgb(238,233,218)',
  errSoft:        'rgb(243,222,222)',
  infoSoft:       'rgb(220,234,232)',
  purpleSoft:     'rgb(229,219,242)',
  suggestion:     'rgb(70,170,142)',
  success:        'rgb(68,176,148)',
  error:          'rgb(180,40,50)',
  warning:        'rgb(160,120,20)',
  warningShimmer: 'rgb(200,160,60)',
  info:           'rgb(76,166,146)',
  merged:         'rgb(130,60,190)',
  diffAdded:      'rgb(68,176,148)',
  diffRemoved:    'rgb(180,40,50)',
  diffAddedDim:   'rgb(216,242,236)',
  diffRemovedDim: 'rgb(250,215,220)',
  diffAddedWord:  'rgb(82,186,160)',
  diffRemovedWord:'rgb(200,60,60)',
  agentRed:       'rgb(200,40,40)',
  agentBlue:      'rgb(82,164,186)',
  agentGreen:     'rgb(68,176,148)',
  agentYellow:    'rgb(180,160,30)',
  agentPurple:    'rgb(130,60,190)',
  agentOrange:    'rgb(200,120,30)',
  agentPink:      'rgb(200,80,140)',
  agentCyan:      'rgb(92,188,166)',
  promptBorder:        'rgb(166,214,202)',
  promptBorderFocus:   'rgb(68,176,148)',
  promptBorderShimmer: 'rgb(124,214,188)',
  userMsgBg:       'rgb(242,251,248)',
  userMsgBgHover:  'rgb(234,247,244)',
  selectionBg:     'rgb(210,240,232)',
  codeBg:          'rgb(246,251,249)',
  bashMsgBg:       'rgb(243,250,248)',
  memoryBg:        'rgb(238,246,244)',
  permission:       'rgb(60,80,200)',
  permissionShimmer:'rgb(100,120,230)',
  bashBorder:       'rgb(200,40,100)',
  planMode:         'rgb(140,100,220)',
  fastMode:         'rgb(76,176,150)',
  fastModeShimmer:  'rgb(124,204,182)',
  autoAccept:       'rgb(120,50,200)',
  briefLabelYou:    'rgb(68,176,148)',
  briefLabelAssist: 'rgb(120,90,190)',
  rateLimitFill:    'rgb(68,176,148)',
  rateLimitEmpty:   'rgb(214,236,232)',
  spinnerBase:    'rgb(68,176,148)',
  spinnerStall:   'rgb(160,40,50)',
  inlineCode:     'rgb(80,60,140)',
  inlineCodeBg:   'rgb(230,225,245)',
}

/** ANSI-only theme — for terminals with limited color support. */
const ansiDarkTheme: OwlTheme = {
  owl:            'green',       owlShimmer:     'brightGreen',
  shimmer:        'brightGreen', purple:         'magenta',
  pink:           'magenta',
  bgApp:          'black',       bgCard:         'black',
  bgCard2:        'black',       bgRaise:        'black',
  bgInput:        'black',       bgSidebar:      'black',
  bgChrome:       'black',       bgInspector:    'black',
  hair:           'brightBlack', hairStrong:     'white',
  hairFaint:      'brightBlack', hairAccent:     'green',
  border:         'white',       borderDim:      'brightBlack',
  borderActive:   'green',       text:           'white',
  textHi:         'brightWhite',
  textDim:        'brightBlack', textInverse:    'black',
  textMute:       'brightBlack', textSubtle:     'brightBlack',
  subtle:         'brightBlack', suggestion:     'green',
  accentSoft:     'black',       successSoft:    'black',
  warnSoft:       'black',       errSoft:        'black',
  infoSoft:       'black',       purpleSoft:     'black',
  success:        'green',       error:          'red',
  warning:        'yellow',      warningShimmer: 'brightYellow',
  info:           'cyan',        merged:         'magenta',
  diffAdded:      'green',       diffRemoved:    'red',
  diffAddedDim:   'green',       diffRemovedDim: 'red',
  diffAddedWord:  'green',       diffRemovedWord:'red',
  agentRed:    'red',        agentBlue:   'blue',
  agentGreen:  'green',      agentYellow: 'yellow',
  agentPurple: 'magenta',    agentOrange: 'yellow',
  agentPink:   'magenta',    agentCyan:   'cyan',
  promptBorder: 'white',     promptBorderFocus:'green',
  promptBorderShimmer: 'brightGreen',
  userMsgBg:   'black',      userMsgBgHover: 'black',
  selectionBg: 'blue',       codeBg:      'black',
  bashMsgBg:   'black',      memoryBg:    'black',
  permission:  'blue',       permissionShimmer: 'brightBlue',
  bashBorder:  'magenta',
  planMode:    'magenta',    fastMode:    'cyan',
  fastModeShimmer: 'brightCyan',
  autoAccept:  'magenta',
  briefLabelYou:   'green',  briefLabelAssist: 'magenta',
  rateLimitFill:   'green',  rateLimitEmpty:   'brightBlack',
  spinnerBase: 'green',      spinnerStall:'red',
  inlineCode:  'magenta',   inlineCodeBg:'black',
}

const ansiLightTheme: OwlTheme = {
  owl:            'green',       owlShimmer:     'brightGreen',
  shimmer:        'brightGreen', purple:         'magenta',
  pink:           'magenta',
  bgApp:          'white',       bgCard:         'white',
  bgCard2:        'white',       bgRaise:        'white',
  bgInput:        'white',       bgSidebar:      'white',
  bgChrome:       'white',       bgInspector:    'white',
  hair:           'brightBlack', hairStrong:     'black',
  hairFaint:      'brightBlack', hairAccent:     'green',
  border:         'black',       borderDim:      'brightBlack',
  borderActive:   'green',       text:           'black',
  textHi:         'black',
  textDim:        'brightBlack', textInverse:    'white',
  textMute:       'brightBlack', textSubtle:     'brightBlack',
  subtle:         'brightBlack', suggestion:     'green',
  accentSoft:     'white',       successSoft:    'white',
  warnSoft:       'white',       errSoft:        'white',
  infoSoft:       'white',       purpleSoft:     'white',
  success:        'green',       error:          'red',
  warning:        'yellow',      warningShimmer: 'brightYellow',
  info:           'blue',        merged:         'magenta',
  diffAdded:      'green',       diffRemoved:    'red',
  diffAddedDim:   'green',       diffRemovedDim: 'red',
  diffAddedWord:  'green',       diffRemovedWord:'red',
  agentRed:    'red',        agentBlue:   'blue',
  agentGreen:  'green',      agentYellow: 'yellow',
  agentPurple: 'magenta',    agentOrange: 'yellow',
  agentPink:   'magenta',    agentCyan:   'cyan',
  promptBorder: 'black',     promptBorderFocus:'green',
  promptBorderShimmer: 'brightGreen',
  userMsgBg:   'white',      userMsgBgHover: 'white',
  selectionBg: 'cyan',       codeBg:      'white',
  bashMsgBg:   'white',      memoryBg:    'white',
  permission:  'blue',       permissionShimmer: 'brightBlue',
  bashBorder:  'magenta',
  planMode:    'magenta',    fastMode:    'cyan',
  fastModeShimmer: 'brightCyan',
  autoAccept:  'magenta',
  briefLabelYou:   'green',  briefLabelAssist: 'magenta',
  rateLimitFill:   'green',  rateLimitEmpty:   'brightBlack',
  spinnerBase: 'green',      spinnerStall:'red',
  inlineCode:  'magenta',   inlineCodeBg:'white',
}

/** Dark daltonized theme — colorblind-friendly night palette. */
const darkDaltonizedTheme: OwlTheme = {
  owl:            'rgb(100,180,230)',
  owlShimmer:     'rgb(140,200,240)',
  shimmer:        'rgb(140,200,240)',
  purple:         'rgb(140,120,220)',
  pink:           'rgb(200,130,180)',
  bgApp:          'rgb(18,22,30)',
  bgCard:         'rgb(26,32,44)',
  bgCard2:        'rgb(30,38,52)',
  bgRaise:        'rgb(36,44,60)',
  bgInput:        'rgb(14,18,26)',
  bgSidebar:      'rgb(11,14,20)',
  bgChrome:       'rgb(15,18,26)',
  bgInspector:    'rgb(36,44,60)',
  hair:           'rgb(80,90,110)',
  hairStrong:     'rgb(110,120,140)',
  hairFaint:      'rgb(50,55,70)',
  hairAccent:     'rgb(80,140,180)',
  border:         'rgb(80,90,110)',
  borderDim:      'rgb(50,55,70)',
  borderActive:   'rgb(100,180,230)',
  text:           'rgb(220,220,210)',
  textHi:         'rgb(238,240,232)',
  textDim:        'rgb(130,135,140)',
  textMute:       'rgb(108,114,124)',
  textSubtle:     'rgb(94,100,112)',
  textInverse:    'rgb(20,22,28)',
  subtle:         'rgb(100,105,115)',
  suggestion:     'rgb(90,160,210)',
  accentSoft:     'rgb(29,44,58)',
  successSoft:    'rgb(29,42,58)',
  warnSoft:       'rgb(48,46,40)',
  errSoft:        'rgb(46,44,32)',
  infoSoft:       'rgb(35,36,52)',
  purpleSoft:     'rgb(35,36,52)',
  success:        'rgb(80,170,230)',
  error:          'rgb(230,160,60)',
  warning:        'rgb(230,200,80)',
  warningShimmer: 'rgb(240,220,120)',
  info:           'rgb(140,120,220)',
  merged:         'rgb(140,120,220)',
  diffAdded:      'rgb(80,170,230)',
  diffRemoved:    'rgb(230,160,60)',
  diffAddedDim:   'rgb(35,55,75)',
  diffRemovedDim: 'rgb(75,55,30)',
  diffAddedWord:  'rgb(60,140,200)',
  diffRemovedWord:'rgb(200,130,40)',
  agentRed:       'rgb(230,160,60)',
  agentBlue:      'rgb(80,170,230)',
  agentGreen:     'rgb(100,180,230)',
  agentYellow:    'rgb(230,200,80)',
  agentPurple:    'rgb(140,120,220)',
  agentOrange:    'rgb(230,160,60)',
  agentPink:      'rgb(200,130,180)',
  agentCyan:      'rgb(100,200,210)',
  promptBorder:        'rgb(80,90,110)',
  promptBorderFocus:   'rgb(100,180,230)',
  promptBorderShimmer: 'rgb(140,200,240)',
  userMsgBg:       'rgb(25,30,40)',
  userMsgBgHover:  'rgb(35,42,55)',
  selectionBg:     'rgb(50,70,100)',
  codeBg:          'rgb(22,26,35)',
  bashMsgBg:       'rgb(24,28,38)',
  memoryBg:        'rgb(28,30,45)',
  permission:       'rgb(80,130,230)',
  permissionShimmer:'rgb(120,160,240)',
  bashBorder:       'rgb(200,100,140)',
  planMode:         'rgb(140,120,220)',
  fastMode:         'rgb(80,180,170)',
  fastModeShimmer:  'rgb(120,200,190)',
  autoAccept:       'rgb(140,120,220)',
  briefLabelYou:    'rgb(100,180,230)',
  briefLabelAssist: 'rgb(140,120,220)',
  rateLimitFill:    'rgb(100,180,230)',
  rateLimitEmpty:   'rgb(50,55,70)',
  spinnerBase:    'rgb(100,180,230)',
  spinnerStall:   'rgb(230,120,50)',
  inlineCode:     'rgb(180,200,255)',
  inlineCodeBg:   'rgb(35,40,55)',
}

/** Light daltonized theme — colorblind-friendly day palette. */
const lightDaltonizedTheme: OwlTheme = {
  owl:            'rgb(40,100,180)',
  owlShimmer:     'rgb(60,130,200)',
  shimmer:        'rgb(60,130,200)',
  purple:         'rgb(110,80,180)',
  pink:           'rgb(180,100,150)',
  bgApp:          'rgb(244,246,250)',
  bgCard:         'rgb(255,255,255)',
  bgCard2:        'rgb(248,250,253)',
  bgRaise:        'rgb(252,253,255)',
  bgInput:        'rgb(255,255,255)',
  bgSidebar:      'rgb(226,230,238)',
  bgChrome:       'rgb(236,240,246)',
  bgInspector:    'rgb(252,253,255)',
  hair:           'rgb(150,160,180)',
  hairStrong:     'rgb(120,135,160)',
  hairFaint:      'rgb(190,200,210)',
  hairAccent:     'rgb(80,140,200)',
  border:         'rgb(150,160,180)',
  borderDim:      'rgb(190,200,210)',
  borderActive:   'rgb(40,100,180)',
  text:           'rgb(30,30,35)',
  textHi:         'rgb(18,20,28)',
  textDim:        'rgb(110,115,125)',
  textMute:       'rgb(140,148,160)',
  textSubtle:     'rgb(165,170,180)',
  textInverse:    'rgb(240,242,248)',
  subtle:         'rgb(165,170,180)',
  suggestion:     'rgb(50,110,170)',
  accentSoft:     'rgb(216,229,243)',
  successSoft:    'rgb(216,229,243)',
  warnSoft:       'rgb(243,233,213)',
  errSoft:        'rgb(247,231,213)',
  infoSoft:       'rgb(232,225,243)',
  purpleSoft:     'rgb(232,225,243)',
  success:        'rgb(30,100,180)',
  error:          'rgb(200,120,30)',
  warning:        'rgb(180,150,20)',
  warningShimmer: 'rgb(210,180,60)',
  info:           'rgb(110,80,180)',
  merged:         'rgb(110,80,180)',
  diffAdded:      'rgb(30,100,180)',
  diffRemoved:    'rgb(200,120,30)',
  diffAddedDim:   'rgb(210,225,245)',
  diffRemovedDim: 'rgb(248,225,205)',
  diffAddedWord:  'rgb(40,120,200)',
  diffRemovedWord:'rgb(220,140,40)',
  agentRed:       'rgb(200,120,30)',
  agentBlue:      'rgb(30,100,180)',
  agentGreen:     'rgb(40,100,180)',
  agentYellow:    'rgb(180,150,20)',
  agentPurple:    'rgb(110,80,180)',
  agentOrange:    'rgb(200,120,30)',
  agentPink:      'rgb(180,100,150)',
  agentCyan:      'rgb(40,160,170)',
  promptBorder:        'rgb(150,160,180)',
  promptBorderFocus:   'rgb(40,100,180)',
  promptBorderShimmer: 'rgb(80,140,210)',
  userMsgBg:       'rgb(238,242,248)',
  userMsgBgHover:  'rgb(228,234,242)',
  selectionBg:     'rgb(190,210,240)',
  codeBg:          'rgb(242,244,250)',
  bashMsgBg:       'rgb(240,243,248)',
  memoryBg:        'rgb(235,238,248)',
  permission:       'rgb(50,90,190)',
  permissionShimmer:'rgb(90,130,220)',
  bashBorder:       'rgb(180,70,110)',
  planMode:         'rgb(110,80,180)',
  fastMode:         'rgb(40,150,140)',
  fastModeShimmer:  'rgb(70,180,165)',
  autoAccept:       'rgb(110,80,180)',
  briefLabelYou:    'rgb(40,100,180)',
  briefLabelAssist: 'rgb(110,80,180)',
  rateLimitFill:    'rgb(40,100,180)',
  rateLimitEmpty:   'rgb(190,200,210)',
  spinnerBase:    'rgb(40,100,180)',
  spinnerStall:   'rgb(200,100,30)',
  inlineCode:     'rgb(60,50,130)',
  inlineCodeBg:   'rgb(230,228,245)',
}

export const THEME_NAMES = ['dark', 'light', 'dark-ansi', 'light-ansi', 'dark-daltonized', 'light-daltonized'] as const
export type ThemeName = (typeof THEME_NAMES)[number]
export type ThemeSetting = 'auto' | ThemeName

const THEMES: Record<ThemeName, OwlTheme> = {
  'dark':             darkTheme,
  'light':            lightTheme,
  'dark-ansi':        ansiDarkTheme,
  'light-ansi':       ansiLightTheme,
  'dark-daltonized':  darkDaltonizedTheme,
  'light-daltonized': lightDaltonizedTheme,
}

let activeThemeName: ThemeName = 'dark'

/** Get the current active theme. */
export function getTheme(): OwlTheme {
  return THEMES[activeThemeName]
}

/** Get the current theme name. */
export function getThemeName(): ThemeName {
  return activeThemeName
}

/** Set the active theme by name. */
export function setTheme(name: ThemeName): void {
  if (THEMES[name]) {
    activeThemeName = name
  }
}

/**
 * Resolve 'auto' theme setting based on system preference.
 * Checks COLORFGBG env var or defaults to dark.
 */
export function resolveThemeSetting(setting: ThemeSetting): ThemeName {
  if (setting !== 'auto') return setting

  // Heuristic: COLORFGBG=15;0 means light-on-dark (dark theme)
  const colorfgbg = process.env['COLORFGBG']
  if (colorfgbg) {
    const parts = colorfgbg.split(';')
    const bg = parseInt(parts[parts.length - 1] ?? '0', 10)
    return bg > 6 ? 'light' : 'dark'
  }

  return 'dark'
}

// ─── Themed color helpers ─────────────────────────────────────

/** Get resolved ANSI escape for a theme token. */
export function themeColor(token: keyof OwlTheme): string {
  return resolveColor(getTheme()[token])
}

/** Get resolved ANSI background for a theme token. */
export function themeBg(token: keyof OwlTheme): string {
  return resolveBgColor(getTheme()[token])
}

/** Wrap text in a themed foreground color + reset. */
export function themed(text: string, token: keyof OwlTheme): string {
  return colorize(text, themeColor(token))
}
import stringWidth from 'string-width'
