#!/usr/bin/env node
import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const cliPath = join(root, 'dist', 'cli.js')
const inkDistDir = join(root, 'dist', 'ink')
const attributionSrc = join(root, 'src', 'ink', 'ATTRIBUTION.md')
const attributionDest = join(inkDistDir, 'ATTRIBUTION.md')

await mkdir(inkDistDir, { recursive: true })
await copyFile(attributionSrc, attributionDest)

if (process.platform !== 'win32') {
  await chmod(cliPath, 0o755)
}
