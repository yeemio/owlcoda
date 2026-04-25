/**
 * InkPicker — terminal port of the design's `oc-picker` overlay.
 *
 * Three grid variants mirror the design's three picker layouts:
 *
 *   slash:  16 + label + 1fr + auto    →  ▸ {cmd}    {desc}             {shortcut}
 *   at:     14 + 1fr + auto            →  ▸ {dir/}{file}                {tag pill}
 *   model:  16 + label + 1fr + auto    →  ▸ {label}  {meta: ctx · cost} {tag pill}
 *
 * Selected row gets a left ▎ accent bar + bg accent-soft + cmd swapped
 * from accent to shimmer (matches `.oc-picker-item.is-sel` rules).
 */

import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'

import { themeToInkHex } from './ink-theme.js'
import { fuzzyMatch, type PickerItem } from './tui/picker.js'
import { stripAnsi } from './tui/colors.js'
import { padRight, truncate } from './tui/text.js'

export type PickerVariant = 'slash' | 'at' | 'model' | 'theme' | 'generic'

interface InkPickerProps<T> {
  title: string
  items: PickerItem<T>[]
  variant?: PickerVariant
  placeholder?: string
  initialQuery?: string
  queryPrefix?: string
  submitLabel?: string
  visibleCount?: number
  onSelect: (item: PickerItem<T>) => void
  onCancel: () => void
}

export function InkPicker<T>({
  title,
  items,
  variant = 'generic',
  placeholder = 'Type to search…',
  initialQuery = '',
  queryPrefix = '',
  submitLabel = 'select',
  visibleCount = 10,
  onSelect,
  onCancel,
}: InkPickerProps<T>): React.ReactElement {
  const terminalRows = process.stdout.rows || 24
  const maxVisible = Math.max(3, Math.min(visibleCount, terminalRows - 10))

  const [query, setQuery] = useState(initialQuery)
  const [focusIndex, setFocusIndex] = useState(0)
  const [scrollOffset, setScrollOffset] = useState(0)

  useEffect(() => {
    setQuery(initialQuery)
    setFocusIndex(0)
    setScrollOffset(0)
  }, [initialQuery])

  const filtered = useMemo(() => {
    if (!query.trim()) return items
    const haystackOf = (item: PickerItem<T>): string => {
      const parts: string[] = [stripAnsi(item.label)]
      if (item.description) parts.push(item.description)
      if (item.meta) parts.push(item.meta)
      if (item.tag) parts.push(item.tag)
      if (item.shortcut) parts.push(item.shortcut)
      return parts.join(' ')
    }
    return items
      .map((item) => ({ item, score: fuzzyMatch(query, haystackOf(item)) }))
      .filter((entry) => entry.score >= 0)
      .sort((left, right) => left.score - right.score)
      .map((entry) => entry.item)
  }, [items, query])

  useEffect(() => {
    const bounded = Math.max(0, Math.min(focusIndex, Math.max(0, filtered.length - 1)))
    if (bounded !== focusIndex) {
      setFocusIndex(bounded)
    }
    if (bounded < scrollOffset) {
      setScrollOffset(bounded)
    } else if (bounded >= scrollOffset + maxVisible) {
      setScrollOffset(Math.max(0, bounded - maxVisible + 1))
    }
  }, [filtered.length, focusIndex, maxVisible, scrollOffset])

  useInput((input, key) => {
    if (input === '\u0003') {
      onCancel()
      return
    }
    if (key.escape) {
      onCancel()
      return
    }
    if (key.return) {
      const selected = filtered[focusIndex]
      if (selected) onSelect(selected)
      return
    }
    if (key.upArrow) {
      const next = Math.max(0, focusIndex - 1)
      setFocusIndex(next)
      if (next < scrollOffset) setScrollOffset(next)
      return
    }
    if (key.downArrow) {
      const next = Math.min(Math.max(0, filtered.length - 1), focusIndex + 1)
      setFocusIndex(next)
      if (next >= scrollOffset + maxVisible) {
        setScrollOffset(Math.max(0, next - maxVisible + 1))
      }
      return
    }
    if (key.backspace || key.delete) {
      setQuery((current) => current.slice(0, -1))
      setFocusIndex(0)
      setScrollOffset(0)
      return
    }
    if (key.ctrl || key.meta || key.tab || !input) {
      return
    }
    setQuery((current) => current + input)
    setFocusIndex(0)
    setScrollOffset(0)
  })

  const accent      = themeToInkHex('owl')
  const shimmer     = themeToInkHex('shimmer')
  const text        = themeToInkHex('text')
  const textHi      = themeToInkHex('textHi')
  const textDim     = themeToInkHex('textDim')
  const textMute    = themeToInkHex('textMute')
  const textSubtle  = themeToInkHex('textSubtle')
  const accentSoftBg = themeToInkHex('accentSoft')
  const hairFaint   = themeToInkHex('hairFaint')

  const visibleItems = filtered.slice(scrollOffset, scrollOffset + maxVisible)
  const displayedQuery = query ? `${queryPrefix}${query}` : (queryPrefix || placeholder)
  const matchSummary = query.trim().length > 0
    ? `${filtered.length}/${items.length} matches`
    : `${items.length} items`

  return (
    <Box flexDirection="column">
      {/* Picker head — small caps title in mute, hint with arrow keys on the
       *  right. Mirrors the design's `oc-picker-head`. */}
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={textMute} bold>
          {title.toUpperCase()}
          <Text color={textDim}>{'  '}{matchSummary}</Text>
        </Text>
        <Text color={textDim}>↑/↓ move · ↵ {submitLabel} · esc close</Text>
      </Box>

      {/* Query row — `›` prompt in accent + the live search text. */}
      <Box flexDirection="row">
        <Text color={accent}>› </Text>
        <Text color={query || queryPrefix ? text : textMute}>{displayedQuery}</Text>
      </Box>

      {/* Result list — one row per visible item, dispatched per variant. */}
      <Box flexDirection="column" marginTop={1}>
        {visibleItems.length > 0 ? visibleItems.map((item, index) => {
          const absoluteIndex = scrollOffset + index
          const focused = absoluteIndex === focusIndex
          return (
            <PickerRow
              key={`${absoluteIndex}:${stripAnsi(item.label)}`}
              item={item}
              focused={focused}
              variant={variant}
              colors={{ accent, shimmer, text, textHi, textDim, textMute, textSubtle, accentSoftBg, hairFaint }}
            />
          )
        }) : (
          <Text color={textMute}>No matches</Text>
        )}
      </Box>
    </Box>
  )
}

