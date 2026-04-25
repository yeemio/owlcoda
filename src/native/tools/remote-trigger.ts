/**
 * OwlCoda Native RemoteTrigger Tool
 *
 * Manages remote agent triggers (list, get, create, update, run).
 * In local-LLM mode, operates against a local file-based store.
 *
 * Implementation notes:
 * - Local file store (~/.owlcoda/triggers/) for offline-friendly triggers.
 * - Remote sync can be added later without changing the tool surface.
 */

import { readFile, writeFile, readdir, mkdir, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { NativeToolDef, ToolResult } from './types.js'

export interface RemoteTriggerInput {
  action: 'list' | 'get' | 'create' | 'update' | 'run'
  trigger_id?: string
  body?: Record<string, unknown>
}

function getTriggersDir(): string {
  return join(homedir(), '.owlcoda', 'triggers')
}

export function createRemoteTriggerTool(): NativeToolDef<RemoteTriggerInput> {
  return {
    name: 'RemoteTrigger',
    description:
      'Manage remote agent triggers. Actions: list, get, create, update, run.',
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
          try {
            const files = await readdir(dir)
            const triggers = files.filter(f => f.endsWith('.json'))
            if (triggers.length === 0) {
              return { output: 'No triggers found.', isError: false, metadata: { triggers: [] } }
            }
            const items = await Promise.all(
              triggers.map(async f => {
                const raw = await readFile(join(dir, f), 'utf-8')
                return JSON.parse(raw)
              }),
            )
            return {
              output: `Triggers (${items.length}):\n${items.map(t => `  ${t.id}: ${t.description ?? '(no description)'}`).join('\n')}`,
              isError: false,
              metadata: { triggers: items },
            }
          } catch {
            return { output: 'No triggers found.', isError: false, metadata: { triggers: [] } }
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

        default:
          return { output: `Unknown action "${action}".`, isError: true }
      }
    },
  }
}
