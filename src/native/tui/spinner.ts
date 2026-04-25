/**
 * OwlCoda TUI Spinner
 *
 * Animated terminal spinner with multiple styles, color shimmer effects,
 * and whimsical verb rotation. Renders to stderr to avoid corrupting
 * stdout pipe.
 */

import { sgr, resolveColor, themeColor, getTheme, dim } from './colors.js'
import { userFacingToolName } from './message.js'

/** Seconds before token count is shown on spinner. */
const SHOW_TOKENS_AFTER_S = 30

// ─── Glyph sets ───────────────────────────────────────────────

/** Spinner glyph animations indexed by style name. */
export const SPINNER_GLYPHS = {
  /** OwlCoda default: subtle dots-to-stars */
  owl:     ['🦉', '🌿', '🍃', '🌱', '🌿', '🍂'],
  /** Braille dots (compact, universal) */
  dots:    ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  /** Stars — bidirectional pulse (forward then reverse). */
  stars:   ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'],
  /** Line spinner */
  line:    ['|', '/', '-', '\\'],
  /** Block growth */
  blocks:  ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█', '▉', '▊', '▋', '▌', '▍', '▎', '▏'],
  /** Arc */
  arc:     ['◜', '◠', '◝', '◞', '◡', '◟'],
  /** Bouncing ball */
  bounce:  ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'],
} as const

export type SpinnerStyle = keyof typeof SPINNER_GLYPHS

// ─── Whimsical verbs (owl / nature / wisdom themed) ───────────

/**
 * Our own verb list — owl/nature/wisdom/forest themed.
 * Entirely original — distinct from any upstream verb vocabulary.
 */
export const OWL_VERBS: readonly string[] = [
  'Roosting',
  'Hooting',
  'Swooping',
  'Nesting',
  'Perching',
  'Foraging',
  'Molting',
  'Preening',
  'Gliding',
  'Prowling',
  'Brooding',
  'Fledging',
  'Pellet-casting',
  'Nocturning',
  'Moongazing',
  'Starwatching',
  'Twig-sorting',
  'Bark-reading',
  'Canopy-scanning',
  'Dusk-hunting',
  'Dawn-calling',
  'Talon-flexing',
  'Feather-ruffling',
  'Branch-hopping',
  'Acorn-hiding',
  'Moss-gathering',
  'Leaf-turning',
  'Root-tracing',
  'Pinecone-counting',
  'Dewdrop-sipping',
  'Windtasting',
  'Fog-threading',
  'Burrow-checking',
  'Echo-locating',
  'Ring-counting',
  'Sapwood-reading',
  'Lichen-mapping',
  'Owl-pellet-analyzing',
  'Moonbeam-riding',
  'Forest-floor-sweeping',
  'Hollow-inspecting',
  'Nest-lining',
  'Wingspan-stretching',
  'Silent-flighting',
  'Meadow-scanning',
  'Creek-following',
  'Ridge-soaring',
  'Valley-mapping',
  'Understory-exploring',
  'Crown-surveying',
  'Firefly-counting',
  'Moth-tracking',
  'Cricket-listening',
  'Treefrog-cataloguing',
  'Mushroom-identifying',
  'Cobweb-reading',
  'Raindrop-counting',
  'Pondwater-tasting',
  'Seedbank-indexing',
  'Stonepath-following',
] as const

/** Get a random verb from the whimsy list. */
export function randomVerb(): string {
  return OWL_VERBS[Math.floor(Math.random() * OWL_VERBS.length)]!
}

// ─── Color shimmer ────────────────────────────────────────────

/**
 * Interpolate between two RGB colors.
 * Returns `{r, g, b}` at position `t` (0–1).
 */
export function interpolateRgb(
  from: [number, number, number],
  to: [number, number, number],
  t: number,
): [number, number, number] {
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ]
}

/**
 * Generate a shimmer color sequence between two RGB colors.
 * Returns interpolated ANSI fg escape string.
 */
function shimmerColor(
  frame: number,
  totalFrames: number,
  fromRgb: [number, number, number],
  toRgb: [number, number, number],
): string {
  const t = (Math.sin((frame / totalFrames) * Math.PI * 2) + 1) / 2
  const [r, g, b] = interpolateRgb(fromRgb, toRgb, t)
  return `\x1b[38;2;${r};${g};${b}m`
}

// ─── Text shimmer — reverse-sweep highlight across verb ───────

