/**
 * TaskVerify tool tests — Slice 3, Task Execution Mode v1
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createServer, type Server } from 'node:http'
import { createTaskCreateTool } from '../../../src/native/tools/task-create.js'
import { createTaskVerifyTool } from '../../../src/native/tools/task-verify.js'
import {
  resetTaskStore,
  createTask,
  getTask,
  getTaskStep,
  updateTaskStep,
} from '../../../src/native/tools/task-store.js'
import type { ProjectMapSnapshot } from '../../../src/native/protocol/project-map-types.js'

const tool = createTaskVerifyTool()
const taskCreateTool = createTaskCreateTool()

let tmpDir: string

const ADR008_DESTRUCTIVE_VERIFY_COMMANDS = [
  'rm -rf /tmp/owlcoda-taskverify-nonexistent-adr008',
  'chmod -R 777 /tmp/owlcoda-taskverify-nonexistent-adr008',
  'dd if=/dev/zero of=/dev/null bs=1 count=1',
]

function makeTmpDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owlcoda-verify-test-'))
  return tmpDir
}

function cleanTmpDir() {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

beforeEach(() => {
  resetTaskStore()
  makeTmpDir()
})

afterEach(() => {
  cleanTmpDir()
})

function makeTaskWithVerification(checks: Array<{
  id: string
  kind: 'file_exists' | 'file_contains' | 'artifact_count' | 'verification_pack' | 'command' | 'none' | 'run_verdict_gate' | 'http_get'
  packId?: string
  path?: string
  pattern?: string
  root?: string
  glob?: string
  min?: number
  deckPath?: string
  expectedSections?: number
  buildNotesPath?: string
  requiredMarkers?: Array<string | { marker: string; label?: string }>
  minFileSizeBytes?: number
  minSectionBytes?: number
  forbiddenTerms?: string[]
  command?: string
  expectedExitCode?: number
  url?: string
  expectedStatus?: number
  bodyPattern?: string
  reason?: string
}>) {
  return createTask({
    subject: 'Verify test task',
    description: 'For testing TaskVerify',
    steps: [
      {
        title: 'Step to verify',
        description: 'the step',
        verification: checks.map(c => ({ ...c })),
      },
    ],
  })
}

describe('TaskVerify tool', () => {
  it('has correct name', () => {
    expect(tool.name).toBe('TaskVerify')
  })

  it('returns error for missing taskId', async () => {
    const r = await tool.execute({ taskId: '', stepId: 'step-1' })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('required')
  })

  it('returns error for missing stepId', async () => {
    createTask({ subject: 'X', description: 'Y', steps: [{ title: 'S', description: 'd' }] })
    const r = await tool.execute({ taskId: 'task-1', stepId: '' })
    expect(r.isError).toBe(true)
  })

  it('returns error for non-existent task', async () => {
    const r = await tool.execute({ taskId: 'task-999', stepId: 'step-1' })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('not found')
  })

  it('returns error for non-existent step', async () => {
    createTask({ subject: 'X', description: 'Y', steps: [{ title: 'S', description: 'd' }] })
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-99' })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('not found')
  })

  it('atomically completes passing steps and aggregates the parent task', async () => {
    const artifact = path.join(tmpDir, 'done.txt')
    fs.writeFileSync(artifact, 'done\n')
    const task = createTask({
      subject: 'Two steps',
      description: 'atomic verification',
      steps: [
        { title: 'One', description: 'one', verification: [{ id: 'one', kind: 'file_exists', path: artifact }] },
        { title: 'Two', description: 'two', verification: [{ id: 'two', kind: 'file_exists', path: artifact }] },
      ],
    })
    updateTaskStep(task.id, 'step-1', { status: 'in_progress' })

    const first = await tool.execute({ taskId: task.id, stepId: 'step-1' })

    expect(first.metadata).toMatchObject({ stepStatus: 'completed', taskStatus: 'in_progress' })
    expect(getTaskStep(task.id, 'step-1')?.status).toBe('completed')
    updateTaskStep(task.id, 'step-2', { status: 'in_progress' })
    const second = await tool.execute({ taskId: task.id, stepId: 'step-2' })
    expect(second.metadata).toMatchObject({ stepStatus: 'completed', taskStatus: 'completed' })
    expect(getTask(task.id)?.status).toBe('completed')
  })

  it('downgrades failed re-verification and restores clean completion on the next pass', async () => {
    const artifact = path.join(tmpDir, 'reverify.txt')
    fs.writeFileSync(artifact, 'done\n')
    const task = makeTaskWithVerification([{ id: 'artifact', kind: 'file_exists', path: artifact }])
    updateTaskStep(task.id, 'step-1', { status: 'in_progress' })
    await tool.execute({ taskId: task.id, stepId: 'step-1' })
    fs.unlinkSync(artifact)

    const failed = await tool.execute({ taskId: task.id, stepId: 'step-1' })

    expect(failed.metadata).toMatchObject({ stepStatus: 'failed', taskStatus: 'blocked' })
    expect(getTaskStep(task.id, 'step-1')?.failureReason).toContain('Re-verification failed')
    fs.writeFileSync(artifact, 'restored\n')

    const restored = await tool.execute({ taskId: task.id, stepId: 'step-1' })

    expect(restored.metadata).toMatchObject({ stepStatus: 'completed', taskStatus: 'completed' })
    expect(getTaskStep(task.id, 'step-1')?.failureReason).toBeUndefined()
  })

  it('fails when a command exits zero but expectedExitCode is non-zero', async () => {
    makeTaskWithVerification([{ id: 'expected-seven', kind: 'command', command: 'true', expectedExitCode: 7 }])

    const result = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })

    expect(result.metadata?.passed).toBe(false)
    expect(result.output).toContain('exit 0 (expected 7)')
  })

  it('passes when the actual non-zero command exit matches expectedExitCode', async () => {
    makeTaskWithVerification([{ id: 'expected-one', kind: 'command', command: 'false', expectedExitCode: 1 }])

    const result = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })

    expect(result.metadata?.passed).toBe(true)
    expect(result.output).toContain('exit 1 (expected)')
  })

  it('uses the same auditable python3 fallback as Bash command execution', async () => {
    const bin = path.join(tmpDir, 'bin')
    fs.mkdirSync(bin)
    fs.symlinkSync('/bin/bash', path.join(bin, 'bash'))
    fs.writeFileSync(path.join(bin, 'python3'), '#!/bin/sh\necho Python-3-fallback\n')
    fs.chmodSync(path.join(bin, 'python3'), 0o755)
    const previousPath = process.env.PATH
    process.env.PATH = bin
    try {
      makeTaskWithVerification([{ id: 'python-version', kind: 'command', command: 'python --version' }])
      const result = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })
      const check = (result.metadata?.results as Array<Record<string, any>>)[0]

      expect(check.passed).toBe(true)
      expect(check.metadata).toMatchObject({
        interpreterFallback: { requested: 'python', applied: 'python3' },
        requestedCommand: 'python --version',
        appliedCommand: 'python3 --version',
      })
    } finally {
      process.env.PATH = previousPath
    }
  })

  // 2026-06-13 dogfood (P2-11): list valid step ids so a model that invented a
  // bad id can self-correct instead of dead-ending.
  it('lists the available step ids when the requested step is missing', async () => {
    createTask({
      subject: 'X',
      description: 'Y',
      steps: [
        { title: 'first', description: 'a' },
        { title: 'second', description: 'b' },
      ],
    })
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-99' })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('not found')
    expect(r.output).toContain('step-1')
    expect(r.output).toContain('step-2')
  })

  it('returns success with empty results for step with no verification', async () => {
    createTask({ subject: 'X', description: 'Y', steps: [{ title: 'S', description: 'd' }] })
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('no verification checks')
  })

  // 2026-06-13 kimi-code dogfood: a TaskVerify whose check can NEVER pass as
  // authored (placeholder path `xxx`, missing root/glob) was re-run 3-6×
  // because TaskVerify returns isError:false and carries no failureCategory,
  // so the loop guard counts it as a successful call. Mark such results
  // `unsatisfiable` and tag failureCategory so the same-class loop guard
  // stops the model and tells it to fix the spec, not re-verify.
  describe('unsatisfiable-spec detection', () => {
    it('flags artifact_count missing root/glob as unsatisfiable, not retryable', async () => {
      makeTaskWithVerification([{ id: 'v1', kind: 'artifact_count', min: 1 }])
      const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })
      expect(r.metadata?.['failureCategory']).toBe('verify:unsatisfiable-spec')
      expect(r.output).toMatch(/can never pass|cannot pass|fix the .*verification|TaskUpdate/i)
      expect(r.output).toContain('TaskUpdate({ taskId, stepId, verification: [...] })')
      const results = r.metadata?.['results'] as Array<Record<string, unknown>>
      expect(results[0]?.['unsatisfiable']).toBe(true)
    })

    it('flags a file_exists placeholder path (xxx) as unsatisfiable', async () => {
      makeTaskWithVerification([
        { id: 'v1', kind: 'file_exists', path: `${tmpDir}/D20260613-xxx-fs-watchdog.md` },
      ])
      const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })
      expect(r.metadata?.['failureCategory']).toBe('verify:unsatisfiable-spec')
      const results = r.metadata?.['results'] as Array<Record<string, unknown>>
      expect(results[0]?.['unsatisfiable']).toBe(true)
    })

    it('flags a command refused by the risk classifier as unsatisfiable', async () => {
      makeTaskWithVerification([{ id: 'v1', kind: 'command', command: 'swift build --product X' }])
      const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })
      expect(r.metadata?.['failureCategory']).toBe('verify:unsatisfiable-spec')
      const results = r.metadata?.['results'] as Array<Record<string, unknown>>
      expect(results[0]?.['unsatisfiable']).toBe(true)
    })

    it('does NOT flag a well-formed check whose artifact is merely missing (retryable)', async () => {
      makeTaskWithVerification([
        { id: 'v1', kind: 'file_exists', path: `${tmpDir}/will-exist-after-work.ts` },
      ])
      const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })
      expect(r.metadata?.['failureCategory']).toBeUndefined()
      expect(r.output).toContain('Repair checkpoint')
      expect(r.metadata?.['repairCheckpoint']).toMatchObject({
        taskId: 'task-1',
        stepId: 'step-1',
        status: 'verification_failed',
        failedCheckIds: ['v1'],
        retryableCheckIds: ['v1'],
        unsatisfiableCheckIds: [],
        nextAction: 'fix_artifact_or_service_then_reverify',
      })
      const results = r.metadata?.['results'] as Array<Record<string, unknown>>
      expect(results[0]?.['passed']).toBe(false)
      expect(results[0]?.['unsatisfiable']).toBeUndefined()
    })

    it('does not set failureCategory when all checks pass', async () => {
      const f = `${tmpDir}/real.ts`
      fs.writeFileSync(f, 'export const x = 1\n')
      makeTaskWithVerification([{ id: 'v1', kind: 'file_exists', path: f }])
      const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })
      expect(r.metadata?.['passed']).toBe(true)
      expect(r.metadata?.['failureCategory']).toBeUndefined()
    })
  })

  it('runs command checks expanded from Project Map verification profiles', async () => {
    const create = await taskCreateTool.execute({
      subject: 'Verified Project Map task',
      description: 'Use profile checks',
      steps: [{
        title: 'Implement',
        description: 'make the change',
        projectMapVerificationProfileIds: ['npm-test'],
      }],
    }, {
      projectMapSnapshot: projectMapSnapshotWithProfiles([
        { id: 'npm-test', commands: ['true', 'node --version'] },
      ]),
    } as any)
    expect(create.isError).toBe(false)

    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('2/2 passed')
    expect(r.output).toContain('project-map-npm-test-1')
    expect(r.output).toContain('project-map-npm-test-2')
    const step = getTaskStep('task-1', 'step-1')!
    expect(step.verificationResults).toHaveLength(2)
    expect(step.verificationResults.every((result) => result.passed)).toBe(true)
  })

  it('allows checksum command checks as safe_readonly evidence', async () => {
    const evidencePath = path.join(tmpDir, 'score.json')
    fs.writeFileSync(evidencePath, '{"verdict":"PASS"}\n')
    makeTaskWithVerification([
      { id: 'score-hash', kind: 'command', command: `shasum -a 256 ${evidencePath}` },
    ])

    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })

    expect(r.isError).toBe(false)
    expect(r.output).toContain('1/1 passed')
    expect(r.output).not.toContain('command refused by risk classifier')
    const results = r.metadata?.['results'] as Array<Record<string, unknown>>
    expect(results[0]?.['passed']).toBe(true)
  })

  it('allows process inspection command checks as safe_readonly evidence', async () => {
    makeTaskWithVerification([
      { id: 'pid-state', kind: 'command', command: `ps -p ${process.pid} -o pid,stat` },
    ])

    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })

    expect(r.isError).toBe(false)
    expect(r.output).toContain('1/1 passed')
    expect(r.output).not.toContain('command refused by risk classifier')
    const results = r.metadata?.['results'] as Array<Record<string, unknown>>
    expect(results[0]?.['passed']).toBe(true)
  })

  it('runs localhost http_get checks without shelling out to curl', async () => {
    const server = await listenJsonServer({ ok: true, n_matches: 52 })
    try {
      makeTaskWithVerification([
        {
          id: 'reviews-aggregate-http',
          kind: 'http_get',
          url: `${server.url}/api/reviews/aggregate`,
          expectedStatus: 200,
          bodyPattern: '"n_matches":52',
        },
      ])

      const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })

      expect(r.isError).toBe(false)
      expect(r.output).toContain('1/1 passed')
      expect(r.output).toContain('http 200')
      expect(r.output).not.toContain('command refused by risk classifier')
      const results = r.metadata?.['results'] as Array<Record<string, any>>
      expect(results[0]?.passed).toBe(true)
      expect(results[0]?.metadata?.http).toMatchObject({
        status: 200,
        url: `${server.url}/api/reviews/aggregate`,
      })
    } finally {
      await server.close()
    }
  })

  it('refuses non-local http_get verification checks as unsatisfiable', async () => {
    makeTaskWithVerification([
      {
        id: 'external-http',
        kind: 'http_get',
        url: 'https://example.com/health',
        expectedStatus: 200,
      },
    ])

    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })

    expect(r.metadata?.['failureCategory']).toBe('verify:unsatisfiable-spec')
    const results = r.metadata?.['results'] as Array<Record<string, unknown>>
    expect(results[0]?.['passed']).toBe(false)
    expect(results[0]?.['unsatisfiable']).toBe(true)
    expect(results[0]?.['detail']).toContain('only localhost')
  })

  it('runs structured checks expanded from Project Map verification profiles', async () => {
    const artifactPath = path.join(tmpDir, 'dist', 'cli.js')
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
    fs.writeFileSync(artifactPath, '#!/usr/bin/env node\n')
    const create = await taskCreateTool.execute({
      subject: 'Verified Project Map artifacts',
      description: 'Use structured profile checks',
      steps: [{
        title: 'Build',
        description: 'verify package artifact',
        projectMapVerificationProfileIds: ['npm-build'],
      }],
    }, {
      projectMapSnapshot: projectMapSnapshotWithProfiles([
        {
          id: 'npm-build',
          commands: ['true'],
          taskVerifyChecks: [{
            id: 'project-map-package-bin-owlcoda',
            kind: 'file_exists',
            path: artifactPath,
            reason: 'package bin artifact declared by Project Map',
          }],
        },
      ]),
    } as any)
    expect(create.isError).toBe(false)

    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('2/2 passed')
    expect(r.output).toContain('project-map-npm-build-1')
    expect(r.output).toContain('project-map-package-bin-owlcoda')
    const step = getTaskStep('task-1', 'step-1')!
    expect(step.verificationResults).toHaveLength(2)
    expect(step.verificationResults.every((result) => result.passed)).toBe(true)
  })

  it('blocks INFRA_FAIL scorer artifacts from unlocking downstream retrain steps', async () => {
    const scorePath = path.join(tmpDir, 'score.json')
    fs.writeFileSync(scorePath, JSON.stringify({
      verdict: 'INFRA_FAIL',
      owl_score_trustworthy: false,
      exit_code: 2,
      run_health: {
        calibration_passed: false,
        judge_total: 5,
        judge_ok: 0,
        judge_error: 5,
        infra_fail_reason: 'error_rate=1.00 (>0.2 threshold)',
      },
      diagnostic_gate_summary: {
        tuned_gate_pass: 26,
        tuned_gate_total: 63,
      },
    }, null, 2))

    makeTaskWithVerification([
      { id: 'score-gate', kind: 'run_verdict_gate', path: scorePath },
    ])

    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })

    expect(r.isError).toBe(false)
    expect(r.metadata?.['passed']).toBe(false)
    expect(r.metadata?.['failureCategory']).toBe('verify:run-verdict-blocked')
    expect(r.output).toContain('INFRA_FAIL')
    expect(r.output).toContain('P2 blocked')
    expect(r.output).toContain('judge stability')
    const results = r.metadata?.['results'] as Array<Record<string, any>>
    expect(results[0]?.metadata?.runVerdictGate).toMatchObject({
      status: 'blocked',
      p2Status: 'blocked',
      trustworthy: false,
    })
  })

  it('blocks scorer artifacts whose judge_total is not backed by evidence', async () => {
    const runDir = path.join(tmpDir, 'scorer-run')
    fs.mkdirSync(path.join(runDir, 'judge'), { recursive: true })
    const scorePath = path.join(runDir, 'score.json')
    fs.writeFileSync(scorePath, JSON.stringify({
      verdict: 'PASS',
      owl_score_trustworthy: true,
      exit_code: 0,
      run_health: {
        calibration_passed: true,
        judge_total: 5,
        judge_ok: 5,
        judge_error: 0,
      },
    }, null, 2))

    makeTaskWithVerification([
      { id: 'score-gate', kind: 'run_verdict_gate', path: scorePath },
    ])

    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })

    expect(r.isError).toBe(false)
    expect(r.metadata?.['passed']).toBe(false)
    expect(r.metadata?.['failureCategory']).toBe('verify:run-verdict-blocked')
    expect(r.output).toContain('judge evidence')
    expect(r.output).toContain('P2 blocked')
    const results = r.metadata?.['results'] as Array<Record<string, any>>
    expect(results[0]?.metadata?.runVerdictGate).toMatchObject({
      status: 'blocked',
      evidenceStatus: 'missing',
      p2Status: 'blocked',
    })
  })

  // file_exists
  it('file_exists pass', async () => {
    const filePath = path.join(tmpDir, 'output.html')
    fs.writeFileSync(filePath, '<html/>')
    makeTaskWithVerification([{ id: 'v1', kind: 'file_exists', path: filePath }])
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('1/1 passed')
    expect(r.output).toContain('✓')
  })

  it('resolves relative file_exists paths against the task cwd and records path evidence', async () => {
    const repoDir = path.join(tmpDir, 'repo')
    fs.mkdirSync(path.join(repoDir, 'reports'), { recursive: true })
    fs.writeFileSync(path.join(repoDir, 'reports', 'quality.md'), '# ok\n')
    createTask({
      subject: 'Relative verification task',
      description: 'verify artifact relative to task cwd',
      cwd: repoDir,
      steps: [{
        title: 'Verify report',
        description: 'check report',
        verification: [{ id: 'report-exists', kind: 'file_exists', path: 'reports/quality.md' }],
      }],
    })

    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })

    expect(r.isError).toBe(false)
    expect(r.output).toContain('1/1 passed')
    const results = r.metadata?.['results'] as Array<Record<string, any>>
    expect(results[0]?.metadata?.path).toMatchObject({
      input: 'reports/quality.md',
      cwd: fs.realpathSync(repoDir),
      resolvedPath: fs.realpathSync(path.join(repoDir, 'reports', 'quality.md')),
      exists: true,
      kind: 'file',
    })
  })

  it('records cwd, resolvedPath, and statError when file_exists cannot find a relative path', async () => {
    const repoDir = path.join(tmpDir, 'repo-missing')
    fs.mkdirSync(repoDir, { recursive: true })
    createTask({
      subject: 'Missing relative verification task',
      description: 'verify missing artifact relative to task cwd',
      cwd: repoDir,
      steps: [{
        title: 'Verify report',
        description: 'check report',
        verification: [{ id: 'report-exists', kind: 'file_exists', path: 'reports/missing.md' }],
      }],
    })

    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })

    expect(r.isError).toBe(false)
    expect(r.output).toContain('0/1 passed')
    expect(r.output).toContain('resolved=')
    const results = r.metadata?.['results'] as Array<Record<string, any>>
    expect(results[0]?.metadata?.path).toMatchObject({
      input: 'reports/missing.md',
      cwd: fs.realpathSync(repoDir),
      resolvedPath: path.join(fs.realpathSync(repoDir), 'reports', 'missing.md'),
      exists: false,
    })
    expect(results[0]?.metadata?.path?.statError).toMatch(/ENOENT|no such file/i)
  })

  it('file_exists fail', async () => {
    const filePath = path.join(tmpDir, 'missing.html')
    makeTaskWithVerification([{ id: 'v1', kind: 'file_exists', path: filePath }])
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('0/1 passed')
    expect(r.output).toContain('✗')
  })

  // file_contains
  it('file_contains pass', async () => {
    const filePath = path.join(tmpDir, 'deck.html')
    fs.writeFileSync(filePath, '<section>Slide 1</section>\n<section>Slide 2</section>')
    makeTaskWithVerification([{ id: 'v1', kind: 'file_contains', path: filePath, pattern: '<section>' }])
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('1/1 passed')
  })

  it('file_contains fail when pattern not present', async () => {
    const filePath = path.join(tmpDir, 'deck.html')
    fs.writeFileSync(filePath, '<html><body>empty</body></html>')
    makeTaskWithVerification([{ id: 'v1', kind: 'file_contains', path: filePath, pattern: '<section>' }])
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('0/1 passed')
  })

  it('file_contains with invalid regex returns fail detail', async () => {
    const filePath = path.join(tmpDir, 'deck.html')
    fs.writeFileSync(filePath, '<html/>')
    makeTaskWithVerification([{ id: 'v1', kind: 'file_contains', path: filePath, pattern: '[invalid(' }])
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('0/1 passed')
    expect(r.output).toContain('invalid regex')
  })

  // artifact_count
  it('artifact_count pass', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.html'), '<html/>')
    fs.writeFileSync(path.join(tmpDir, 'b.html'), '<html/>')
    makeTaskWithVerification([{ id: 'v1', kind: 'artifact_count', root: tmpDir, glob: '*.html', min: 2 }])
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('1/1 passed')
  })

  it('artifact_count fail when fewer than min', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.html'), '<html/>')
    makeTaskWithVerification([{ id: 'v1', kind: 'artifact_count', root: tmpDir, glob: '*.html', min: 3 }])
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('0/1 passed')
    expect(r.output).toContain('expected >=3')
  })

  // command
  it('command safe_readonly pass', async () => {
    makeTaskWithVerification([{ id: 'v1', kind: 'command', command: 'echo hello', expectedExitCode: 0 }])
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('1/1 passed')
  })

  it('allows read-only node -e verification checks', async () => {
    const artifactPath = path.join(tmpDir, 'artifact.json')
    fs.writeFileSync(artifactPath, '{"ok":true}\n')
    makeTaskWithVerification([{
      id: 'node-e-check',
      kind: 'command',
      command: `node -e "const fs=require('fs'); const p=process.argv[1]; process.exit(fs.existsSync(p) ? 0 : 2)" ${artifactPath}`,
      expectedExitCode: 0,
    }])

    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })

    expect(r.isError).toBe(false)
    expect(r.output).toContain('1/1 passed')
    expect(r.output).not.toContain('command refused by risk classifier')
  })

  it('allows common npx read-only verification commands', async () => {
    makeTaskWithVerification([{
      id: 'npx-tsc-version',
      kind: 'command',
      command: 'npx tsc --version',
      expectedExitCode: 0,
    }])

    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })

    expect(r.isError).toBe(false)
    expect(r.output).toContain('1/1 passed')
    expect(r.output).not.toContain('command refused by risk classifier')
  })

  it('accepts clean git diff --no-index --check differences without hiding the raw exit code', async () => {
    const emptyPath = path.join(tmpDir, 'empty')
    const artifactPath = path.join(tmpDir, 'artifact.md')
    fs.writeFileSync(emptyPath, '')
    fs.writeFileSync(artifactPath, '# clean\n')
    makeTaskWithVerification([{
      id: 'whitespace-check',
      kind: 'command',
      command: `git diff --no-index --check ${emptyPath} ${artifactPath}`,
    }])

    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })

    expect(r.output).toContain('1/1 passed')
    const results = r.metadata?.results as Array<Record<string, any>>
    expect(results[0]).toMatchObject({
      passed: true,
      metadata: {
        exitCode: 1,
        semanticSuccess: true,
        commandResultSemantics: 'git_diff_no_index_check',
      },
    })
  })

  it('rejects git diff --no-index --check when whitespace diagnostics are present', async () => {
    const emptyPath = path.join(tmpDir, 'empty')
    const artifactPath = path.join(tmpDir, 'artifact.md')
    fs.writeFileSync(emptyPath, '')
    fs.writeFileSync(artifactPath, '# bad  \n')
    makeTaskWithVerification([{
      id: 'whitespace-check',
      kind: 'command',
      command: `git diff --no-index --check ${emptyPath} ${artifactPath}`,
    }])

    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })

    expect(r.output).toContain('0/1 passed')
    expect(r.output).toContain('trailing whitespace')
    const results = r.metadata?.results as Array<Record<string, any>>
    expect(results[0]?.passed).toBe(false)
    expect(results[0]?.metadata?.exitCode).not.toBe(0)
  })

  it('command dangerous refused', async () => {
    makeTaskWithVerification([{ id: 'v1', kind: 'command', command: 'rm -rf /tmp/something' }])
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('0/1 passed')
    expect(r.output).toContain('refused by risk classifier')
  })

  it('command destructive deny-list checks are refused through the shared classifier', async () => {
    makeTaskWithVerification(ADR008_DESTRUCTIVE_VERIFY_COMMANDS.map((command, i) => ({
      id: `destructive-${i + 1}`,
      kind: 'command',
      command,
    })))
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain(`0/${ADR008_DESTRUCTIVE_VERIFY_COMMANDS.length} passed`)
    const meta = r.metadata as any
    expect(meta.results).toHaveLength(ADR008_DESTRUCTIVE_VERIFY_COMMANDS.length)
    for (const result of meta.results) {
      expect(result.passed).toBe(false)
      expect(result.detail).toContain('command refused by risk classifier: dangerous')
    }
  })

  // none
  it('none kind passes without real verification', async () => {
    makeTaskWithVerification([{ id: 'v1', kind: 'none', reason: 'manual inspection required' }])
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('1/1 passed')
    expect(r.output).toContain('no verification performed')
  })

  // writeBack
  it('writeBack writes verificationResults to step', async () => {
    const filePath = path.join(tmpDir, 'out.html')
    fs.writeFileSync(filePath, '<html/>')
    makeTaskWithVerification([{ id: 'v1', kind: 'file_exists', path: filePath }])
    await tool.execute({ taskId: 'task-1', stepId: 'step-1', writeBack: true })
    const step = getTaskStep('task-1', 'step-1')
    expect(step!.verificationResults).toHaveLength(1)
    expect(step!.verificationResults[0]!.passed).toBe(true)
  })

  it('writeBack=false does not mutate step', async () => {
    const filePath = path.join(tmpDir, 'out.html')
    fs.writeFileSync(filePath, '<html/>')
    makeTaskWithVerification([{ id: 'v1', kind: 'file_exists', path: filePath }])
    await tool.execute({ taskId: 'task-1', stepId: 'step-1', writeBack: false })
    const step = getTaskStep('task-1', 'step-1')
    expect(step!.verificationResults).toHaveLength(0)
    expect(step!.status).toBe('pending')
  })

  it('multiple checks: mixed pass/fail', async () => {
    const existingFile = path.join(tmpDir, 'a.html')
    const missingFile = path.join(tmpDir, 'b.html')
    fs.writeFileSync(existingFile, '<html/>')
    makeTaskWithVerification([
      { id: 'v1', kind: 'file_exists', path: existingFile },
      { id: 'v2', kind: 'file_exists', path: missingFile },
    ])
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('1/2 passed')
    const meta = r.metadata as any
    expect(meta.passed).toBe(false)
    expect(meta.results).toHaveLength(2)
    expect(meta.repairCheckpoint).toMatchObject({
      failedCheckIds: ['v2'],
      retryableCheckIds: ['v2'],
      nextAction: 'fix_artifact_or_service_then_reverify',
    })
  })

  it('failed verification prevents step completion via TaskUpdate', async () => {
    const missingFile = path.join(tmpDir, 'missing.html')
    makeTaskWithVerification([{ id: 'v1', kind: 'file_exists', path: missingFile }])
    updateTaskStep('task-1', 'step-1', { status: 'in_progress' })
    await tool.execute({ taskId: 'task-1', stepId: 'step-1', writeBack: true })
    // Now try to complete — should fail because verification has failed result
    const updateResult = updateTaskStep('task-1', 'step-1', { status: 'completed' })
    expect(updateResult.ok).toBe(false)
    expect(updateResult.ok === false && updateResult.reason).toMatch(/verification check/)
  })

  it('verification_pack/html_deck pass writes expanded pack checks', async () => {
    const deckPath = path.join(tmpDir, 'deck.html')
    const buildNotesPath = path.join(tmpDir, 'build-notes.md')
    fs.writeFileSync(deckPath, [
      '<html><head><title>Quarterly Review</title></head><body>',
      '<section>Overview OWLCODA_OK</section>',
      '<section>Evidence</section>',
      '</body></html>',
    ].join('\n'))
    fs.writeFileSync(buildNotesPath, 'Built by test.')
    makeTaskWithVerification([{
      id: 'deck-pack',
      kind: 'verification_pack',
      packId: 'html_deck',
      deckPath,
      expectedSections: 2,
      buildNotesPath,
      requiredMarkers: ['OWLCODA_OK'],
      forbiddenTerms: ['DO_NOT_SHIP'],
      minFileSizeBytes: 10,
      minSectionBytes: 0,
    }])

    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })

    expect(r.isError).toBe(false)
    expect(r.output).toContain('10/10 passed')
    expect(r.output).toContain('deck-pack.section_count')
    expect(r.output).toContain('deck-pack.title_placeholder')
    const step = getTaskStep('task-1', 'step-1')
    expect(step!.verificationResults).toHaveLength(10)
    expect(step!.verificationResults.every(result => result.passed)).toBe(true)
    expect(step!.verificationResults.find(result => result.checkId === 'deck-pack.section_count')!.metadata).toMatchObject({
      packId: 'html_deck',
      packStatus: 'passed',
      artifactPath: fs.realpathSync(deckPath),
      packCheckId: 'section_count',
      severity: 'error',
    })
  })

  it('verification_pack/html_deck reports title_placeholder failure', async () => {
    const deckPath = path.join(tmpDir, 'deck.html')
    const buildNotesPath = path.join(tmpDir, 'build-notes.md')
    fs.writeFileSync(deckPath, [
      '<html><head><title>{{ deck title }}</title></head><body>',
      '<section>Overview</section>',
      '<section>Evidence</section>',
      '</body></html>',
    ].join('\n'))
    fs.writeFileSync(buildNotesPath, 'Built by test.')
    makeTaskWithVerification([{
      id: 'deck-pack',
      kind: 'verification_pack',
      packId: 'html_deck',
      deckPath,
      expectedSections: 2,
      buildNotesPath,
      minSectionBytes: 0,
    }])

    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })

    expect(r.isError).toBe(false)
    expect(r.output).toContain('9/10 passed')
    expect(r.output).toContain('deck-pack.title_placeholder')
    expect(r.output).toContain('title contains placeholder pattern')
    const step = getTaskStep('task-1', 'step-1')
    expect(step!.verificationResults.find(result => result.checkId === 'deck-pack.title_placeholder')!.passed).toBe(false)
  })

  it('verification_pack/html_deck failure writeBack prevents step completion', async () => {
    const deckPath = path.join(tmpDir, 'deck.html')
    const buildNotesPath = path.join(tmpDir, 'build-notes.md')
    fs.writeFileSync(deckPath, [
      '<html><head><title>Real Title</title></head><body>',
      '<section>Only one section</section>',
      '</body></html>',
    ].join('\n'))
    fs.writeFileSync(buildNotesPath, 'Built by test.')
    makeTaskWithVerification([{
      id: 'deck-pack',
      kind: 'verification_pack',
      packId: 'html_deck',
      deckPath,
      expectedSections: 2,
      buildNotesPath,
    }])

    updateTaskStep('task-1', 'step-1', { status: 'in_progress' })
    await tool.execute({ taskId: 'task-1', stepId: 'step-1', writeBack: true })
    const updateResult = updateTaskStep('task-1', 'step-1', { status: 'completed' })

    expect(updateResult.ok).toBe(false)
    expect(updateResult.ok === false && updateResult.reason).toMatch(/verification check/)
    const step = getTaskStep('task-1', 'step-1')
    expect(step!.verificationResults.find(result => result.checkId === 'deck-pack.section_count')!.passed).toBe(false)
  })

  it('verification_pack with invalid packId returns failed result', async () => {
    makeTaskWithVerification([{
      id: 'bad-pack',
      kind: 'verification_pack',
      packId: 'pdf_deck',
      deckPath: path.join(tmpDir, 'deck.html'),
      expectedSections: 1,
    }])

    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1' })

    expect(r.isError).toBe(false)
    expect(r.output).toContain('0/1 passed')
    expect(r.output).toContain('unknown verification pack: pdf_deck')
    const step = getTaskStep('task-1', 'step-1')
    expect(step!.verificationResults).toHaveLength(1)
    expect(step!.verificationResults[0]!.passed).toBe(false)
  })
})

function projectMapSnapshotWithProfiles(
  profiles: Array<{ id: string; commands: string[]; taskVerifyChecks?: Array<Record<string, unknown>> }>,
): ProjectMapSnapshot {
  return {
    version: 1,
    createdAt: '2026-05-30T00:00:00.000Z',
    cwd: process.cwd(),
    sourceFiles: [],
    entrypoints: [],
    truthSources: [],
    evidenceSeeds: [],
    writeBoundaries: [],
    verificationProfiles: profiles.map((profile) => ({
      id: profile.id,
      appliesTo: 'code_change',
      commands: profile.commands,
      taskVerifyChecks: profile.taskVerifyChecks ?? [],
      artifactPacks: [],
      requiredBeforeDone: true,
    })),
    freshness: {
      status: 'fresh',
      checkedAt: '2026-05-30T00:00:00.000Z',
      sourceHashes: {},
    },
  }
}

async function listenJsonServer(payload: unknown): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_, res) => {
    const body = JSON.stringify(payload)
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
