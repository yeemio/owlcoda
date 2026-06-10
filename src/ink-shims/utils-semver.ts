// Minimal semver.ts — only gte() is used by ink/terminal.ts
import semverPkg from 'semver'

export function gte(a: string, b: string): boolean {
  return semverPkg.gte(a, b)
}

export function gt(a: string, b: string): boolean {
  return semverPkg.gt(a, b)
}