/**
 * Compute a glimmer index for a reverse-sweep animation.
 * The highlight sweeps from right to left across the text.
 */
function glimmerIndex(tick: number, textWidth: number): number {
  const cycle = textWidth + 20
  return textWidth + 10 - (tick % cycle)
}

/**
 * Apply a text shimmer effect: one character is highlighted while
 * the rest are dimmed. The highlight sweeps across the text.
 * Uses OwlCoda's own green palette.
 */
function applyTextShimmer(text: string, frame: number): string {
  const idx = glimmerIndex(frame, text.length)
  const hiStart = Math.max(0, idx - 1)
  const hiEnd = Math.min(text.length, idx + 2)

  // When shimmer is offscreen, dim everything
  if (hiStart >= text.length || hiEnd <= 0) {
    return `${dim(text)}`
  }

  const before = text.slice(0, hiStart)
  const shimmer = text.slice(hiStart, hiEnd)
  const after = text.slice(hiEnd)

  return (
    (before ? dim(before) : '') +
    `${themeColor('text')}${shimmer}${sgr.reset}` +
    (after ? dim(after) : '')
  )
}

// ─── Spinner class ────────────────────────────────────────────

export interface SpinnerOptions {
  /** Message shown next to spinner. */
  message?: string
  /** Glyph style. Default: 'dots'. */
  style?: SpinnerStyle
  /** Animation interval (ms). Default: 80. */
  interval?: number
  /** Enable color shimmer. Default: true. */
  shimmer?: boolean
  /** Stream to write to. Default: stderr. */
  stream?: NodeJS.WriteStream
}

export class Spinner {
  private frames: readonly string[]
  private frameIndex = 0
  private shimmerFrame = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private message: string
  private shimmerEnabled: boolean
  private interval: number
  private stream: NodeJS.WriteStream
  private stalled = false

  constructor(opts: SpinnerOptions = {}) {
    const style = opts.style ?? 'dots'
    this.frames = SPINNER_GLYPHS[style] ?? SPINNER_GLYPHS.dots
    this.message = opts.message ?? ''
    this.shimmerEnabled = opts.shimmer ?? true
    this.interval = opts.interval ?? 80
    this.stream = opts.stream ?? process.stderr
  }

  /** Start the spinner animation. */
  start(message?: string): void {
    if (this.timer) return
    if (message !== undefined) this.message = message
    this.stalled = false

    this.timer = setInterval(() => {
      this.render()
      this.frameIndex++
      this.shimmerFrame++
    }, this.interval)
  }

  /** Stop the spinner and optionally clear the line. */
  stop(clear = true): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
    if (clear) {
      this.stream.write('\r\x1b[K')
    }
  }

  /** Update the spinner message while running. */
  update(message: string): void {
    this.message = message
  }

  /** Mark the spinner as stalled (shows red). */
  markStalled(): void {
    this.stalled = true
  }

  /** Check if the spinner is currently running. */
  isRunning(): boolean {
    return this.timer !== null
  }

  /** Render one frame of the spinner. */
  private render(): void {
    const glyph = this.frames[this.frameIndex % this.frames.length]!
    let coloredGlyph: string

    if (this.stalled) {
      coloredGlyph = `${themeColor('spinnerStall')}${glyph}${sgr.reset}`
    } else if (this.shimmerEnabled) {
      const color = shimmerColor(
        this.shimmerFrame,
        20,
        [120, 200, 120],
        [160, 230, 160],
      )
      coloredGlyph = `${color}${glyph}${sgr.reset}`
    } else {
      coloredGlyph = `${themeColor('spinnerBase')}${glyph}${sgr.reset}`
    }

    const msg = this.message ? ` ${this.message}` : ''
    this.stream.write(`\r\x1b[K${coloredGlyph}${msg}`)
  }
}

// ─── VerbSpinner: whimsical verb-rotating spinner ─────────────

export interface VerbSpinnerOptions {
  /** Fixed branded status message. When set, verb rotation is disabled. */
  message?: string
  /** Glyph style. Default: 'stars'. */
  style?: SpinnerStyle
  /** Verb rotation interval (ms) — how often the verb changes. Default: 4000. */
  verbInterval?: number
  /** Glyph animation interval (ms). Default: 80. */
  glyphInterval?: number
  /** Show elapsed time. Default: true. */
  showElapsed?: boolean
  /** Show token count. Default: false. */
  showTokens?: boolean
  /** Enable color shimmer. Default: true. */
  shimmer?: boolean
  /** Stream to write to. Default: stderr. */
  stream?: NodeJS.WriteStream
}

