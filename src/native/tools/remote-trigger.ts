/**
 * OwlCoda Native RemoteTrigger Tool
 *
 * Manages remote agent triggers (list, get, create, update, run, cleanup).
 * In local-LLM mode, operates against a local file-based store.
 *
 * Implementation notes:
 * - Local file store (~/.owlcoda/triggers/) for offline-friendly triggers.
 * - list defaults to a small limit so historical CI noise can't blow LLM
 *   context budgets. Use `prefix` / `since` to filter and `limit` to widen.
 * - cleanup is opt-in: dry-run by default, requires `confirm: true` to
 *   actually delete files. Avoids silent destruction of user data.
 * - Remote sync can be added later without changing the tool surface.
 */

import { readFile, writeFile, readdir, mkdir, stat, unlink, access } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { NativeToolDef, ToolResult } from './types.js'

export interface RemoteTriggerInput {
  action: 'list' | 'get' | 'create' | 'update' | 'run' | 'cleanup'
  trigger_id?: string
  body?: Record<string, unknown>
  /** list/cleanup: filter by trigger_id prefix (e.g. "test-") */
  prefix?: string
  /** list: maximum number of triggers to return (default 50) */
  limit?: number
  /** list: only include triggers created on/after this ISO date */
  since?: string
  /** cleanup: delete triggers older than this ISO date (mutually exclusive with `olderThanDays`) */
  before?: string
  /** cleanup: delete triggers older than N days */
  olderThanDays?: number
  /** cleanup: must be true to actually delete (otherwise dry-run preview) */
  confirm?: boolean
}

const DEFAULT_LIST_LIMIT = 50

function getTriggersDir(): string {
  // Allow override for tests / sandboxed environments.
  const override = process.env.OWLCODA_TRIGGERS_DIR
  if (override && override.length > 0) return override
  return join(homedir(), '.owlcoda', 'triggers')
}

interface TriggerRecord {
  id: string
  createdAt?: string
  updatedAt?: string
  lastRun?: string
  description?: string
  [key: string]: unknown
}

interface LoadedTrigger {
  file: string
  path: string
  data: TriggerRecord
  /** ms since epoch — used as the canonical "age" reference */
  ageMs: number
}

async function loadTriggerFile(dir: string, file: string): Promise<LoadedTrigger | null> {
  const path = join(dir, file)
  try {
    const raw = await readFile(path, 'utf-8')
    const data = JSON.parse(raw) as TriggerRecord
    let ageMs = NaN
    if (typeof data.createdAt === 'string') ageMs = Date.parse(data.createdAt)
    if (Number.isNaN(ageMs)) {
      // Fallback: filesystem mtime
      const st = await stat(path)
      ageMs = st.mtimeMs
    }
    return { file, path, data, ageMs }
  } catch {
    return null
  }
}