interface RowColors {
  accent: string
  shimmer: string
  text: string
  textHi: string
  textDim: string
  textMute: string
  textSubtle: string
  accentSoftBg: string
  hairFaint: string
}

interface PickerRowProps<T> {
  item: PickerItem<T>
  focused: boolean
  variant: PickerVariant
  colors: RowColors
}

function PickerRow<T>({ item, focused, variant, colors }: PickerRowProps<T>): React.ReactElement {
  const terminalColumns = process.stdout.columns || 80
  // Reserve cells per variant. Numbers track design grid templates:
  //   slash:  16 (▸+gutter) + 24 (cmd) + 1fr + 14 (shortcut)
  //   at:     14 (▸) + 1fr  + 8 (tag)
  //   model:  16 (▸) + 28 (label) + 1fr + 12 (tag)
  const labelCol = variant === 'model'
    ? Math.max(16, Math.min(32, Math.floor(terminalColumns * 0.30)))
    : variant === 'slash'
      ? Math.max(14, Math.min(28, Math.floor(terminalColumns * 0.22)))
      : 0  // at + generic let the path/label flex
  const tagCol = (variant === 'at' || variant === 'model') ? 12 : 0
  const shortcutCol = variant === 'slash' ? 14 : 0
  const reserved = 2 /* ▸ + space */ + labelCol + tagCol + shortcutCol + 4 /* gaps */
  const flexCol = Math.max(8, terminalColumns - reserved)

  // ComposerPanel already paints a ▎ on every row as its left border, so
  // the picker only renders ▸ for selection — avoids the ▎ ▎▸ double-bar
  // look reported in visual QA.
  const arrow = focused
    ? <Text color={colors.accent}>{'▸ '}</Text>
    : <Text color={colors.textSubtle}>{'  '}</Text>

  // Per-variant cell content.
  let cells: React.ReactNode

  if (variant === 'slash') {
    const cmdColor = focused ? colors.shimmer : colors.accent
    const descColor = focused ? colors.textHi : colors.textMute
    const cmdCell = padRight(truncate(stripAnsi(item.label), labelCol), labelCol)
    const desc = item.description ?? ''
    const descCell = padRight(truncate(desc, flexCol), flexCol)
    const shortcut = item.shortcut ?? ''
    cells = (
      <>
        <Text color={cmdColor} bold={focused}>{cmdCell}</Text>
        <Text color={descColor}> {descCell}</Text>
        {shortcut ? <Text color={colors.textSubtle}> {shortcut}</Text> : null}
      </>
    )
  } else if (variant === 'at') {
    // Path: split into directory portion (dim) and basename (ink).
    const path = stripAnsi(item.label)
    const slashIdx = path.lastIndexOf('/')
    const dir = slashIdx >= 0 ? path.slice(0, slashIdx + 1) : ''
    const base = slashIdx >= 0 ? path.slice(slashIdx + 1) : path
    const tag = item.tag ?? item.description ?? ''
    cells = (
      <>
        {dir ? <Text color={colors.textMute}>{dir}</Text> : null}
        <Text color={focused ? colors.textHi : colors.text}>{base || ' '}</Text>
        <Box flexGrow={1}><Text> </Text></Box>
        {tag ? (
          <Box paddingX={1}>
            <Text color={focused ? colors.accent : colors.textMute}>{tag.toUpperCase()}</Text>
          </Box>
        ) : null}
      </>
    )
  } else if (variant === 'model') {
    const labelColor = focused ? colors.shimmer : colors.accent
    const labelCell = padRight(truncate(stripAnsi(item.label), labelCol), labelCol)
    const meta = item.meta ?? item.description ?? ''
    const metaCell = padRight(truncate(meta, flexCol), flexCol)
    const tag = item.tag ?? ''
    cells = (
      <>
        <Text color={labelColor} bold={focused}>{labelCell}</Text>
        <Text color={focused ? colors.textHi : colors.textMute}> {metaCell}</Text>
        {tag ? (
          <Box>
            <Text color={focused ? colors.accent : colors.textSubtle}>{tag.toUpperCase()}</Text>
          </Box>
        ) : null}
      </>
    )
  } else {
    // generic / theme — single label + optional dim description.
    cells = (
      <>
        <Text color={focused ? colors.textHi : colors.text} bold={focused}>{stripAnsi(item.label)}</Text>
        {item.description ? <Text color={colors.textMute}> {item.description}</Text> : null}
      </>
    )
  }

  return (
    <Box flexDirection="row" backgroundColor={focused ? colors.accentSoftBg : undefined}>
      {arrow}
      {cells}
    </Box>
  )
}
