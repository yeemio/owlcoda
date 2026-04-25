/**
 * ComposerPanel — the authoring panel at the bottom of the REPL.
 *
 * Provides the shared frame for the three modes (input / slash picker /
 * permission prompt). Pre-submit authoring surface; transitions into
 * post-submit user block (src/native/tui/user-block.ts) upon Enter.
 *
 * Visual elements (shared with user block for language unity — spec §7):
 *   - Left accent bar ▎ painted by Ink's custom borderStyle, replicating
 *     on EVERY row of the body (not just the top row). Border color is
 *     the authoring accent (rose-mauve #D787AF).
 *   - Background tint #5F5F87 (blue-violet slate — same as user block's
 *     256-color 60 bg) applied to the body Box so draft content sits on
 *     the same colored band the submitted user block uses. "Submit"
 *     reads as a pure state transition, not a format swap.
 *   - One-cell left padding after the bar.
 *   - Bottom ─ separator across the pane width.
 *   - State rail beneath the separator.
 *
 * Layout (rows, top-to-bottom):
 *   1. Body Box with custom left-only border (▎ × N rows) + bg tint.
 *      Children render here with paddingLeft=1 after the border.
 *   2. Separator ─ row (dim).
 *   3. Rail row (single-line rail string from renderComposerRail).
 *
 * The previous design painted the left bar as a single <Text> in a
 * width=2 column — that only rendered on row 1 of the body because
 * <Text> height is 1 regardless of sibling body height. Switching to
 * Ink's borderStyle with a custom BoxStyle makes Ink replicate the
 * left char across every row of the Box. See src/ink/render-border.ts
 * BorderStyle = keyof Boxes | BoxStyle — BoxStyle accepts custom
 * corner/edge chars.
 */

import React from 'react'
import { Box, Text } from '../../ink.js'
import { themeToInkHex } from '../ink-theme.js'
import { truncate } from './text.js'

const ACCENT_BAR = '\u258E' // ▎
const SEPARATOR = '\u2500'  // ─

// Custom border with only the left edge populated. All other chars are
// empty strings — combined with borderTop/borderRight/borderBottom set
// to false, Ink paints only the left column with our ▎ on every row.
const LEFT_ACCENT_BORDER = {
  topLeft: '',
  top: '',
  topRight: '',
  left: ACCENT_BAR,
  right: '',
  bottomLeft: '',
  bottom: '',
  bottomRight: '',
} as const

export interface ComposerPanelProps {
  /**
   * The composer's active mode body: input / slash picker / permission prompt.
   * Optional because React.createElement's varargs-children form doesn't
   * reliably mark required `children` props as satisfied; typing it optional
   * also allows the panel to render alone (accent bar + separator + rail) as
   * a valid empty-body state, matching React's own practice for component
   * children.
   */
  readonly children?: React.ReactNode
  /** Single-line state rail string (produced by renderComposerRail). */
  readonly rail: string
  /**
   * Visible display-row count of the TextInput content (before wrap).
   * Drives minHeight on the bg-tinted Box so the authoring band grows
   * with Shift+Enter and contains multi-line rendering.
   *
   * IMPORTANT: only pass this in the TextInput mode. Overlay (slash
   * picker) and permission-prompt modes render their own content,
   * which has its own natural height — forcing a minHeight in those
   * modes paints an oversized empty bg slab below the overlay.
   * Leave undefined to let the body fit its children with no minimum.
   */
  readonly bodyLines?: number
}

/**
 * One attachment chip — terminal port of the design's `.oc-attach` pill.
 *
 * The product's attachment surface today is purely path-based (the
 * `@file` reference inserted by the file picker), so callers can derive
 * this list by scanning the current input. When real file uploads land
 * the same chip surface picks them up without changes here.
 */
export interface ComposerAttachment {
  /** Visual kind: img → 🖼 thumb, dir → ▸, file → ◰. */
  readonly kind: 'img' | 'file' | 'dir'
  /** Display name (path or filename). */
  readonly name: string
  /** Optional pre-formatted size string (e.g. "12 KB"). */
  readonly size?: string
}

export interface ComposerInputChromeProps {
  /** Runtime mode retained for callers/rail coordination; not shown in the input row. */
  readonly mode: string
  /** Optional queued message summary shown above the active input row. */
  readonly queued?: string | null
  /** Terminal column budget for truncating queued summaries. */
  readonly columns?: number
  /** Inline attachment chips rendered above the prompt row. */
  readonly attachments?: readonly ComposerAttachment[]
  /** The actual TextInput component. */
  readonly children?: React.ReactNode
}

