#!/usr/bin/env node
// Build-integrity gate — fitness cell build.imported_untracked.
//
// Catch a source module that is imported by tracked code but never git-added.
// In a dirty workspace the file is on disk, so `npm run build` passes and the
// fault is invisible — until a clean clone (or the published tarball) fails to
// build. This compares the ON-DISK import graph against `git ls-files`, so it
// fires WHILE the local build still (misleadingly) succeeds. That is the
// 0.14.53 "断头 HEAD" class: a new src/ file referenced by tracked code but
// dropped from the commit.
//
// Reuses the built, unit-tested kernel in dist/, so run it AFTER `npm run build`.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkTrackedImports } from '../dist/native/import-integrity.js'

const root = process.cwd()

function gitTracked() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf-8' })
  return out.split('\0').filter(Boolean)
}

const tracked = new Set(gitTracked())
// Importers we own: tracked TS sources under src/ (where the 0.14.53 fault lived).
const importers = [...tracked].filter(
  f => f.startsWith('src/') && (f.endsWith('.ts') || f.endsWith('.tsx')),
)

const files = importers.map(file => ({
  file,
  source: readFileSync(join(root, file), 'utf-8'),
}))

const violations = checkTrackedImports(files, tracked)

if (violations.length > 0) {
  console.error('Imported-but-untracked modules (forgot `git add`?):')
  for (const v of violations) {
    console.error(`  ${v.file} → ${v.missingImport}  [not tracked in git]`)
  }
  console.error(
    `\n${violations.length} violation(s). A clean clone / published tarball would fail to build.`,
  )
  process.exit(1)
}

console.log(
  `build.imported_untracked: scanned ${files.length} tracked sources, no untracked imports.`,
)
