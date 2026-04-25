/**
 * PermissionCard — terminal port of the design's `oc-perm` block.
 *
 * Anatomy:
 *   ▎ READ  requires approval
 *   ▎
 *   ▎ {action}
 *   ▎ ┌───────────────────────────┐
 *   ▎ │ {target — bgInput band}   │
 *   ▎ └───────────────────────────┘
 *   ▎ ⚠  {risk}
 *   ▎
 *   ▎ ▸[y] Allow once *  [a] Allow always  [n] Deny
 *
 * Tier colors mirror `.oc-perm.is-{kind}`:
 *   read   → accent (cyan)         border-left: 2px solid var(--accent)
 *   web    → info  (cyan-light)    border-left: 2px solid var(--info)
 *   write  → warn  (amber)         border-left: 2px solid var(--warn)
 *   exec   → warn  (amber)         border-left: 2px solid var(--warn)
 *   danger → err   (red)           gradient bg from err-soft → bg-card
 */

import React from 'react'
import { Box, Text } from '../../ink.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { themeToInkHex } from '../ink-theme.js'

export type PermissionKind = 'read' | 'write' | 'exec' | 'web' | 'danger'

export interface PermissionCardChoice {
  readonly key: string
  readonly label: string
  readonly primary?: boolean
  readonly danger?: boolean
}

export interface PermissionCardProps {
  readonly kind: PermissionKind
  readonly action: string
  readonly target?: string
  readonly risk?: string
  readonly choices: readonly PermissionCardChoice[]
  readonly selectedIndex?: number
  readonly columns?: number
}

const ACCENT_BAR = '\u258E'
const ELLIPSIS = '\u2026'
const MIN_COLUMNS = 24

const KIND_LABELS: Record<PermissionKind, string> = {
  read:   'READ',
  write:  'WRITE',
  exec:   'EXEC',
  web:    'WEB',
  danger: 'DANGEROUS',
}

function clampColumns(columns: number | undefined): number {
  const fallback = process.stdout.columns || 80
  return Math.max(MIN_COLUMNS, Math.floor(columns ?? fallback))
}

function takeWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (stringWidth(text) <= maxWidth) return text
  const ellipsisWidth = stringWidth(ELLIPSIS)
  if (maxWidth <= ellipsisWidth) return ELLIPSIS.slice(0, maxWidth)

  let out = ''
  let width = 0
  for (const char of Array.from(text)) {
    const charWidth = stringWidth(char)
    if (width + charWidth > maxWidth - ellipsisWidth) break
    out += char
    width += charWidth
  }
  return out + ELLIPSIS
}

function takeEndWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (stringWidth(text) <= maxWidth) return text
  const ellipsisWidth = stringWidth(ELLIPSIS)
  if (maxWidth <= ellipsisWidth) return ELLIPSIS.slice(0, maxWidth)

  let out = ''
  let width = 0
  for (const char of Array.from(text).reverse()) {
    const charWidth = stringWidth(char)
    if (width + charWidth > maxWidth - ellipsisWidth) break
    out = char + out
    width += charWidth
  }
  return ELLIPSIS + out
}

function truncateMiddle(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (stringWidth(text) <= maxWidth) return text
  const ellipsisWidth = stringWidth(ELLIPSIS)
  if (maxWidth <= ellipsisWidth) return ELLIPSIS.slice(0, maxWidth)

  const budget = maxWidth - ellipsisWidth
  const headWidth = Math.ceil(budget / 2)
  const tailWidth = Math.floor(budget / 2)
  return `${takeWidth(text, headWidth).replace(ELLIPSIS, '')}${ELLIPSIS}${takeEndWidth(text, tailWidth).replace(ELLIPSIS, '')}`
}

function kindColorToken(kind: PermissionKind): keyof import('./colors.js').OwlTheme {
  if (kind === 'danger') return 'error'
  if (kind === 'write' || kind === 'exec') return 'warning'
  if (kind === 'web') return 'info'
  return 'owl'
}

