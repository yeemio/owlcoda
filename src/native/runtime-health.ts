import { existsSync, readFileSync } from 'node:fs'
import { getRunWorkspacePaths, type ArtifactLedger } from './run-workspace.js'
import { listJobs, type JobRecord } from './job-supervisor.js'
import { NATIVE_TOOL_SCHEMAS } from './tool-defs.js'

export type RuntimeSubsystemStatus = 'ok' | 'warn' | 'error' | 'not_configured'

export interface RuntimeHealthSnapshot {
  schemaVersion: 1
  generatedAt: string
  subsystems: {
    jobSupervisor: {
      status: RuntimeSubsystemStatus
      jobCount: number
      running: number
      failed: number
      timeout: number
      browserJobCount: number
      recentFailures: RuntimeJobFailureSummary[]
    }
    browserRuntime: {
      status: RuntimeSubsystemStatus
      providers: string[]
      realBrowserProvider: boolean
      note: string
    }
    artifactRegistry: {
      status: RuntimeSubsystemStatus
      path: string
      artifactCount: number
      missingCount: number
      note?: string
    }
    toolRisk: {
      status: RuntimeSubsystemStatus
      schemaCount: number
      safeReadonlyLocal: boolean
    }
  }
}

export interface RuntimeJobFailureSummary {
  jobId: string
  type: string
  status: string
  stage: string
  updatedAt: string
  tool?: string
  provider?: string
  source?: {
    kind: string
    id: string
  }
  terminationReason?: string
  error?: string
  recoveryHint?: string
}

export interface RuntimeHealthSnapshotOptions {
  projectRoot: string
  now?: Date
}

export function buildRuntimeHealthSnapshot(options: RuntimeHealthSnapshotOptions): RuntimeHealthSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: (options.now ?? new Date()).toISOString(),
    subsystems: {
      jobSupervisor: buildJobSupervisorHealth(),
      browserRuntime: {
        status: 'warn',
        providers: ['fetch_html', 'chrome_headless'],
        realBrowserProvider: true,
        note: 'BrowserJob supports fetch_html and chrome_headless via a local Chrome/Chromium executable; Chrome is not bundled and may need chromeExecutablePath.',
      },
      artifactRegistry: buildArtifactRegistryHealth(options.projectRoot),
      toolRisk: {
        status: 'ok',
        schemaCount: Object.keys(NATIVE_TOOL_SCHEMAS).length,
        safeReadonlyLocal: true,
      },
    },
  }
}

function buildJobSupervisorHealth(): RuntimeHealthSnapshot['subsystems']['jobSupervisor'] {
  const jobs = listJobs()
  const recentFailures = jobs
    .filter(job => job.status === 'failed' || job.status === 'timeout')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5)
    .map(summarizeJobFailure)
  return {
    status: recentFailures.length > 0 ? 'warn' : 'ok',
    jobCount: jobs.length,
    running: jobs.filter(job => job.status === 'running' || job.status === 'waiting').length,
    failed: jobs.filter(job => job.status === 'failed').length,
    timeout: jobs.filter(job => job.status === 'timeout').length,
    browserJobCount: jobs.filter(job => job.type === 'browser').length,
    recentFailures,
  }
}

function summarizeJobFailure(job: JobRecord): RuntimeJobFailureSummary {
  return {
    jobId: job.jobId,
    type: job.type,
    status: job.status,
    stage: job.stage,
    updatedAt: job.updatedAt,
    ...(job.tool ? { tool: job.tool } : {}),
    ...(job.provider ? { provider: job.provider } : {}),
    ...(job.source ? { source: { ...job.source } } : {}),
    ...(job.terminationReason ? { terminationReason: job.terminationReason } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.recoveryHint ? { recoveryHint: job.recoveryHint } : {}),
  }
}

function buildArtifactRegistryHealth(projectRoot: string): RuntimeHealthSnapshot['subsystems']['artifactRegistry'] {
  const paths = getRunWorkspacePaths(projectRoot, projectRoot)
  if (!existsSync(paths.artifactsPath)) {
    return {
      status: 'not_configured',
      path: paths.artifactsPath,
      artifactCount: 0,
      missingCount: 0,
      note: 'No .owlcoda-run/artifacts.json found at the project root.',
    }
  }

  try {
    const ledger = JSON.parse(readFileSync(paths.artifactsPath, 'utf8')) as ArtifactLedger
    const artifacts = Array.isArray(ledger.artifacts) ? ledger.artifacts : []
    return {
      status: 'ok',
      path: paths.artifactsPath,
      artifactCount: artifacts.length,
      missingCount: artifacts.filter(artifact => artifact.status === 'missing').length,
    }
  } catch (err) {
    return {
      status: 'error',
      path: paths.artifactsPath,
      artifactCount: 0,
      missingCount: 0,
      note: err instanceof Error ? err.message : String(err),
    }
  }
}