/**
 * Enhanced spinner that rotates whimsical verbs from OwlCoda's owl/nature vocabulary.
 *
 * Display: `✶ Moongazing… (3.2s)`
 */
export class VerbSpinner {
  private frames: readonly string[]
  private frameIndex = 0
  private shimmerFrame = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private verb: string
  private message: string | null
  private verbTimer: ReturnType<typeof setInterval> | null = null
  private startedAt = 0
  private tokens = 0
  private stalled = false
  private stalledAt = 0
  private stream: NodeJS.WriteStream
  private shimmerEnabled: boolean
  private showElapsed: boolean
  private showTokens: boolean
  private glyphInterval: number
  private verbInterval: number

  constructor(opts: VerbSpinnerOptions = {}) {
    const style = opts.style ?? 'stars'
    this.frames = SPINNER_GLYPHS[style] ?? SPINNER_GLYPHS.stars
    this.verb = randomVerb()
    this.message = opts.message?.trim() || null
    this.stream = opts.stream ?? process.stderr
    this.shimmerEnabled = opts.shimmer ?? true
    this.showElapsed = opts.showElapsed ?? true
    this.showTokens = opts.showTokens ?? false
    this.glyphInterval = opts.glyphInterval ?? 80
    this.verbInterval = opts.verbInterval ?? 4000
  }

  /** Start the verb spinner. */
  start(message?: string): void {
    if (this.timer) return
    if (message !== undefined) {
      this.message = message.trim() || null
    }
    this.startedAt = Date.now()
    this.stalled = false
    this.tokens = 0

    // Glyph animation timer
    this.timer = setInterval(() => {
      this.render()
      this.frameIndex++
      this.shimmerFrame++
    }, this.glyphInterval)

    // Verb rotation timer
    if (!this.message) {
      this.verbTimer = setInterval(() => {
        this.verb = randomVerb()
      }, this.verbInterval)
    }
  }

  /** Stop the spinner and clear the line. */
  stop(clear = true): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.verbTimer) {
      clearInterval(this.verbTimer)
      this.verbTimer = null
    }
    if (clear) {
      this.stream.write('\r\x1b[K')
    }
  }

  /** Update the token count (shown if showTokens is enabled). */
  updateTokens(count: number): void {
    this.tokens = count
  }

  /** Mark the spinner as stalled (gradual color shift to red). */
  markStalled(): void {
    if (!this.stalled) {
      this.stalled = true
      this.stalledAt = Date.now()
    }
  }

  /** Clear stalled state. */
  clearStalled(): void {
    this.stalled = false
  }

  /** Check if the spinner is currently running. */
  isRunning(): boolean {
    return this.timer !== null
  }

  /** Get elapsed seconds since start. */
  getElapsed(): number {
    if (this.startedAt === 0) return 0
    return (Date.now() - this.startedAt) / 1000
  }

  /** Render one frame. */
  private render(): void {
    const glyph = this.frames[this.frameIndex % this.frames.length]!
    let coloredGlyph: string

    if (this.stalled) {
      // Gradually interpolate from base to stall color over 10 seconds
      const elapsed = (Date.now() - this.stalledAt) / 1000
      const intensity = Math.min(elapsed / 10, 1)
      if (intensity > 0.7) {
        coloredGlyph = `${themeColor('spinnerStall')}${glyph}${sgr.reset}`
      } else {
        const color = shimmerColor(this.shimmerFrame, 20, [120, 200, 120], [170, 50, 65])
        coloredGlyph = `${color}${glyph}${sgr.reset}`
      }
    } else if (this.shimmerEnabled) {
      const color = shimmerColor(this.shimmerFrame, 20, [120, 200, 120], [160, 230, 160])
      coloredGlyph = `${color}${glyph}${sgr.reset}`
    } else {
      coloredGlyph = `${themeColor('spinnerBase')}${glyph}${sgr.reset}`
    }

    const label = this.message
      ? `${themeColor('text')}${this.message}${sgr.reset}`
      : this.shimmerEnabled && !this.stalled
        ? applyTextShimmer(this.verb + '…', this.shimmerFrame)
        : `${themeColor('text')}${this.verb}…${sgr.reset}`
    let line = `${coloredGlyph} ${label}`

    const elapsed = this.getElapsed()
    if (this.showElapsed) {
      line += ` ${dim(`(${elapsed.toFixed(1)}s)`)}`
    }

    // Show token count only after the long-running threshold.
    const showTokensNow = this.showTokens && this.tokens > 0 && elapsed >= SHOW_TOKENS_AFTER_S
    if (showTokensNow) {
      line += ` ${dim(`[${this.tokens} tokens]`)}`
    }

    this.stream.write(`\r\x1b[K${line}`)
  }
}

