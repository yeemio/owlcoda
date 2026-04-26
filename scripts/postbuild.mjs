#!/usr/bin/env node
import { chmod, copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const cliPath = join(root, 'dist', 'cli.js')
const inkDistDir = join(root, 'dist', 'ink')
const attributionSrc = join(root, 'src', 'ink', 'ATTRIBUTION.md')
const attributionDest = join(inkDistDir, 'ATTRIBUTION.md')

async function removeSourceMaps(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  await Promise.all(entries.map(async entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await removeSourceMaps(path)
      return
    }
    if (entry.isFile() && entry.name.endsWith('.map')) {
      await rm(path)
    }
  }))
}

await mkdir(inkDistDir, { recursive: true })
await copyFile(attributionSrc, attributionDest)
await removeSourceMaps(join(root, 'dist'))

if (process.platform !== 'win32') {
  await chmod(cliPath, 0o755)
}
