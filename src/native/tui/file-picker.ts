import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { PickerItem } from './picker.js'

const SKIP_DIRS = new Set(['.git', '.claude', 'node_modules', 'dist', 'build', '.next', '.cache', 'coverage'])

export interface FilePickerOptions {
  cwd?: string
  limit?: number
  maxDepth?: number
}

export function buildFilePickerItems(opts: FilePickerOptions = {}): PickerItem<string>[] {
  const cwd = opts.cwd ?? process.cwd()
  const limit = opts.limit ?? 120
  const maxDepth = opts.maxDepth ?? 4
  const items: PickerItem<string>[] = []

  function visit(dir: string, depth: number): void {
    if (items.length >= limit || depth > maxDepth) return
    let entries: string[]
    try {
      entries = readdirSync(dir).sort((a, b) => {
        const ah = a.startsWith('.')
        const bh = b.startsWith('.')
        if (ah !== bh) return ah ? 1 : -1
        return a.localeCompare(b)
      })
    } catch {
      return
    }

    for (const entry of entries) {
      if (items.length >= limit) return
      const full = join(dir, entry)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue
        const value = `${relative(cwd, full)}/`
        items.push({ label: value, tag: 'dir', value })
        visit(full, depth + 1)
      } else if (stat.isFile()) {
        const value = relative(cwd, full)
        items.push({ label: value, tag: 'file', value })
      }
    }
  }

  visit(cwd, 0)
  return items
}