// ─── Convenience: one-shot progress indicator ─────────────────

/**
 * Show a quick progress indicator for an async operation.
 * Returns when the promise resolves. The spinner is cleaned up automatically.
 */
export async function withSpinner<T>(
  promise: Promise<T>,
  message = 'Working…',
  style: SpinnerStyle = 'dots',
): Promise<T> {
  const spinner = new Spinner({ message, style })
  spinner.start()
  try {
    return await promise
  } finally {
    spinner.stop()
  }
}

/**
 * Show a verb-rotating spinner for an async operation.
 */
export async function withVerbSpinner<T>(
  promise: Promise<T>,
  opts?: VerbSpinnerOptions,
): Promise<T> {
  const spinner = new VerbSpinner(opts)
  spinner.start()
  try {
    return await promise
  } finally {
    spinner.stop()
  }
}

// ─── ToolUseLoader ────────────────────────────────────────────

/**
 * Blinking dot indicator for tool execution in-progress.
 * Alternates between showing and hiding the progress dot (●/⏺) with color transitions.
 * Supports live progress display for bash tool (line count, byte count).
 */
export class ToolUseLoader {
  private timer: ReturnType<typeof setInterval> | null = null
  private frame = 0
  private toolName: string
  private stream: NodeJS.WriteStream
  private startedAt = 0
  private readonly blinkInterval: number
  private readonly dot = process.platform === 'darwin' ? '⏺' : '●'
  /** Live progress data from tool execution */
  private progress: { totalLines: number; totalBytes: number; lastLine?: string } | null = null

  constructor(toolName: string, opts?: { stream?: NodeJS.WriteStream; blinkInterval?: number }) {
    this.toolName = toolName
    this.stream = opts?.stream ?? process.stderr
    this.blinkInterval = opts?.blinkInterval ?? 500
  }

  start(): void {
    if (this.timer) return
    this.startedAt = Date.now()
    this.frame = 0
    this.progress = null

    this.timer = setInterval(() => {
      this.render()
      this.frame++
    }, this.blinkInterval)
  }

  stop(clear = true): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.progress = null
    if (clear) {
      this.stream.write('\r\x1b[K')
    }
  }

  isRunning(): boolean {
    return this.timer !== null
  }

  /** Update progress data from bash tool streaming output. */
  updateProgress(totalLines: number, totalBytes: number, lastLine?: string): void {
    this.progress = { totalLines, totalBytes, lastLine }
  }

  private render(): void {
    const elapsed = (Date.now() - this.startedAt) / 1000
    const visible = this.frame % 2 === 0
    const dotColor = elapsed > 10 ? themeColor('warning') : themeColor('text')
    const dotStr = visible ? `${dotColor}${this.dot}${sgr.reset}` : ' '
    const elapsedStr = elapsed >= 1 ? ` ${sgr.dim}(${elapsed.toFixed(1)}s)${sgr.reset}` : ''
    const displayName = userFacingToolName(this.toolName)

    // Build progress suffix if available
    let progressStr = ''
    if (this.progress && this.progress.totalLines > 0) {
      const bytes = this.progress.totalBytes
      const sizeStr = bytes >= 1024 * 1024
        ? `${(bytes / (1024 * 1024)).toFixed(1)}M`
        : bytes >= 1024
          ? `${(bytes / 1024).toFixed(1)}K`
          : `${bytes}B`
      progressStr = ` ${sgr.dim}· +${this.progress.totalLines} lines · ${sizeStr}${sgr.reset}`
    }

    this.stream.write(`\r\x1b[K  ${sgr.dim}⎿${sgr.reset}  ${dotStr} ${sgr.dim}${displayName}${sgr.reset}${elapsedStr}${progressStr}`)
  }
}
