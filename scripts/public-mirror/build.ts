/**
 * Public Mirror builder.
 *
 * Generates a scrubbed public source tree under `.tmp/public-mirror/`, then
 * scans that generated tree. No git init, push, tag, or publish happens here.
 *
 *   npx tsx scripts/public-mirror/build.ts
 *   npx tsx scripts/public-mirror/build.ts --out=.tmp/public-mirror-check
 */
import { join } from 'node:path'
import { buildPublicMirrorTree, listCandidateFiles } from '../../src/public-mirror/build.js'

function topLevel(p: string): string {
  const i = p.indexOf('/')
  return i === -1 ? p : p.slice(0, i) + '/'
}

function parseOutDir(): string {
  const arg = process.argv.slice(2).find((value) => value.startsWith('--out='))
  return arg ? arg.slice('--out='.length) : '.tmp/public-mirror'
}

const sourceRoot = process.cwd()
const outDir = join(sourceRoot, parseOutDir())
const files = listCandidateFiles(sourceRoot)
const report = buildPublicMirrorTree({ sourceRoot, outDir, candidateFiles: files })

const byTop = new Map<string, { inc: number; exc: number }>()
for (const p of files) {
  const k = topLevel(p)
  const e = byTop.get(k) ?? { inc: 0, exc: 0 }
  if (report.included.includes(p)) e.inc++
  else e.exc++
  byTop.set(k, e)
}

console.log(
  `candidates: ${files.length}  included: ${report.included.length}  excluded: ${report.excluded.length}  scanned: ${report.scanned}`,
)
console.log(`out: ${outDir}`)
console.log('\nby top-level (included / excluded):')
for (const [k, v] of [...byTop.entries()].sort()) {
  console.log(`  ${k.padEnd(24)} ${String(v.inc).padStart(5)} / ${v.exc}`)
}

console.log(`\nremaining violations after transforms: ${report.violations.length}`)
const byRule = new Map<string, number>()
for (const v of report.violations) byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1)
for (const [r, n] of [...byRule.entries()].sort()) console.log(`  ${r.padEnd(16)} ${n}`)

const byFile = new Map<string, number>()
for (const v of report.violations) {
  const k = `${v.rule.padEnd(14)} ${v.path}`
  byFile.set(k, (byFile.get(k) ?? 0) + 1)
}
console.log('\nremaining by (rule, file), top 25:')
for (const [k, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${String(n).padStart(4)}  ${k}`)
}

if (report.violations.length > 0) {
  process.exit(1)
}
