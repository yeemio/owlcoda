/**
 * Persistent tool permissions — saves "always approved" tools across sessions.
 * Stored in ~/.owlcoda/permissions.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { getOwlcodaDir } from '../paths.js'
import { join } from 'node:path'

interface PermissionsData {
  /** Tools globally approved (persist across sessions). */
  globalApprove: string[]
}

function getPermissionsPath(): string {
  return join(getOwlcodaDir(), 'permissions.json')
}

/** Load persistent permissions from disk. */
export function loadPermissions(): Set<string> {
  try {
    const p = getPermissionsPath()
    if (!existsSync(p)) return new Set()
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as PermissionsData
    return new Set(raw.globalApprove ?? [])
  } catch {
    return new Set()
  }
}

/** Save persistent permissions to disk. */
export function savePermissions(approved: Set<string>): void {
  try {
    const dir = getOwlcodaDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const data: PermissionsData = {
      globalApprove: [...approved].sort(),
    }
    writeFileSync(getPermissionsPath(), JSON.stringify(data, null, 2) + '\n', 'utf-8')
  } catch {
    // Best-effort
  }
}

/** Add a tool to persistent permissions. */
export function addGlobalPermission(toolName: string): void {
  const perms = loadPermissions()
  perms.add(toolName)
  savePermissions(perms)
}

/** Remove a tool from persistent permissions. */
export function removeGlobalPermission(toolName: string): boolean {
  const perms = loadPermissions()
  const had = perms.delete(toolName)
  if (had) savePermissions(perms)
  return had
}

/** Clear all persistent permissions. */
export function clearGlobalPermissions(): void {
  savePermissions(new Set())
}
