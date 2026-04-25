/**
 * Session catalog index — persistent metadata index for faster session search.
 * Index file: ~/.owlcoda/sessions/.index.json
 */

import { readFile, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getOwlcodaDir } from '../paths.js'
import type { SessionMeta, Session } from './sessions.js'

// ─── Paths ───

function getSessionsDir(): string {
  return join(getOwlcodaDir(), 'sessions')
}

function getIndexPath(): string {
  return join(getSessionsDir(), '.index.json')
}

// ─── Types ───

interface CatalogIndex {
  version: 1
  builtAt: string
  entries: Record<string, SessionMeta>
}

// ─── In-memory cache ───

let cachedIndex: CatalogIndex | null = null
let cachedIndexMtime: number = 0

// ─── Core operations ───

/**
 * Build or rebuild the full catalog index by scanning all session files.
 */
export async function buildIndex(): Promise<CatalogIndex> {
  const dir = getSessionsDir()
  if (!existsSync(dir)) {
    const empty: CatalogIndex = { version: 1, builtAt: new Date().toISOString(), entries: {} }
    cachedIndex = empty
    return empty
  }

  const files = await readdir(dir)
  const jsonFiles = files.filter(f => f.endsWith('.json') && !f.startsWith('.'))
  const entries: Record<string, SessionMeta> = {}

  for (const f of jsonFiles) {
    try {
      const raw = await readFile(join(dir, f), 'utf-8')
      const session = JSON.parse(raw) as Session
      entries[session.meta.id] = session.meta
    } catch {
      // Skip corrupt files
    }
  }

  const index: CatalogIndex = {
    version: 1,
    builtAt: new Date().toISOString(),
    entries,
  }

  // Persist to disk
  try {
    await writeFile(getIndexPath(), JSON.stringify(index), 'utf-8')
  } catch {
    // Non-fatal — index is still usable in memory
  }

  cachedIndex = index
  cachedIndexMtime = Date.now()
  return index
}

/**
 * Load index from disk if available and not stale.
 */
export async function loadIndex(): Promise<CatalogIndex> {
  // Check if cached index is fresh (< 60s old)
  if (cachedIndex && (Date.now() - cachedIndexMtime) < 60_000) {
    return cachedIndex
  }

  const indexPath = getIndexPath()
  if (existsSync(indexPath)) {
    try {
      const raw = await readFile(indexPath, 'utf-8')
      const index = JSON.parse(raw) as CatalogIndex
      if (index.version === 1 && index.entries) {
        cachedIndex = index
        cachedIndexMtime = Date.now()
        return index
      }
    } catch {
      // Corrupt index — rebuild
    }
  }

  return buildIndex()
}

/**
 * Update a single entry in the index.
 */
export async function updateIndexEntry(id: string, meta: SessionMeta): Promise<void> {
  const index = await loadIndex()
  index.entries[id] = meta
  index.builtAt = new Date().toISOString()
  cachedIndex = index
  cachedIndexMtime = Date.now()

  try {
    await writeFile(getIndexPath(), JSON.stringify(index), 'utf-8')
  } catch {
    // Non-fatal
  }
}

/**
 * Remove an entry from the index.
 */
export async function removeIndexEntry(id: string): Promise<void> {
  const index = await loadIndex()
  delete index.entries[id]
  cachedIndex = index

  try {
    await writeFile(getIndexPath(), JSON.stringify(index), 'utf-8')
  } catch {
    // Non-fatal
  }
}

/**
 * Search index by metadata fields (fast — no file I/O per session).
 */
export async function searchIndex(query: string, limit: number = 20): Promise<SessionMeta[]> {
  const index = await loadIndex()
  const lower = query.toLowerCase()
  const results: SessionMeta[] = []

  for (const meta of Object.values(index.entries)) {
    if (results.length >= limit) break
    const searchable = [meta.id, meta.model, meta.preview, ...(meta.tags ?? [])].join(' ').toLowerCase()
    if (searchable.includes(lower)) {
      results.push(meta)
    }
  }

  return results
}

/**
 * Get all entries from the index as sorted array.
 */
export async function getAllIndexed(limit: number = 100): Promise<SessionMeta[]> {
  const index = await loadIndex()
  return Object.values(index.entries)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
}

/**
 * Get index stats.
 */
export async function getIndexStats(): Promise<{ count: number; builtAt: string }> {
  const index = await loadIndex()
  return { count: Object.keys(index.entries).length, builtAt: index.builtAt }
}

/**
 * Clear cached index (for testing).
 */
export function clearIndexCache(): void {
  cachedIndex = null
  cachedIndexMtime = 0
}
