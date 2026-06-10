/**
 * Banner — terminal port of the design's `oc-banner` block.
 *
 * Renders as: `{tier-color}{icon}  {bold title}{ — body}{actions}`
 * Tier maps to icon + foreground color: info=ⓘ accent, ok=✓ success,
 * warn=⚠ warning, err=✗ error. Actions render as `[k] label` chips,
 * primary action gets a bold accent treatment.
 */

import { bold, dim, sgr, themeColor, visibleWidth } from './colors.js'
import { truncate } from './text.js'

export type BannerKind = 'info' | 'ok' | 'warn' | 'err'

export interface BannerAction {
  key?: string
  label: string
  primary?: boolean
}

export interface BannerOptions {
  kind: BannerKind
  title: string
  body?: string
  actions?: BannerAction[]
  columns?: number
}

const KIND_STYLE: Record<BannerKind, { icon: string; colorToken: 'info' | 'success' | 'warning' | 'error' }> = {
  info: { icon: 'ⓘ', colorToken: 'info' },
  ok:   { icon: '✓', colorToken: 'success' },
  warn: { icon: '⚠', colorToken: 'warning' },
  err:  { icon: '✗', colorToken: 'error' },
}

export function renderBanner(opts: BannerOptions): string {
  const columns = normalizeColumns(opts.columns)
  const style = KIND_STYLE[opts.kind]
  const tierColor = themeColor(style.colorToken)
  const title = normalizeInline(opts.title)
  const body = opts.body ? normalizeInline(opts.body) : ''
  const actions = renderActions(opts.actions ?? [], tierColor)

  // Lead glyph carries the tier color; title is bold against the active ink
  // (not the tier color) — keeps the banner readable when stacked next to
  // other transcript content. Body sits dimmed after an em-dash separator.
  const head = `${tierColor}${style.icon}${sgr.reset}  ${bold(title, themeColor('textHi'))}`
  const headWithBody = body
    ? `${head}${dim(' — ')}${dim(body)}`
    : head

  if (!actions) {
    return fitLine(headWithBody, columns)
  }

  const single = `${headWithBody}    ${actions}`
  if (visibleWidth(single) <= columns) return single

  // Wrap actions to a second indented row when banner overflows the pane.
  return [
    fitLine(headWithBody, columns),
    fitLine(`   ${actions}`, columns),
  ].join('\n')
}

function renderActions(actions: BannerAction[], tierColor: string): string {
  return actions
    .map((action) => {
      const label = normalizeInline(action.label)
      const keyChip = action.key
        ? `${dim('[')}${tierColor}${normalizeInline(action.key)}${sgr.reset}${dim(']')} `
        : ''
      const text = `${keyChip}${label}`
      return action.primary ? bold(text, tierColor) : text
    })
    .filter((seg) => visibleWidth(seg) > 0)
    .join(dim('  ·  '))
}

function fitLine(line: string, columns: number): string {
  return truncate(line, columns)
}

function normalizeColumns(columns?: number): number {
  const value = columns ?? process.stdout.columns ?? 80
  if (!Number.isFinite(value)) return 80
  return Math.max(1, Math.floor(value))
}

function normalizeInline(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
