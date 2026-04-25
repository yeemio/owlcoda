#!/usr/bin/env node
// Smoke demo for the presentation-layer changes (R-presentation-1).
// Runs against compiled dist/ — exercises the four formatter changes:
//   1. Code block: bar dropped, simpler title, optional path slot
//   2. Assistant turn rule (replaces per-block banner)
//   3. Smart tool-result tail (per-tool noun)
//   4. Platform event axis (◆)
//
// Run:    node scripts/smoke-presentation.mjs
// Verify: drag-select a code line and paste — the clipboard should hold the
//         code only, with no `│` left-bar character.
import {
  formatAssistantTurnRule,
  formatPlatformEvent,
  formatToolUseHeader,
  formatToolResult,
  formatUserMessage,
} from '../dist/native/tui/message.js'
import { renderMarkdown } from '../dist/native/markdown.js'

const SECTION = (label) => console.log(`\n\x1b[2m── ${label} ──\x1b[0m\n`)

SECTION('1. Assistant turn rule (replaces per-block banner)')
console.log(formatAssistantTurnRule())
console.log('Here is some assistant prose. The rule above appears once per turn — not per text block.')

SECTION('2. Code block — drop bar, simpler title')
console.log(renderMarkdown('```ts\nconst greeting = "hello"\nexport function greet(name: string) {\n  return `${greeting}, ${name}`\n}\n```'))

SECTION('2b. Code block — info-string path slot')
console.log(renderMarkdown('```ts src/native/markdown.ts\nfunction renderFenceStart(lang: string) {\n  return "rule"\n}\n```'))

SECTION('2c. Output fence (success-tinted rule)')
console.log(renderMarkdown('```output\n+ exit 0\n+ /Users/owlcoda/dev\n+ build complete in 1.2s\n```'))

SECTION('3. Smart tool-result tails')
console.log(formatToolUseHeader('bash', { command: 'ls -la' }))
console.log(formatToolResult('bash', Array.from({ length: 25 }, (_, i) => `out${i}`).join('\n'), false, 142))
console.log(formatToolUseHeader('grep', { pattern: 'TODO', path: 'src' }))
console.log(formatToolResult('grep', Array.from({ length: 30 }, (_, i) => `src/x${i}.ts:${i}: TODO fix`).join('\n'), false, 88))
console.log(formatToolUseHeader('glob', { pattern: '**/*.ts' }))
console.log(formatToolResult('glob', Array.from({ length: 28 }, (_, i) => `src/path/file${i}.ts`).join('\n'), false, 31))

SECTION('4. Platform event axis (◆)')
console.log(formatPlatformEvent('mcp', 'MCP: 2 servers connected · 14 tools · fs, git'))
console.log(formatPlatformEvent('model', 'Model → claude-opus-4-7'))
console.log(formatPlatformEvent('session', 'Resumed session · 12 turns restored'))
console.log(formatPlatformEvent('skill', 'Skill activated · brainstorming'))
console.log(formatPlatformEvent('router', 'Router → local (fallback from cloud)'))
console.log(formatPlatformEvent('warn', 'MCP "fs": stderr noisy'))
console.log(formatPlatformEvent('error', 'Plugin "X" failed to load'))

SECTION('Mixed transcript — what a turn looks like end-to-end')
console.log(formatUserMessage('show me the renderFenceStart function'))
console.log(formatAssistantTurnRule())
console.log(renderMarkdown('I will look at `src/native/markdown.ts`:'))
console.log(formatToolUseHeader('read', { path: 'src/native/markdown.ts' }))
console.log(formatToolResult('read', 'function renderFenceStart(lang) {\n  ...\n}', false, 12))
console.log(renderMarkdown('Here is what it does:\n\n```ts src/native/markdown.ts\nfunction renderFenceStart(lang: string) {\n  const kind = classifyFenceKind(lang)\n  return `${border}╭─ ${title} ${fill}${RESET}`\n}\n```\n\nNotice: no `│` left bar; selection-first.'))
console.log(formatPlatformEvent('session', 'Session saved · 1 turn appended'))

SECTION('5. Long path tool header (P1 ❷ verification — was sliced mid-char)')
const deepPath = 'server/example-module/src/main/java/com/example/module/service/report/ExampleReportServiceImpl.java'
console.log(formatToolUseHeader('edit', { path: deepPath, oldStr: 'old', newStr: 'new' }))
console.log(formatToolResult('edit', `Edited ${deepPath}`, false, 268))

SECTION('6. Markdown table — current terminal width')
console.log(`(terminal width: ${process.stdout?.columns ?? 80})`)
console.log(renderMarkdown('| Tool | Status | Count |\n|------|--------|------:|\n| Read | ok | 12 |\n| Bash | warn | 3 |\n| Grep | error | 1 |'))

SECTION('7. Tool burst — 8 sequential reads (Static erasure scenario)')
console.log(formatPlatformEvent('session', 'Tool burst start — verify older results stay visible'))
for (let i = 0; i < 8; i++) {
  console.log(formatToolUseHeader('read', { path: `src/native/file${i}.ts` }))
  const body = `// content of file${i}.ts\n` + Array.from({ length: 5 }, (_, j) => `line ${j} of file ${i}`).join('\n')
  console.log(formatToolResult('read', body, false, 30 + i))
}
console.log(formatPlatformEvent('session', 'Tool burst end — all 8 results above should be present in transcript'))

SECTION('8. Long bash output (high-pressure compaction sample)')
console.log(formatToolUseHeader('bash', { command: 'find . -name "*.ts" | head -100' }))
console.log(formatToolResult('bash', Array.from({ length: 80 }, (_, i) => `./src/path/file${i}.ts`).join('\n'), false, 412))

SECTION('9. Error event (P1 ❶ verification — should be ◆ not framed wall)')
console.log(formatPlatformEvent('error', 'Tool dispatch failed: oldStr not found in src/example/report.ts'))

SECTION('Done — verification matrix')
console.log('Run again at three widths to validate degradation:')
console.log('  W1 narrow:  COLUMNS=40  node scripts/smoke-presentation.mjs')
console.log('  W2 normal:  COLUMNS=80  node scripts/smoke-presentation.mjs')
console.log('  W3 wide:    COLUMNS=160 node scripts/smoke-presentation.mjs')
console.log('For real Static-erasure verification, launch the REPL and do 20 sequential')
console.log('Read calls in a single turn:')
console.log('  node dist/cli.js')
console.log('Then PgUp from "live" — the FIRST read result should still be reachable.')
console.log()
