import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

export interface ProjectSummary {
  id: string
  name: string
  root: string
  source: 'cwd'
}

export interface ProjectListResult {
  projects: ProjectSummary[]
}

export function listProjects(projectRoot = process.cwd()): ProjectListResult {
  const root = resolve(projectRoot)
  return {
    projects: [{
      id: stableProjectId(root),
      name: readPackageName(root) ?? basename(root),
      root,
      source: 'cwd',
    }],
  }
}

function stableProjectId(root: string): string {
  return root.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'
}

function readPackageName(root: string): string | null {
  try {
    const raw = readFileSync(resolve(root, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { name?: unknown }
    return typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name : null
  } catch {
    return null
  }
}
