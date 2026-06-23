/**
 * TaskVerify tool tests — Slice 3, Task Execution Mode v1
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createTaskCreateTool } from '../../../src/native/tools/task-create.js'
import { createTaskVerifyTool } from '../../../src/native/tools/task-verify.js'
import {
  resetTaskStore,
  createTask,
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
  kind: 'file_exists' | 'file_contains' | 'artifact_count' | 'verification_pack' | 'command' | 'none' | 'run_verdict_gate'
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

  it('marks file_contains as weak_text_match and blocks parser steps from completing with weak-only evidence', async () => {
    const parserPath = path.join(tmpDir, 'qiutan-parser.ts')
    fs.writeFileSync(parserPath, 'export function parseQiutanTableEvidence() { return "竞彩让" }\n')
    createTask({
      subject: 'Parser behavior fix',
      description: 'For testing weak evidence gating',
      steps: [{
        title: 'Update parseQiutanTableEvidence for 竞彩让 snapshot parsing',
        description: 'Parser/snapshot behavior must not be verified by grep only.',
        verification: [{ id: 'keyword', kind: 'file_contains', path: parserPath, pattern: '竞彩让' }],
      }],
    })
    updateTaskStep('task-1', 'step-1', { status: 'in_progress' })

    const verify = await tool.execute({ taskId: 'task-1', stepId: 'step-1', writeBack: true })

    expect(verify.isError).toBe(false)
    expect(verify.metadata?.['highestVerificationStrength']).toBe('weak_text_match')
    const step = getTaskStep('task-1', 'step-1')!
    expect(step.verificationResults[0]!.strength).toBe('weak_text_match')

    const updateResult = updateTaskStep('task-1', 'step-1', { status: 'completed' })

    expect(updateResult.ok).toBe(false)
    expect(updateResult.ok === false && updateResult.reason).toMatch(/behavioral verification|unit_behavior|runtime_replay/)
  })

  it('marks typecheck/build command checks as compile_only and still blocks behavior-sensitive steps', async () => {
    createTask({
      subject: 'Snapshot normalization fix',
      description: 'For testing compile-only evidence gating',
      steps: [{
        title: 'Update normalizeOddsSnapshot fallback behavior',
        description: 'Snapshot normalization requires behavior evidence.',
        verification: [{ id: 'typecheck', kind: 'command', command: 'tsc --version' }],
      }],
    })
    updateTaskStep('task-1', 'step-1', { status: 'in_progress' })

    const verify = await tool.execute({ taskId: 'task-1', stepId: 'step-1', writeBack: true })

    expect(verify.isError).toBe(false)
    expect(verify.metadata?.['highestVerificationStrength']).toBe('compile_only')
    const updateResult = updateTaskStep('task-1', 'step-1', { status: 'completed' })

    expect(updateResult.ok).toBe(false)
    expect(updateResult.ok === false && updateResult.reason).toContain('compile_only')
  })

  it('allows behavior-sensitive steps to complete with unit_behavior evidence', async () => {
    createTask({
      subject: 'Parser behavior fix',
      description: 'For testing behavior evidence gating',
      steps: [{
        title: 'Update parser fixture replay',
        description: 'Parser behavior is covered by a focused test command.',
        verification: [{ id: 'parser-test', kind: 'command', command: 'npm test tests/native/tools/task-verify.test.ts -- --runInBand' }],
      }],
    })
    updateTaskStep('task-1', 'step-1', { status: 'in_progress' })
    updateTaskStep('task-1', 'step-1', {
      verificationResults: [{
        checkId: 'parser-test',
        passed: true,
        strength: 'unit_behavior',
        detail: 'test command passed',
        checkedAt: new Date().toISOString(),
      }],
    })

    const updateResult = updateTaskStep('task-1', 'step-1', { status: 'completed' })

    expect(updateResult.ok).toBe(true)
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
      artifactPath: deckPath,
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
