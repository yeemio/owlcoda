#!/usr/bin/env node
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

const root = process.cwd()
const cliPath = join(root, 'dist', 'cli.js')
const inkDistDir = join(root, 'dist', 'ink')
const attributionSrc = join(root, 'src', 'ink', 'ATTRIBUTION.md')
const attributionDest = join(inkDistDir, 'ATTRIBUTION.md')

await mkdir(inkDistDir, { recursive: true })
await copyFile(attributionSrc, attributionDest)

// Stale-dist defense: bake git SHA + dirty flag + build timestamp into
// dist/build-info.json so `owlcoda --version` and the REPL banner can
// surface "what code is actually running". Lets users tell at a glance
// whether they're on a fresh build or a stale binary from before recent
// commits. In dev mode (tsx) this file won't exist; version.ts falls
// back to 'dev'.
let sha = 'unknown'
let dirty = false
try {
  sha = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf-8' }).trim()
  const status = execSync('git status --porcelain', { cwd: root, encoding: 'utf-8' })
  dirty = status.trim().length > 0
} catch { /* not a git checkout — leave unknown */ }
await writeFile(
  join(root, 'dist', 'build-info.json'),
  JSON.stringify({ sha, dirty, builtAt: new Date().toISOString() }, null, 2) + '\n',
  'utf-8',
)

if (process.platform !== 'win32') {
  await chmod(cliPath, 0o755)
}
