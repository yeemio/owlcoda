import { lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli as runRunKitCore } from '../../../scripts/runkit-contract/runkit-cli.mjs'
import {
  parseRunKitInspectSummary,
  projectRunKitInspectResult,
  readRuntimeRail,
  type RunKitInspectSummary,
  type RunKitRailState,
} from '../../../src/native/app-server/runtime-rail-service.js'

describe('runtime-rail-service', () => {
  it('returns explicit missing state when project-owned RunKit truth is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'owlcoda-no-runkit-'))

    const state: RunKitRailState = await readRuntimeRail({ projectId: 'missing-project', projectRoot: root })

    expect(state).toEqual({
      projectId: 'missing-project',
      freshness: 'missing',
      summary: null,
      executionHistory: [],
      source: 'not_connected',
    })
  })

  it('consumes the authoritative Core inspect summary without terminal parsing', async () => {
    const root = await initializedRunKitProject()
    const before = snapshotTree(join(root, '.owlcoda', 'runkit'))

    const state = await readRuntimeRail({ projectId: 'project-1', projectRoot: root })

    expect(state).toMatchObject({
      projectId: 'project-1',
      freshness: 'fresh',
      source: 'owlcoda_runkit_inspect_summary',
      summary: {
        schemaVersion: 'OwlCodaRunKitInspectSummaryV1',
        currentExecution: {
          state: 'no_active_execution',
          selectedRunId: null,
          activeRunIds: [],
          openCount: 0,
        },
        latestIndexedCloseout: null,
        source: { status: 'none', sourceFingerprint: null },
        leases: { activeCount: 0, holders: [] },
        evidence: {
          status: 'none',
          decision: null,
          activeReceiptSha256: null,
          trustLevel: 'none',
        },
        dominantGap: { code: 'plan_new_execution', reasons: [] },
        nextAllowedAction: 'plan_new_execution',
        authorizationGranted: false,
        gitAuthorization: false,
        releaseAuthorization: false,
      },
    })
    expect(snapshotTree(join(root, '.owlcoda', 'runkit'))).toEqual(before)
  })

  it('never treats legacy .owlrunkit packets as the contextual rail source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'owlcoda-legacy-runkit-'))
    mkdirSync(join(root, '.owlrunkit', 'agent-inbox'), { recursive: true })
    writeFileSync(join(root, '.owlrunkit', 'agent-inbox', 'legacy.packet.json'), JSON.stringify({
      truth_fingerprint: 'legacy-fingerprint',
      gate: { current_gate: 'legacy-gate' },
    }))

    const state = await readRuntimeRail({ projectId: 'legacy', projectRoot: root })

    expect(state.freshness).toBe('missing')
    expect(state.summary).toBeNull()
    expect(state.source).toBe('not_connected')
  })

  it('fails closed instead of reporting missing when the .owlcoda ancestor is redirected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'owlcoda-runkit-redirect-root-'))
    const external = await mkdtemp(join(tmpdir(), 'owlcoda-runkit-redirect-target-'))
    symlinkSync(external, join(root, '.owlcoda'), 'dir')

    const state = await readRuntimeRail({ projectId: 'redirected', projectRoot: root })

    expect(state.freshness).toBe('error')
    expect(state.source).toBe('owlcoda_runkit_error')
    expect(state.summary).toMatchObject({
      currentExecution: { state: 'invalid_control_truth' },
      nextAllowedAction: 'repair_execution_artifacts',
      releaseAuthorization: false,
    })
  })

  it('supplies a fixed repair action when project control truth cannot be inspected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'owlcoda-runkit-invalid-control-root-'))
    writeFileSync(join(root, '.owlcoda'), 'not-a-directory')

    const state = await readRuntimeRail({ projectId: 'unreadable', projectRoot: root })

    expect(state).toEqual({
      projectId: 'unreadable',
      freshness: 'error',
      summary: null,
      executionHistory: [],
      source: 'owlcoda_runkit_error',
      error: 'RunKit Core returned an invalid inspect result.',
      repairAction: 'repair_execution_artifacts',
    })
  })

  it('fails closed when project-owned RunKit control truth is invalid', async () => {
    const root = await initializedRunKitProject()
    writeFileSync(join(root, '.owlcoda', 'runkit', 'config.json'), '{invalid-json')

    const state = await readRuntimeRail({ projectId: 'invalid', projectRoot: root })

    expect(state.freshness).toBe('error')
    expect(state.summary).toMatchObject({
      currentExecution: { state: 'invalid_control_truth' },
      dominantGap: {
        code: 'repair_execution_artifacts',
        reasons: [expect.stringContaining('valid JSON')],
      },
      nextAllowedAction: 'repair_execution_artifacts',
      authorizationGranted: false,
      gitAuthorization: false,
      releaseAuthorization: false,
    })
    expect(state.source).toBe('owlcoda_runkit_error')
    expect(state.error).toContain('JSON')
  })

  it('preserves the Core repair projection but marks ambiguous active runs as error', async () => {
    const root = await initializedRunKitProject()
    const goalPath = join(root, 'goal.json')
    writeFileSync(goalPath, JSON.stringify({ title: 'rail ambiguity fixture' }))
    expect((await runRunKitCore(['plan', '--workspace', root, '--run-id', 'run-a', '--goal', goalPath])).exitCode).toBe(0)
    expect((await runRunKitCore(['plan', '--workspace', root, '--run-id', 'run-b', '--goal', goalPath])).exitCode).toBe(0)

    const state = await readRuntimeRail({ projectId: 'ambiguous', projectRoot: root })

    expect(state.freshness).toBe('error')
    expect(state.source).toBe('owlcoda_runkit_error')
    expect(state.summary).toMatchObject({
      currentExecution: {
        state: 'multiple_active_executions',
        selectedRunId: null,
        activeRunIds: ['run-a', 'run-b'],
        openCount: 2,
      },
      dominantGap: { code: 'select_active_execution' },
      nextAllowedAction: 'select_active_execution',
      authorizationGranted: false,
      gitAuthorization: false,
      releaseAuthorization: false,
    })
  })

  it('projects error detail only from the validated inspect summary', () => {
    const summary = validInspectSummary({
      dominantGap: {
        code: 'repair_execution_artifacts',
        reasons: ['summary-owned repair reason'],
      },
      nextAllowedAction: 'repair_execution_artifacts',
    })

    const state = projectRunKitInspectResult('project-1', {
      status: 'inspected',
      exitCode: 2,
      issues: ['untrusted full-document issue'],
      controlIssues: ['untrusted control-plane detail'],
      summary,
      executions: [],
    })

    expect(state).toMatchObject({
      freshness: 'error',
      summary,
      error: 'summary-owned repair reason',
      repairAction: 'repair_execution_artifacts',
    })
    expect(state.error).not.toContain('untrusted')
  })

  it('accepts the typed read-only model resource projection', () => {
    const summary = validInspectSummary({ resourcePreflight: validResourcePreflightSummary() })

    expect(parseRunKitInspectSummary(summary)).toEqual(summary)
  })

  it('projects Core execution history into a path-free authorization-free rail summary', () => {
    const state = projectRunKitInspectResult('project-1', {
      status: 'inspected',
      exitCode: 0,
      summary: validInspectSummary(),
      executions: [
        rawActiveExecution('run-active'),
        rawClosedExecution('run-accepted', 'accepted', false),
        rawClosedExecution('run-blocked', 'blocked', false),
        rawClosedExecution('run-historical', 'accepted', true),
      ],
      runtimeRoot: '/Users/alice/private/.owlcoda/runkit',
      receiptPath: '/Users/alice/private/verification-receipt.json',
    })

    expect(state.freshness).toBe('fresh')
    expect(state.executionHistory).toEqual([
      {
        runId: 'run-active',
        state: 'active',
        decision: null,
        trustLevel: 'work_in_progress',
        nextAllowedAction: 'continue_feature_work',
        authorizationGranted: false,
      },
      {
        runId: 'run-accepted',
        state: 'accepted',
        decision: 'accepted',
        trustLevel: 'closed_accepted',
        nextAllowedAction: 'plan_new_execution',
        authorizationGranted: false,
      },
      {
        runId: 'run-blocked',
        state: 'blocked_or_rejected',
        decision: 'blocked',
        trustLevel: 'closed_nonaccepted',
        nextAllowedAction: 'plan_new_execution',
        authorizationGranted: false,
      },
      {
        runId: 'run-historical',
        state: 'archived_historical',
        decision: 'accepted',
        trustLevel: 'closed_accepted',
        nextAllowedAction: 'plan_new_execution',
        authorizationGranted: false,
      },
    ])
    expect(JSON.stringify(state)).not.toMatch(/Users|receiptPath|verification-receipt/)
  })

  it('fails closed when raw execution history tries to widen authorization or expose a path-shaped id', () => {
    const state = projectRunKitInspectResult('project-1', {
      status: 'inspected',
      exitCode: 0,
      summary: validInspectSummary(),
      executions: [{
        ...rawClosedExecution('/Users/alice/private', 'accepted', false),
        closeout: { status: 'valid', decision: 'accepted', authorizationGranted: true },
      }],
    })

    expect(state).toMatchObject({
      freshness: 'error',
      source: 'owlcoda_runkit_error',
      executionHistory: [],
      repairAction: 'plan_new_execution',
    })
    expect(JSON.stringify(state)).not.toContain('/Users/alice/private')
  })

  it.each([
    ['wrong schema version', { schemaVersion: 'OwlCodaRunKitInspectSummaryV2' }],
    ['missing field', { evidence: undefined }],
    ['authorization widened', { authorizationGranted: true }],
    ['Git authorization widened', { gitAuthorization: true }],
    ['release authorization widened', { releaseAuthorization: true }],
    ['malformed open count', { currentExecution: { ...validInspectSummary().currentExecution, openCount: '0' } }],
    ['malformed lease holder', { leases: { activeCount: 1, holders: [{ runId: 'run-1', workItemId: 2 }] } }],
    ['malformed resource estimate', {
      resourcePreflight: {
        ...validInspectSummary().resourcePreflight,
        estimate: { ...validInspectSummary().resourcePreflight.estimate, totalTokens: 1 },
      },
    }],
    ['unsupported resource availability', {
      resourcePreflight: validResourcePreflightSummary({
        resources: [{
          ...validResourcePreflightSummary().resources[0],
          availability: { status: 'maybe' },
        }],
      }),
    }],
    ['resource selection inconsistent with none', {
      resourcePreflight: {
        ...validResourcePreflightSummary(),
        status: 'none',
      },
    }],
  ])('rejects a %s at the summary adapter boundary', (_label, override) => {
    expect(parseRunKitInspectSummary({ ...validInspectSummary(), ...override })).toBeNull()
  })

  it('loads the Core as a programmatic module rather than spawning or scraping a CLI', () => {
    const source = readFileSync(join(process.cwd(), 'src/native/app-server/runtime-rail-service.ts'), 'utf8')
    expect(source).toContain("runCli(['inspect', '--json', '--workspace', projectRoot])")
    expect(source).not.toMatch(/child_process|execFile|spawn|stdout|stderr/)
  })
})

