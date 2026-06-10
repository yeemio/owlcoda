import { createHash } from 'node:crypto'
import { readdirSync, statSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const SKIP_DIRS = new Set(['.git', 'node_modules'])

function listFilesSorted(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(entry)) continue
      const full = join(dir, entry)
      const s = statSync(full)
      if (s.isDirectory()) walk(full)
      else if (s.isFile()) out.push(relative(root, full))
    }
  }
  walk(root)
  return out.sort()
}

/** Canonical sha256 over sorted (relpath, file-sha256) pairs. Excludes .git/node_modules. */
export function computeTreeIntegrity(root: string): string {
  const top = createHash('sha256')
  for (const rel of listFilesSorted(root)) {
    const fileHash = createHash('sha256').update(readFileSync(join(root, rel))).digest('hex')
    top.update(rel).update('\0').update(fileHash).update('\n')
  }
  return 'sha256:' + top.digest('hex')
}

export function verifyTreeIntegrity(root: string, expected: string): boolean {
  return computeTreeIntegrity(root) === expected
}

/** Copy a skill dir into destDir, filtering .git/node_modules. Overwrites destDir. */
export function vendorSkillDir(srcDir: string, destDir: string): void {
  if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true })
  cpSync(srcDir, destDir, {
    recursive: true,
    filter: (s) => {
      const parts = relative(srcDir, s).split(/[\\/]/)
      return !parts.some(p => SKIP_DIRS.has(p))
    },
  })
}