export function createRemoteTriggerTool(): NativeToolDef<RemoteTriggerInput> {
  return {
    name: 'RemoteTrigger',
    description:
      'Manage remote agent triggers. Actions: list, get, create, update, run, cleanup. ' +
      'list supports `prefix`, `limit` (default 50), `since`. cleanup supports `prefix`, ' +
      '`before`/`olderThanDays`, requires `confirm: true` to actually delete.',
    maturity: 'experimental' as const,

    async execute(input: RemoteTriggerInput): Promise<ToolResult> {
      const { action, trigger_id, body } = input

      if (!action) {
        return { output: 'Error: action is required.', isError: true }
      }

      const dir = getTriggersDir()
      await mkdir(dir, { recursive: true })

      switch (action) {
        case 'list': {
          let files: string[]
          try {
            files = (await readdir(dir)).filter(f => f.endsWith('.json'))
          } catch {
            return { output: 'No triggers found.', isError: false, metadata: { triggers: [] } }
          }
          if (files.length === 0) {
            return { output: 'No triggers found.', isError: false, metadata: { triggers: [] } }
          }

          const loaded = (await Promise.all(files.map(f => loadTriggerFile(dir, f))))
            .filter((t): t is LoadedTrigger => t !== null)

          // Apply filters
          const prefix = input.prefix
          const sinceMs = input.since ? Date.parse(input.since) : NaN
          let filtered = loaded
          if (prefix) {
            filtered = filtered.filter(t => typeof t.data.id === 'string' && t.data.id.startsWith(prefix))
          }
          if (!Number.isNaN(sinceMs)) {
            filtered = filtered.filter(t => t.ageMs >= sinceMs)
          }

          const totalAll = loaded.length
          const totalMatching = filtered.length

          // Sort newest first so the most relevant triggers survive truncation.
          filtered.sort((a, b) => b.ageMs - a.ageMs)

          const rawLimit = typeof input.limit === 'number' && Number.isFinite(input.limit)
            ? Math.max(0, Math.floor(input.limit))
            : DEFAULT_LIST_LIMIT
          const limit = rawLimit
          const truncated = filtered.length > limit
          const shown = truncated ? filtered.slice(0, limit) : filtered

          if (shown.length === 0) {
            const filterDesc = [
              prefix ? `prefix="${prefix}"` : null,
              !Number.isNaN(sinceMs) ? `since="${input.since}"` : null,
            ].filter(Boolean).join(', ')
            const msg = filterDesc
              ? `No triggers match filter (${filterDesc}). Total in store: ${totalAll}.`
              : 'No triggers found.'
            return {
              output: msg,
              isError: false,
              metadata: { triggers: [], totalAll, totalMatching },
            }
          }

          const items = shown.map(t => t.data)
          const lines = items.map(t => `  ${t.id}: ${t.description ?? '(no description)'}`)

          let header: string
          if (truncated) {
            const filterDesc = [
              prefix ? `prefix="${prefix}"` : null,
              !Number.isNaN(sinceMs) ? `since="${input.since}"` : null,
            ].filter(Boolean).join(', ')
            const filterSuffix = filterDesc ? ` matching ${filterDesc}` : ''
            header = `Triggers (showing ${shown.length} of ${totalMatching}${filterSuffix}; ${totalAll} total in store):`
          } else {
            header =
              totalMatching === totalAll
                ? `Triggers (${shown.length}):`
                : `Triggers (${shown.length} of ${totalAll} total in store):`
          }

          let output = `${header}\n${lines.join('\n')}`
          if (truncated) {
            output += `\n... (${totalMatching} total, showing ${shown.length}; use \`limit: N\` to widen, or \`prefix\`/\`since\` to filter, or \`action: 'cleanup'\` to prune old triggers)`
          }

          return {
            output,
            isError: false,
            metadata: {
              triggers: items,
              totalAll,
              totalMatching,
              shown: shown.length,
              truncated,
            },
          }
        }

        case 'get': {
          if (!trigger_id) return { output: 'Error: trigger_id required for get.', isError: true }
          try {
            const raw = await readFile(join(dir, `${trigger_id}.json`), 'utf-8')
            return { output: raw, isError: false, metadata: JSON.parse(raw) }
          } catch {
            return { output: `Trigger "${trigger_id}" not found.`, isError: true }
          }
        }

        case 'create': {
          if (!body) return { output: 'Error: body required for create.', isError: true }
          const id = body.id as string ?? `trigger-${Date.now()}`
          const trigger = { id, ...body, createdAt: new Date().toISOString() }
          await writeFile(join(dir, `${id}.json`), JSON.stringify(trigger, null, 2), 'utf-8')
          return {
            output: `Created trigger ${id}.`,
            isError: false,
            metadata: { trigger_id: id },
          }
        }

        case 'update': {
          if (!trigger_id) return { output: 'Error: trigger_id required for update.', isError: true }
          if (!body) return { output: 'Error: body required for update.', isError: true }
          const path = join(dir, `${trigger_id}.json`)
          try {
            await access(path)
          } catch {
            return { output: `Trigger "${trigger_id}" not found.`, isError: true }
          }
          const existing = JSON.parse(await readFile(path, 'utf-8'))
          const updated = { ...existing, ...body, updatedAt: new Date().toISOString() }
          await writeFile(path, JSON.stringify(updated, null, 2), 'utf-8')
          return { output: `Updated trigger ${trigger_id}.`, isError: false, metadata: { trigger_id } }
        }

        case 'run': {
          if (!trigger_id) return { output: 'Error: trigger_id required for run.', isError: true }
          try {
            const raw = await readFile(join(dir, `${trigger_id}.json`), 'utf-8')
            const trigger = JSON.parse(raw)
            trigger.lastRun = new Date().toISOString()
            await writeFile(join(dir, `${trigger_id}.json`), JSON.stringify(trigger, null, 2), 'utf-8')
            return {
              output: `Triggered ${trigger_id}. Last run: ${trigger.lastRun}`,
              isError: false,
              metadata: { trigger_id, lastRun: trigger.lastRun },
            }
          } catch {
            return { output: `Trigger "${trigger_id}" not found.`, isError: true }
          }
        }

        case 'cleanup': {
          // Resolve cutoff
          let cutoffMs: number | null = null
          if (typeof input.before === 'string') {
            const parsed = Date.parse(input.before)
            if (Number.isNaN(parsed)) {
              return {
                output: `Error: invalid \`before\` date "${input.before}".`,
                isError: true,
              }
            }
            cutoffMs = parsed
          } else if (typeof input.olderThanDays === 'number' && Number.isFinite(input.olderThanDays)) {
            if (input.olderThanDays < 0) {
              return { output: 'Error: `olderThanDays` must be >= 0.', isError: true }
            }
            cutoffMs = Date.now() - input.olderThanDays * 24 * 60 * 60 * 1000
          }

          const prefix = input.prefix
          if (cutoffMs === null && !prefix) {
            return {
              output:
                'Error: cleanup requires at least one filter (`prefix`, `before`, or `olderThanDays`) to avoid mass deletion.',
              isError: true,
            }
          }

          let files: string[]
          try {
            files = (await readdir(dir)).filter(f => f.endsWith('.json'))
          } catch {
            return {
              output: 'No triggers found.',
              isError: false,
              metadata: { deleted: [], totalAll: 0, matched: 0 },
            }
          }

          const loaded = (await Promise.all(files.map(f => loadTriggerFile(dir, f))))
            .filter((t): t is LoadedTrigger => t !== null)

          const matched = loaded.filter(t => {
            if (prefix && !(typeof t.data.id === 'string' && t.data.id.startsWith(prefix))) {
              return false
            }
            if (cutoffMs !== null && !(t.ageMs < cutoffMs)) {
              return false
            }
            return true
          })

          const filterDesc = [
            prefix ? `prefix="${prefix}"` : null,
            cutoffMs !== null && typeof input.before === 'string' ? `before="${input.before}"` : null,
            cutoffMs !== null && typeof input.olderThanDays === 'number'
              ? `olderThanDays=${input.olderThanDays}`
              : null,
          ].filter(Boolean).join(', ')

          if (!input.confirm) {
            const sample = matched.slice(0, 10).map(m => m.data.id).filter(Boolean)
            const sampleSuffix = matched.length > sample.length ? `, ... (+${matched.length - sample.length} more)` : ''
            return {
              output:
                `Cleanup dry-run (${filterDesc}): ${matched.length} of ${loaded.length} triggers would be deleted.` +
                (matched.length > 0
                  ? `\nSample: ${sample.join(', ')}${sampleSuffix}\nPass \`confirm: true\` to actually delete.`
                  : ''),
              isError: false,
              metadata: {
                dryRun: true,
                matched: matched.length,
                totalAll: loaded.length,
                ids: matched.map(m => m.data.id),
              },
            }
          }

          const deleted: string[] = []
          const errors: string[] = []
          for (const m of matched) {
            try {
              await unlink(m.path)
              if (typeof m.data.id === 'string') deleted.push(m.data.id)
            } catch (err) {
              errors.push(`${m.data.id ?? m.file}: ${(err as Error).message}`)
            }
          }

          let output = `Cleanup (${filterDesc}): deleted ${deleted.length} of ${loaded.length} triggers.`
          if (errors.length > 0) {
            output += `\nErrors (${errors.length}): ${errors.slice(0, 5).join('; ')}`
          }
          return {
            output,
            isError: errors.length > 0 && deleted.length === 0,
            metadata: {
              dryRun: false,
              deleted,
              errors,
              matched: matched.length,
              totalAll: loaded.length,
            },
          }
        }

        default:
          return { output: `Unknown action "${action}".`, isError: true }
      }
    },
  }
}