async function initializedRunKitProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'owlcoda-runkit-rail-'))
  const initialized = await runRunKitCore(['init', '--workspace', root])
  expect(initialized.exitCode).toBe(0)
  return root
}

function snapshotTree(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {}
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name)
      const relativePath = entryPath.slice(root.length + 1)
      const stat = lstatSync(entryPath)
      if (stat.isDirectory()) visit(entryPath)
      else if (stat.isFile()) snapshot[relativePath] = readFileSync(entryPath, 'utf8')
      else snapshot[relativePath] = `non-regular:${stat.mode}`
    }
  }
  visit(root)
  return snapshot
}

function validInspectSummary(
  override: Partial<RunKitInspectSummary> = {},
): RunKitInspectSummary {
  return {
    schemaVersion: 'OwlCodaRunKitInspectSummaryV1',
    currentExecution: {
      state: 'no_active_execution',
      selectedRunId: null,
      activeRunIds: [],
      openCount: 0,
    },
    latestIndexedCloseout: null,
    source: { status: 'none', sourceFingerprint: null },
    leases: { activeCount: 0, holders: [] },
    evidence: {
      status: 'none',
      decision: null,
      activeReceiptSha256: null,
      trustLevel: 'none',
    },
    resourcePreflight: {
      status: 'none',
      preflightId: null,
      sequence: null,
      evaluatedAt: null,
      validUntil: null,
      decision: null,
      nextAllowedAction: null,
      blockers: [],
      warnings: [],
      receiptReuse: { reusableCount: 0, appliedCount: 0 },
      estimate: {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        elapsedMs: 0,
        cost: { status: 'known', valueUsd: 0 },
      },
      resources: [],
    },
    dominantGap: { code: 'plan_new_execution', reasons: [] },
    nextAllowedAction: 'plan_new_execution',
    authorizationGranted: false,
    gitAuthorization: false,
    releaseAuthorization: false,
    ...override,
  }
}

