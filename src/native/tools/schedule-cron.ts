/**
 * OwlCoda Native ScheduleCron Tool
 *
 * Manages scheduled tasks using cron-style expressions.
 * Supports create, list, and delete operations.
 *
 * Implementation notes:
 * - Local-first cron store for create/list/delete operations.
 * - The interface intentionally stays narrow so storage can graduate later.
 */

import type { NativeToolDef, ToolResult } from './types.js'

export interface CronJob {
  id: string
  schedule: string
  command: string
  description: string
  enabled: boolean
  createdAt: string
  lastRun?: string
}

const cronJobs = new Map<string, CronJob>()
let cronCounter = 0

export function resetCronStore(): void {
  cronJobs.clear()
  cronCounter = 0
}

export function listCronJobs(): CronJob[] {
  return [...cronJobs.values()]
}

export interface ScheduleCronInput {
  action: 'create' | 'list' | 'delete'
  schedule?: string
  command?: string
  description?: string
  cron_id?: string
}

export function createScheduleCronTool(): NativeToolDef<ScheduleCronInput> {
  return {
    name: 'ScheduleCron',
    description:
      'Manage scheduled tasks with cron expressions. ' +
      'Actions: create (new job), list (all jobs), delete (by ID).',
    maturity: 'experimental' as const,

    async execute(input: ScheduleCronInput): Promise<ToolResult> {
      const { action } = input

      if (!action) {
        return { output: 'Error: action is required (create, list, delete).', isError: true }
      }

      switch (action) {
        case 'create': {
          const { schedule, command, description } = input
          if (!schedule || !command) {
            return { output: 'Error: schedule and command are required for create.', isError: true }
          }

          cronCounter++
          const id = `cron-${cronCounter}`
          const job: CronJob = {
            id,
            schedule,
            command,
            description: description ?? '',
            enabled: true,
            createdAt: new Date().toISOString(),
          }
          cronJobs.set(id, job)

          return {
            output: `Created cron job ${id}: "${command}" @ ${schedule}`,
            isError: false,
            metadata: { cron_id: id, action: 'created' },
          }
        }

        case 'list': {
          const jobs = listCronJobs()
          if (jobs.length === 0) {
            return { output: 'No scheduled cron jobs.', isError: false, metadata: { jobs: [] } }
          }

          const lines = jobs.map(j => {
            const status = j.enabled ? '✓' : '○'
            return `${status} ${j.id}: "${j.command}" @ ${j.schedule}${j.description ? ` — ${j.description}` : ''}`
          })

          return {
            output: `Cron jobs (${jobs.length}):\n${lines.join('\n')}`,
            isError: false,
            metadata: { jobs },
          }
        }

        case 'delete': {
          const { cron_id } = input
          if (!cron_id) {
            return { output: 'Error: cron_id is required for delete.', isError: true }
          }
          if (!cronJobs.has(cron_id)) {
            return { output: `Cron job "${cron_id}" not found.`, isError: true }
          }
          cronJobs.delete(cron_id)
          return {
            output: `Deleted cron job ${cron_id}.`,
            isError: false,
            metadata: { cron_id, action: 'deleted' },
          }
        }

        default:
          return { output: `Unknown action "${action}". Use: create, list, delete.`, isError: true }
      }
    },
  }
}
