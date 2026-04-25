#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'

const root = resolve(new URL('../..', import.meta.url).pathname)
const logUpdatePath = resolve(root, 'dist/ink/log-update.js')

if (!existsSync(logUpdatePath)) {
  console.error('dist/ink/log-update.js not found. Run `pnpm build` first.')
  process.exit(1)
}

const [{ LogUpdate }, { emptyFrame }, { CharPool, HyperlinkPool, StylePool }] =
  await Promise.all([
    import(pathToFileURL(logUpdatePath).href),
    import(pathToFileURL(resolve(root, 'dist/ink/frame.js')).href),
    import(pathToFileURL(resolve(root, 'dist/ink/screen.js')).href),
  ])

const stylePool = new StylePool()
const charPool = new CharPool()
const hyperlinkPool = new HyperlinkPool()

function makeFrame({ rows, cols, staticCommit }) {
  const base = emptyFrame(rows, cols, stylePool, charPool, hyperlinkPool)
  return {
    ...base,
    viewport: { width: cols, height: rows },
    staticCommit,
  }
}

function serializeDiff(diff) {
  let buffer = ''
  for (const patch of diff) {
    if (patch.type === 'stdout') buffer += patch.content
    else if (patch.type === 'clearTerminal') buffer += '<CLEAR_TERMINAL>'
    else if (patch.type === 'clear') buffer += `<CLEAR_LINES:${patch.count}>`
    else if (patch.type === 'cursorHide') buffer += '<CURSOR_HIDE>'
    else if (patch.type === 'cursorShow') buffer += '<CURSOR_SHOW>'
    else if (patch.type === 'cursorMove') buffer += `<CURSOR_MOVE:${patch.x},${patch.y}>`
    else if (patch.type === 'cursorTo') buffer += `<CURSOR_TO:${patch.col}>`
    else if (patch.type === 'carriageReturn') buffer += '\r'
    else if (patch.type === 'styleStr') buffer += patch.str
    else if (patch.type === 'hyperlink') buffer += '<HYPERLINK>'
  }
  return buffer
}

function traceAnsi(input) {
  let output = ''
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    if (ch === '\x1b') {
      const next = input[i + 1]
      if (next === '[') {
        let j = i + 2
        while (j < input.length) {
          const code = input.charCodeAt(j)
          if (code >= 0x40 && code <= 0x7e) break
          j += 1
        }
        const seq = input.slice(i, Math.min(j + 1, input.length))
        output += renderCsi(seq)
        i = j
        continue
      }
      output += '<ESC>'
      continue
    }
    if (ch === '\n') output += '<LF>\n'
    else if (ch === '\r') output += '<CR>'
    else output += ch
  }
  return output
}

function renderCsi(seq) {
  const body = seq.slice(2)
  if (body === 'r') return '<RESET_SCROLL_REGION>'
  if (body === '?7l') return '<DECAWM_OFF>'
  if (body === '?7h') return '<DECAWM_ON>'
  if (body === 'K') return '<EL>'
  const cup = body.match(/^(\d+);(\d+)H$/)
  if (cup) return `<CUP ${cup[1]};${cup[2]}>`
  return `<CSI ${body}>`
}

function countNeedle(haystack, needle) {
  let count = 0
  let index = 0
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1
    index += needle.length
  }
  return count
}

const numericArgs = process.argv.slice(2).filter((arg) => /^\d+$/.test(arg))
const rows = Number(numericArgs[0] ?? 6)
const cols = Number(numericArgs[1] ?? 24)
const text = [
  'alpha',
  'beta',
  'gamma',
].join('\n')

const analyzeDumpIndex = process.argv.indexOf('--analyze-dump')
if (analyzeDumpIndex !== -1) {
  const dumpPath = process.argv[analyzeDumpIndex + 1]
  if (!dumpPath) {
    console.error('usage: ink_static_commit_probe.mjs --analyze-dump /path/to/dump.ans')
    process.exit(1)
  }
  analyzeDump(dumpPath)
  process.exit(0)
}

if (process.argv.includes('--emit-demo')) {
  const rowText = (row) => `${String(row).padStart(2, '0')}|${String(row % 10).repeat(Math.max(0, cols - 3))}`
  let out = '\x1b[r\x1b[?7l'
  for (let row = 1; row <= rows; row += 1) {
    out += `\x1b[${row};1H${rowText(row).slice(0, cols)}\x1b[K`
  }
  out += '\x1b[1;1H'
  out += text.split('\n').join('\x1b[K\n') + '\x1b[K'
  out += `\x1b[?7h\n\x1b[${rows};1H${'\n'.repeat(text.split('\n').length)}`
  process.stdout.write(out)
  process.exit(0)
}

function analyzeDump(dumpPath) {
  const raw = readFileSync(dumpPath, 'utf8')
  const matches = [...raw.matchAll(/(?:^|\n)--- frame ([^\n]*)\n/g)]
  const frames = matches.map((match, index) => {
    const bodyStart = match.index + match[0].length
    const bodyEnd = matches[index + 1]?.index ?? raw.length
    return {
      header: match[1],
      body: raw.slice(bodyStart, bodyEnd),
    }
  })
  let staticFrames = 0
  let suspiciousFrames = 0
  for (const [index, frame] of frames.entries()) {
    const body = frame.body
    const reset = body.indexOf('\x1b[r')
    const decawmOff = body.indexOf('\x1b[?7l', Math.max(0, reset))
    const cupTop = body.indexOf('\x1b[1;1H', Math.max(0, decawmOff))
    const decawmOn = body.indexOf('\x1b[?7h', Math.max(0, cupTop))
    if (reset === -1 || decawmOff === -1 || cupTop === -1 || decawmOn === -1) continue

    staticFrames += 1
    const payload = body.slice(cupTop + '\x1b[1;1H'.length, decawmOn)
    const findings = scanCommitPayload(payload)
    if (findings.length > 0) {
      suspiciousFrames += 1
      console.log(`frame_index=${index} dump_header="frame ${frame.header}"`)
      for (const finding of findings.slice(0, 20)) {
        console.log(`  ${finding}`)
      }
      if (findings.length > 20) {
        console.log(`  ... ${findings.length - 20} more`)
      }
    }
  }
  console.log(`static_frames=${staticFrames}`)
  console.log(`suspicious_static_frames=${suspiciousFrames}`)
}