function validResourcePreflightSummary(
  override: Partial<RunKitInspectSummary['resourcePreflight']> = {},
): RunKitInspectSummary['resourcePreflight'] {
  return {
    status: 'current',
    preflightId: 'resource-preflight-1',
    sequence: 1,
    evaluatedAt: '2026-07-17T10:00:00.000Z',
    validUntil: '2026-07-17T10:05:00.000Z',
    decision: 'ready_for_model_execution',
    nextAllowedAction: 'begin_model_execution',
    blockers: [],
    warnings: [],
    receiptReuse: { reusableCount: 1, appliedCount: 0 },
    estimate: {
      calls: 2,
      inputTokens: 1000,
      outputTokens: 100,
      totalTokens: 1100,
      elapsedMs: 5000,
      cost: { status: 'known', valueUsd: 0.002 },
    },
    resources: [{
      providerId: 'kimi',
      modelId: 'k2.5',
      availability: { status: 'available' },
      quota: {
        remainingCalls: { status: 'known', value: 20 },
        remainingTokens: { status: 'known', value: 10_000 },
        resetAt: { status: 'unknown', reason: 'provider_not_exposed' },
      },
      demand: {
        calls: 2,
        inputTokens: 1000,
        outputTokens: 100,
        totalTokens: 1100,
        elapsedMs: 5000,
      },
    }],
    ...override,
  }
}

function rawActiveExecution(runId: string) {
  return {
    runId,
    lifecycle: 'active',
    historical: false,
    recovery: {
      evidenceTrustLevel: 'work_in_progress',
      nextAllowedAction: 'continue_feature_work',
    },
  }
}

function rawClosedExecution(runId: string, decision: 'accepted' | 'blocked' | 'rejected', historical: boolean) {
  return {
    runId,
    lifecycle: 'closed',
    historical,
    closeout: { status: 'valid', decision, authorizationGranted: false },
    recovery: {
      evidenceTrustLevel: decision === 'accepted' ? 'closed_accepted' : 'closed_nonaccepted',
      nextAllowedAction: 'plan_new_execution',
    },
  }
}