export function PermissionCard({
  kind,
  action,
  target,
  risk,
  choices,
  selectedIndex = 0,
  columns,
}: PermissionCardProps): React.ReactElement {
  const width = clampColumns(columns)
  const textWidth = Math.max(1, width - 2)
  const tierToken = kindColorToken(kind)
  const accentColor = themeToInkHex(tierToken)
  const ink   = themeToInkHex('text')
  const inkHi = themeToInkHex('textHi')
  const dim   = themeToInkHex('textDim')
  const mute  = themeToInkHex('textMute')
  const hairFaint = themeToInkHex('hairFaint')
  const bgInput = themeToInkHex('bgInput')
  const accentSoft = themeToInkHex('accentSoft')
  const errSoft = themeToInkHex('errSoft')

  // Card background: danger tier uses err-soft per the design's
  // `.oc-perm.is-danger { background: linear-gradient(...err-soft...); }`.
  // Other tiers stay transparent so they sit on the composer surface.
  const cardBg = kind === 'danger' ? errSoft : undefined

  const tag = KIND_LABELS[kind]

  return (
    <Box flexDirection="column" width={width} flexShrink={0} backgroundColor={cardBg}>
      {/* Header row: tier tag + scope hint */}
      <Box width={width}>
        <Text color={accentColor}>{ACCENT_BAR} </Text>
        <Text color={accentColor} bold>{tag}</Text>
        <Text color={dim}>  requires approval</Text>
      </Box>

      {/* Action — primary statement of what's being requested. */}
      <Box width={width}>
        <Text color={accentColor}>{ACCENT_BAR} </Text>
        <Text color={inkHi} wrap="truncate-end">{takeWidth(action, textWidth)}</Text>
      </Box>

      {/* Target — sunken bg-input mono band. We render the band as a
       *  single Box with backgroundColor so it visually contrasts with the
       *  card surface, matching `.oc-perm-target { background: var(--bg-input) }`. */}
      {target ? (
        <Box width={width}>
          <Text color={accentColor}>{ACCENT_BAR} </Text>
          <Box backgroundColor={bgInput} flexGrow={1} paddingX={1}>
            <Text color={ink} wrap="truncate-end">{takeWidth(target, textWidth - 2)}</Text>
          </Box>
        </Box>
      ) : null}

      {/* Risk — only when supplied; tier ⚠ + dim copy. */}
      {risk ? (
        <Box width={width}>
          <Text color={accentColor}>{ACCENT_BAR} </Text>
          <Text color={kind === 'danger' ? accentColor : themeToInkHex('warning')}>⚠ </Text>
          <Text color={mute} wrap="truncate-end">{takeWidth(risk, Math.max(1, textWidth - 3))}</Text>
        </Box>
      ) : null}

      {/* Choices — single horizontal row, primary highlighted with bg accent-soft. */}
      <Box width={width} marginTop={1}>
        <Text color={accentColor}>{ACCENT_BAR} </Text>
        <Box flexGrow={1} flexDirection="row" flexWrap="wrap">
          {choices.map((choice, i) => {
            const isSelected = i === selectedIndex
            const isPrimary = !!choice.primary
            const isDanger = !!choice.danger
            const chipColor = isDanger
              ? themeToInkHex('error')
              : isPrimary
                ? accentColor
                : ink
            const chipBg = isSelected
              ? (isDanger ? errSoft : accentSoft)
              : undefined
            const keyColor = isDanger ? themeToInkHex('error') : accentColor
            return (
              <Box key={`${choice.key}-${i}`} marginRight={1} backgroundColor={chipBg}>
                <Text color={hairFaint}>[</Text>
                <Text color={keyColor} bold={isPrimary}>{choice.key.toUpperCase()}</Text>
                <Text color={hairFaint}>]</Text>
                <Text color={chipColor} bold={isSelected}> {choice.label}</Text>
              </Box>
            )
          })}
        </Box>
      </Box>

      {/* Footer hint — small caps mute, mirrors design's `oc-picker-head .hint`. */}
      <Box width={width}>
        <Text color={accentColor}>{ACCENT_BAR} </Text>
        <Text color={mute}>↑/↓ move · ↵ confirm · 1/2/3 quick · esc deny</Text>
      </Box>
    </Box>
  )
}

// `truncateMiddle` is exported for external callers that may format
// long target paths before passing them in.  Keep it referenced so the
// linter doesn't flag it after the layout change above.
void truncateMiddle
