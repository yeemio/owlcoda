#!/usr/bin/env node
// Smoke: print the three change-block shapes (edit update, write create,
// write overwrite) using the real tool + renderer pipeline.
// Run: node scripts/smoke-change-block.mjs

import { createEditTool } from '../dist/native/tools/edit.js'
import { createWriteTool } from '../dist/native/tools/write.js'
import {
  countDiffStats,
  formatChangeBlockResult,
  renderChangeBlockLines,
  renderFileCreateLines,
} from '../dist/native/tui/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = await mkdtemp(join(tmpdir(), 'owlcoda-smoke-'))
const edit = createEditTool()
const write = createWriteTool()
const p = join(dir, 'version.ts')

function render(meta, name, durationMs) {
  const path = meta.path
  const kind = meta.changeKind
  if (name === 'edit' && kind === 'update') {
    const { added, removed } = countDiffStats(meta.oldContext, meta.newContext)
    const bodyLines = renderChangeBlockLines(meta.oldContext, meta.newContext, {
      startLine: meta.contextStartLine ?? 1,
    })
    return formatChangeBlockResult({
      toolName: name, action: 'update', path, added, removed, durationMs, bodyLines,
    })
  }
  if (name === 'write' && kind === 'create') {
    const bodyLines = renderFileCreateLines(meta.newContent)
    const added = meta.newContent ? meta.newContent.split('\n').length : 0
    return formatChangeBlockResult({
      toolName: name, action: 'create', path, added, removed: 0, durationMs, bodyLines,
    })
  }
  if (name === 'write' && kind === 'overwrite') {
    const { added, removed } = countDiffStats(meta.oldContent, meta.newContent)
    const bodyLines = renderChangeBlockLines(meta.oldContent, meta.newContent, { startLine: 1 })
    return formatChangeBlockResult({
      toolName: name, action: 'overwrite', path, added, removed, durationMs, bodyLines,
    })
  }
  return '(unknown metadata shape)'
}

process.stdout.write('\n── 1) write create ──\n')
const r1 = await write.execute({
  path: p,
  content: 'const VERSION = "0.9.3";\nexport { VERSION };\n',
})
console.log(render(r1.metadata, 'write', 12))

process.stdout.write('\n── 2) edit update ──\n')
const r2 = await edit.execute({ path: p, oldStr: '"0.9.3"', newStr: '"0.10.0"' })
console.log(render(r2.metadata, 'edit', 8))

process.stdout.write('\n── 3) write overwrite ──\n')
const r3 = await write.execute({
  path: p,
  content:
    'const VERSION = "0.11.0";\nconst CHANNEL = "stable";\nconst BUILD = "release";\nexport { VERSION, CHANNEL, BUILD };\n',
})
console.log(render(r3.metadata, 'write', 15))

await rm(dir, { recursive: true, force: true })
process.stdout.write('\n')