function scanCommitPayload(payload) {
  const findings = []
  for (let i = 0; i < payload.length; i += 1) {
    const ch = payload[i]
    const code = payload.charCodeAt(i)
    if (ch === '\x1b') {
      const next = payload[i + 1]
      if (next === '[') {
        let j = i + 2
        while (j < payload.length) {
          const c = payload.charCodeAt(j)
          if (c >= 0x40 && c <= 0x7e) break
          j += 1
        }
        const seq = payload.slice(i, Math.min(j + 1, payload.length))
        const finalByte = seq[seq.length - 1]
        const isExpectedEl = seq === '\x1b[K' && (payload[j + 1] === '\n' || j + 1 === payload.length)
        const isSgr = finalByte === 'm'
        if (!isExpectedEl && !isSgr) {
          findings.push(`non_sgr_csi offset=${i} seq=${traceAnsi(seq)}`)
        }
        i = j
        continue
      }
      if (next === ']') {
        const end = findOscEnd(payload, i + 2)
        const osc = payload.slice(i, end.index)
        const isOsc8 = osc.startsWith('\x1b]8;')
        if (!isOsc8) findings.push(`non_osc8_sequence offset=${i}`)
        i = end.index - 1
        continue
      }
      findings.push(`escape_sequence offset=${i}`)
      continue
    }
    if (code < 0x20 && ch !== '\n' && ch !== '\t') {
      findings.push(`c0_control offset=${i} code=0x${code.toString(16).padStart(2, '0')}`)
    }
    if (ch === '\r') {
      findings.push(`carriage_return offset=${i}`)
    }
  }
  return findings
}

function findOscEnd(input, start) {
  for (let i = start; i < input.length; i += 1) {
    if (input[i] === '\x07') return { index: i + 1 }
    if (input[i] === '\x1b' && input[i + 1] === '\\') return { index: i + 2 }
  }
  return { index: input.length }
}

async function renderInkStaticProbe() {
  const React = await import('react')
  const { render, Static, Box, Text } = await import(pathToFileURL(resolve(root, 'dist/ink.js')).href)
  const stdout = new CaptureStream({ columns: cols, rows })
  const stderr = new CaptureStream({ columns: cols, rows })
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.isRaw = false
  stdin.setRawMode = (mode) => {
    stdin.isRaw = mode
    return stdin
  }
  const element = React.createElement(
    React.Fragment,
    null,
    React.createElement(Static, { items: ['alpha', 'beta', 'gamma'] }),
    React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(Text, null, 'dynamic-one'),
      React.createElement(Text, null, 'dynamic-two'),
      React.createElement(Text, null, 'dynamic-three'),
    ),
  )
  const instance = await render(element, {
    stdout,
    stderr,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 120))
  instance.unmount()
  instance.cleanup()

  const ansi = stdout.output
  console.log(`ink_static_render rows=${rows} cols=${cols} bytes=${ansi.length}`)
  console.log(`contains_reset_scroll=${ansi.includes('\x1b[r')}`)
  console.log(`contains_decawm_off=${ansi.includes('\x1b[?7l')}`)
  console.log(`contains_cup_top=${ansi.includes('\x1b[1;1H')}`)
  console.log(`contains_el_lf=${ansi.includes('\x1b[K\n')}`)
  console.log(`contains_el_cr_lf=${ansi.includes('\x1b[K\r\n')}`)
  console.log('--- trace ---')
  console.log(traceAnsi(ansi))
}

class CaptureStream extends Writable {
  constructor({ columns, rows }) {
    super()
    this.columns = columns
    this.rows = rows
    this.isTTY = true
    this.output = ''
  }

  _write(chunk, encoding, callback) {
    this.output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    callback()
  }

  getColorDepth() {
    return 24
  }

  hasColors() {
    return true
  }
}

if (process.argv.includes('--ink-static-render')) {
  await renderInkStaticProbe()
  process.exit(0)
}

const log = new LogUpdate({ isTTY: true, stylePool })
const prev = makeFrame({ rows, cols })
const next = makeFrame({
  rows,
  cols,
  staticCommit: { text, rowCount: text.split('\n').length },
})

const diff = log.render(prev, next)
const ansi = serializeDiff(diff)
const bottomCup = `\x1b[${rows};1H`
const afterBottomCup = ansi.slice(ansi.indexOf(bottomCup) + bottomCup.length)

console.log(`probe rows=${rows} cols=${cols} commitRows=3`)
console.log(`contains_el_lf=${ansi.includes('\x1b[K\n')}`)
console.log(`contains_el_cr_lf=${ansi.includes('\x1b[K\r\n')}`)
console.log(`bottom_cup=${traceAnsi(bottomCup).trim()}`)
console.log(`lf_after_bottom_cup=${countNeedle(afterBottomCup, '\n')}`)
console.log('--- trace ---')
console.log(traceAnsi(ansi))
