#!/usr/bin/env node
// Smoke demo for the authoring-surface round:
//   1. User turn block — space-padded full-row bg
//   2. Composer autosize placeholder (just the user-block rendering,
//      Ink-level composer needs a real REPL instance)
//   3. Paste collapse — visible value vs expanded-on-submit
//
// Run against compiled dist/:   npm run build && node scripts/smoke-authoring.mjs [cols]
import { renderUserBlock } from '../dist/native/tui/user-block.js'
import {
  createPasteStore,
  detectPasteInsert,
  shouldCollapse,
  collapsePaste,
  expandPlaceholders,
} from '../dist/native/tui/paste-collapse.js'

const colsArg = Number(process.argv[2])
if (Number.isFinite(colsArg) && colsArg > 0) {
  Object.defineProperty(process.stdout, 'columns', { value: colsArg, configurable: true })
}
const cols = process.stdout.columns || 80

const SECTION = (label) => console.log(`\n\x1b[2m── ${label} (cols=${cols}) ──\x1b[0m\n`)

SECTION('1a. Single-line user block')
console.log(renderUserBlock('继续'))
console.log(renderUserBlock('short'))

SECTION('1b. Multi-line user block (Shift+Enter equivalent)')
console.log(renderUserBlock('first line\nsecond\nthird and a bit longer than the others'))

SECTION('1c. Long line that wraps')
console.log(renderUserBlock('x'.repeat(cols + 20)))

SECTION('2. Composer autosize — live behavior lives in the REPL; snapshot below is the user-block form')
console.log(renderUserBlock('A short draft.'))
console.log(renderUserBlock('Three\nseparate\nlines'))

SECTION('3. Paste collapse: visible vs expanded')
const store = createPasteStore()
const before = 'Please review this: '
const raw = Array.from({ length: 24 }, (_, i) => `line ${i + 1} body`).join('\n')
const next = before + raw
const insert = detectPasteInsert(before, next)
console.log(`• paste len = ${insert?.inserted.length} chars, ${insert?.inserted.split('\n').length} lines`)
console.log(`• shouldCollapse = ${insert && shouldCollapse(insert.inserted)}`)
if (insert && shouldCollapse(insert.inserted)) {
  const { value } = collapsePaste(store, before, insert)
  console.log('\nvisible in composer:')
  console.log(renderUserBlock(value))
  const expanded = expandPlaceholders(value, store)
  console.log('\nexpanded-at-submit (first 3 lines):')
  console.log(expanded.split('\n').slice(0, 3).join('\n') + '\n… (truncated)')
}