export function ComposerInputChrome({
  mode,
  queued,
  columns,
  attachments,
  children,
}: ComposerInputChromeProps): React.ReactElement {
  // The `mode` prop intentionally stays in the type — slash commands,
  // permission flows, and the rail coordinate by it — but the composer
  // does NOT paint it next to `›`. The bottom rail's MODE cell is the
  // single source of truth for that signal; duplicating it here just
  // creates two labels that have to agree at render time.
  void mode
  const accentHex = themeToInkHex('owl')
  const warnHex   = themeToInkHex('warning')
  const dimHex    = themeToInkHex('textDim')
  const muteHex   = themeToInkHex('textMute')
  const inkHex    = themeToInkHex('text')
  const hairFaintHex = themeToInkHex('hairFaint')
  const bgInputHex = themeToInkHex('bgInput')
  const width = Math.max(20, columns ?? process.stdout.columns ?? 80)
  const queuedRaw = queued
    ? truncate(queued, Math.max(10, width - 24))
    : null

  return (
    <Box flexDirection="column">
      {/* Attachment chips — design's `oc-attachments`. Cap to 4 visible
       *  chips + "+N more" so a paste-of-many doesn't blow up the panel. */}
      {attachments && attachments.length > 0 ? (
        <Box flexDirection="row" flexWrap="wrap">
          {attachments.slice(0, 4).map((att, i) => (
            <Box
              key={`${att.kind}:${att.name}:${i}`}
              flexDirection="row"
              marginRight={1}
              borderStyle="round"
              borderColor={hairFaintHex}
              paddingX={1}
            >
              {/* Thumb glyph — matches `.oc-attach .thumb`. img gets the
               *  accent because images are the high-signal attachment;
               *  files/dirs sit muted. */}
              <Box marginRight={1} backgroundColor={bgInputHex} paddingX={1}>
                <Text color={att.kind === 'img' ? accentHex : muteHex}>
                  {att.kind === 'img' ? '🖼' : att.kind === 'dir' ? '▸' : '◰'}
                </Text>
              </Box>
              <Text color={inkHex}>{truncate(att.name, 32)}</Text>
              {att.size ? <Text color={dimHex}>{' '}{att.size}</Text> : null}
              <Text color={muteHex}>{'  ×'}</Text>
            </Box>
          ))}
          {attachments.length > 4 ? (
            <Box paddingX={1}>
              <Text color={muteHex}>+{attachments.length - 4} more</Text>
            </Box>
          ) : null}
        </Box>
      ) : null}

      {/* Queued chip — matches `.oc-queued-chip { color: var(--warn); }`,
       *  with a small caps tag + dim body + esc dismiss hint. */}
      {queuedRaw ? (
        <Box flexDirection="row">
          <Text color={warnHex} bold>QUEUED NEXT</Text>
          <Text>{'  '}</Text>
          <Text color={dimHex} wrap="truncate-end">{queuedRaw}</Text>
          <Text>{'  '}</Text>
          <Text color={muteHex}>esc to cancel</Text>
        </Box>
      ) : null}
      {/* Prompt row — › in accent, then the input. Mode lives in the rail. */}
      <Box flexDirection="row">
        <Text color={accentHex}>› </Text>
        <Box flexGrow={1} flexDirection="column">
          {children}
        </Box>
      </Box>
    </Box>
  )
}

/**
 * Parse an input string for `@path` attachment references and classify
 * each by file extension. The product wires `@` as a file picker prefix
 * (see ink-repl.tsx file-picker overlay), so this is the natural source
 * of attachment chips: they preview what's bundled with the next message.
 */
const ATTACHMENT_REF_RE = /(?:^|[\s])@([^\s]+)/g
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i

export function parseInputAttachments(input: string): ComposerAttachment[] {
  if (!input || !input.includes('@')) return []
  const seen = new Set<string>()
  const out: ComposerAttachment[] = []
  for (const match of input.matchAll(ATTACHMENT_REF_RE)) {
    const raw = match[1]
    if (!raw) continue
    // Strip trailing punctuation that's likely sentence chrome, not part
    // of the path (e.g. "@src/foo.ts," → "src/foo.ts").
    const path = raw.replace(/[,.;:)\]]+$/, '')
    if (!path || seen.has(path)) continue
    seen.add(path)
    const isDir = path.endsWith('/')
    const isImg = !isDir && IMG_EXT_RE.test(path)
    out.push({
      kind: isImg ? 'img' : isDir ? 'dir' : 'file',
      name: path,
    })
  }
  return out
}

export function ComposerPanel({ children, rail, bodyLines }: ComposerPanelProps): React.ReactElement {
  // minHeight is only applied when the caller opts in via bodyLines.
  // undefined → no minimum, body sizes to children (correct for overlay
  // / permission-prompt modes). number → follow the actual draft height.
  // Keeping a single-line draft in a forced 3-row band makes every keystroke
  // repaint/cursor-park across unnecessary empty rows in real terminals.
  const minHeightProp = bodyLines === undefined ? undefined : Math.max(1, bodyLines)
  // Accent ▎ uses the owl brand token (teal-blue-green). Pulled from the
  // active theme at render time so /theme swaps follow through. No bg
  // tint — design feedback: keep the authoring surface "light", just
  // the left accent plus the state rail below.
  const accentHex = themeToInkHex('owl')
  const hairFaintHex = themeToInkHex('hairFaint')
  const cols = Math.max(10, process.stdout.columns || 80)
  return (
    <Box flexDirection="column" flexShrink={0}>
      {/* Top hair-faint divider — separates composer from transcript.
       *  Mirrors design `.oc-composer { border-top: 1px solid var(--hair-faint) }`. */}
      <Box>
        <Text color={hairFaintHex}>{SEPARATOR.repeat(cols)}</Text>
      </Box>
      {/* Body: left-only ▎ border in owl teal. No backgroundColor — the
       * authoring surface reads as a marker, not a filled panel. The
       * left bar is OwlCoda-specific brand chrome (matches user-block.ts). */}
      <Box
        borderStyle={LEFT_ACCENT_BORDER}
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderLeftColor={accentHex}
        paddingLeft={1}
        minHeight={minHeightProp}
        flexDirection="column"
      >
        {children}
      </Box>
      {/* Hair-faint divider between composer body and rail. */}
      <Box>
        <Text color={hairFaintHex}>{SEPARATOR.repeat(cols)}</Text>
      </Box>
      {/* Rail row: single-line state rail (renderComposerRail). */}
      <Box>
        <Text>{rail}</Text>
      </Box>
    </Box>
  )
}
