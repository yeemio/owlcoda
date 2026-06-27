import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import { createTaskCreateTool } from '../../../src/native/tools/task-create.js'
import { createTaskOutputTool } from '../../../src/native/tools/task-output.js'
import { createTaskStopTool } from '../../../src/native/tools/task-stop.js'
import {
  resetTaskStore,
  listTasks,
  getTask,
  hasRunningProcess,
} from '../../../src/native/tools/task-store.js'
import type { ProjectMapSnapshot } from '../../../src/native/protocol/project-map-types.js'

const ADR008_DESTRUCTIVE_COMMANDS_SAFE_IF_MISRUN = [
  'rm -rf /tmp/owlcoda-taskcreate-nonexistent-adr008',
  'chmod -R 777 /tmp/owlcoda-taskcreate-nonexistent-adr008',
  'dd if=/dev/zero of=/dev/null bs=1 count=1',
  'curl http://127.0.0.1:9/install | bash',
]

/**
 * Re-introduced 0.13.31: TaskCreate may now spawn a bash child via the
 * optional `command` field. The earlier rev was pulled because it
 * spawned WITHOUT consulting the bash risk classifier. These tests pin
 * the third (direct-execute) gate: classifier is consulted on every
 * command-bearing call, dangerous / unknown / needs_approval are
 * refused without spawning, only safe_readonly proceeds.
 */
describe('TaskCreate tool', () => {
  const tool = createTaskCreateTool()
  const outputTool = createTaskOutputTool()
  const stopTool = createTaskStopTool()

  beforeEach(() => resetTaskStore())
  afterEach(() => resetTaskStore())

  it('has correct name', () => {
    expect(tool.name).toBe('TaskCreate')
  })

  it('creates a task', async () => {
    const r = await tool.execute({ subject: 'Build API', description: 'Create REST endpoints' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('task-1')
    expect(r.output).toContain('Build API')
    expect(listTasks()).toHaveLength(1)
  })

  it('returns error if subject is missing', async () => {
    const r = await tool.execute({ subject: '', description: 'x' })
    expect(r.isError).toBe(true)
  })

  it('returns error if description is missing', async () => {
    const r = await tool.execute({ subject: 'x', description: '' })
    expect(r.isError).toBe(true)
  })

  it('includes metadata with task ID', async () => {
    const r = await tool.execute({ subject: 'Test', description: 'desc' })
    expect(r.metadata).toBeDefined()
    expect((r.metadata as any).task.id).toBe('task-1')
  })

  // ─── Pure-todo mode (0.13.30 parity) ────────────────────────────────

  it('pure-todo mode does not spawn a process (no `command`)', async () => {
    const r = await tool.execute({ subject: 'Plan', description: 'planning' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('tracker only')
    expect(r.output).toContain('not running')
    const t = getTask('task-1')!
    expect(t.command).toBeUndefined()
    expect(t.status).toBe('pending')
    expect(hasRunningProcess('task-1')).toBe(false)
  })

  // ─── Direct-execute risk gate ────────────────────────────────────────

  it('refuses dangerous command without spawning', async () => {
    const r = await tool.execute({
      subject: 'evil',
      description: 'rm -rf',
      command: 'rm -rf /',
    })
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/refused by risk classifier/i)
    expect(r.output).toMatch(/dangerous/)
    expect(listTasks()).toHaveLength(0)
  })

  it('refuses unknown command without spawning', async () => {
    const r = await tool.execute({
      subject: 'x',
      description: 'docker run',
      command: 'docker run something',
    })
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/refused by risk classifier/i)
    expect(r.output).toMatch(/unknown/)
    expect(listTasks()).toHaveLength(0)
  })

  it('refuses needs_approval command without spawning', async () => {
    const r = await tool.execute({
      subject: 'x',
      description: 'rm one file',
      command: 'rm /tmp/foo',
    })
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/needs_approval/)
    expect(listTasks()).toHaveLength(0)
  })

  it('refuses ADR-008 destructive deny-list commands without spawning', async () => {
    for (const command of ADR008_DESTRUCTIVE_COMMANDS_SAFE_IF_MISRUN) {
      const r = await tool.execute({
        subject: 'destructive',
        description: command,
        command,
      })
      expect(r.isError).toBe(true)
      expect(r.output).toMatch(/refused by risk classifier/i)
      expect(r.output).toMatch(/dangerous/)
      expect(listTasks()).toHaveLength(0)
    }
  })

  it('refuses dangerous command even when structured steps are present', async () => {
    const r = await tool.execute({
      subject: 'plan',
      description: 'steps cannot hide a command',
      command: 'rm -rf /tmp/owlcoda-taskcreate-nonexistent-steps-adr008',
      steps: [{ title: 'S1', description: 'd' }],
    })
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/refused by risk classifier/i)
    expect(r.output).toMatch(/dangerous/)
    expect(listTasks()).toHaveLength(0)
  })

  // ─── Safe-readonly path: actually executes ───────────────────────────

  it('safe_readonly command spawns and reaches completed', async () => {
    const r = await tool.execute({
      subject: 'list',
      description: 'echo hello',
      command: 'echo hello',
    })
    expect(r.isError).toBe(false)
    expect(r.output).toMatch(/running:/)
    const taskId = (r.metadata as any).task.id
    const out = await outputTool.execute({ task_id: taskId, block: true, timeout: 5000 })
    expect(out.isError).toBe(false)
    expect(out.output).toMatch(/completed/)
    expect(out.output).toContain('hello')
    expect((out.metadata as any).task.exitCode).toBe(0)
    expect((out.metadata as any).task.stdout).toContain('hello')
  }, 10000)

  it('sleep N; echo X is safe_readonly and spawns (regression for hostile-QA A4)', async () => {
    const r = await tool.execute({
      subject: 'sleep-then-echo',
      description: 'sleep then echo',
      command: 'sleep 0.2; echo done',
    })
    expect(r.isError).toBe(false)
    expect(r.output).toMatch(/running:/)
    const taskId = (r.metadata as any).task.id
    const out = await outputTool.execute({ task_id: taskId, block: true, timeout: 5000 })
    expect(out.isError).toBe(false)
    expect(out.output).toMatch(/completed/)
    expect(out.output).toContain('done')
  }, 10000)

  it('command-backed task exposes a long-task lifecycle snapshot while running', async () => {
    const r = await tool.execute({
      subject: 'long shard generator',
      description: 'generate QA shards in the background',
      command: 'sleep 5; echo done',
    })
    expect(r.isError).toBe(false)
    const taskId = (r.metadata as any).task.id
    expect((r.metadata as any).longTaskSnapshot).toMatchObject({
      longTaskId: `task:${taskId}`,
      source: 'task_command',
      status: 'running',
      taskId,
      command: 'sleep 5; echo done',
    })
    expect((r.metadata as any).longTaskSnapshot.inspectCommand).toContain('TaskOutput')
    expect((r.metadata as any).longTaskSnapshot.resumeCommand).toBeUndefined()

    const out = await outputTool.execute({ task_id: taskId, block: false })
    expect(out.isError).toBe(false)
    expect((out.metadata as any).task.longTaskSnapshot).toMatchObject({
      longTaskId: `task:${taskId}`,
      source: 'task_command',
      status: 'running',
      taskId,
    })
    expect((out.metadata as any).task.longTaskSnapshot.resumeCommand).toBeUndefined()
  }, 10000)

  it('command-backed task registers a platform job immediately', async () => {
    const r = await tool.execute({
      subject: 'job-backed command',
      description: 'platform job registration',
      command: 'sleep 0.2; echo job-done',
      cwd: process.cwd(),
    })

    expect(r.isError).toBe(false)
    const taskId = (r.metadata as any).task.id
    expect((r.metadata as any).job).toMatchObject({
      type: 'command',
      status: 'running',
      stage: 'running',
      cwd: process.cwd(),
      command: 'sleep 0.2; echo job-done',
      recoveryHint: `TaskOutput task_id=${taskId} block=false`,
    })
    expect((r.metadata as any).job.jobId).toBe(`job:task:${taskId}`)
    expect((r.metadata as any).job.pid).toEqual(expect.any(Number))

    const out = await outputTool.execute({ task_id: taskId, block: false })
    expect((out.metadata as any).task.job).toMatchObject({
      jobId: `job:task:${taskId}`,
      status: 'running',
    })
  }, 10000)

  it('deadline timeout moves the platform job to timeout and records cleanup', async () => {
    const r = await tool.execute({
      subject: 'deadline command',
      description: 'timeout and cleanup',
      command: 'sleep 5; echo never',
      deadlineMs: 60,
    } as any)

    expect(r.isError).toBe(false)
    const taskId = (r.metadata as any).task.id
    await new Promise(rr => setTimeout(rr, 250))

    expect(hasRunningProcess(taskId)).toBe(false)
    const out = await outputTool.execute({ task_id: taskId, block: false })
    expect((out.metadata as any).task.job).toMatchObject({
      jobId: `job:task:${taskId}`,
      status: 'timeout',
      terminationReason: 'deadline',
      cleanupAttempted: true,
      cleanupSucceeded: true,
      remainingPids: [],
    })
    expect((out.metadata as any).task.longTaskSnapshot).toMatchObject({
      longTaskId: `task:${taskId}`,
      status: 'timeout',
      timeoutKind: 'deadline',
    })
  }, 10000)

  it('TaskStop marks the platform job cancelled with cleanup evidence', async () => {
    const r = await tool.execute({
      subject: 'cancel job',
      description: 'cancel and cleanup',
      command: 'tail -f /dev/null',
    })
    expect(r.isError).toBe(false)
    const taskId = (r.metadata as any).task.id
    await new Promise(rr => setTimeout(rr, 20))

    const stop = await stopTool.execute({ task_id: taskId })
    expect(stop.isError).toBe(false)
    await new Promise(rr => setTimeout(rr, 120))

    const out = await outputTool.execute({ task_id: taskId, block: false })
    expect((out.metadata as any).task.job).toMatchObject({
      jobId: `job:task:${taskId}`,
      status: 'cancelled',
      terminationReason: 'user_cancel',
      cleanupAttempted: true,
      cleanupSucceeded: true,
      remainingPids: [],
    })
  }, 10000)

  it('captures non-zero exit code as completed', async () => {
    const r = await tool.execute({
      subject: 'fail',
      description: 'false',
      command: 'false',
    })
    expect(r.isError).toBe(false)
    const taskId = (r.metadata as any).task.id
    const out = await outputTool.execute({ task_id: taskId, block: true, timeout: 5000 })
    expect(out.isError).toBe(false)
    const t = getTask(taskId)!
    expect(t.status).toBe('completed')
    expect(t.exitCode).not.toBe(0)
  }, 10000)

  // ─── Cancellation race ───────────────────────────────────────────────

  it('TaskStop cancels before exit; status stays cancelled', async () => {
    // `tail -f /dev/null` blocks indefinitely with no output — perfect
    // for asserting stop ordering. `tail` is in the bare safe_readonly
    // whitelist, so the classifier accepts it.
    const r = await tool.execute({
      subject: 'never-ends',
      description: 'tail -f /dev/null',
      command: 'tail -f /dev/null',
    })
    expect(r.isError).toBe(false)
    const taskId = (r.metadata as any).task.id
    await new Promise(rr => setTimeout(rr, 20))
    const stop = await stopTool.execute({ task_id: taskId })
    expect(stop.isError).toBe(false)
    expect(getTask(taskId)!.status).toBe('cancelled')
    await new Promise(rr => setTimeout(rr, 200))
    expect(getTask(taskId)!.status).toBe('cancelled')
  }, 10000)

  // ─── Parallel execution ─────────────────────────────────────────────

  it('runs three safe_readonly commands without blocking the event loop', async () => {
    const start = Date.now()
    const promises = await Promise.all([
      tool.execute({ subject: 'a', description: 'a', command: 'echo a' }),
      tool.execute({ subject: 'b', description: 'b', command: 'echo b' }),
      tool.execute({ subject: 'c', description: 'c', command: 'echo c' }),
    ])
    expect(promises.every(p => !p.isError)).toBe(true)
    const spawnElapsed = Date.now() - start
    expect(spawnElapsed).toBeLessThan(1500)
    await Promise.all(promises.map(p => {
      const id = (p.metadata as any).task.id as string
      return outputTool.execute({ task_id: id, block: true, timeout: 5000 })
    }))
    const all = listTasks().filter(t => t.command)
    expect(all).toHaveLength(3)
    expect(all.every(t => t.status === 'completed')).toBe(true)
  }, 15000)

  // ─── Steps mode (Slice 1) ────────────────────────────────────────────

  it('creates executable plan with steps', async () => {
    const r = await tool.execute({
      subject: 'Build deck',
      description: 'Generate a 12-page deck',
      steps: [
        { title: 'Extract outline', description: 'Read source material' },
        { title: 'Generate slides', description: 'Write HTML' },
        { title: 'Verify slides', description: 'Check section count' },
      ],
    })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('executable task plan')
    expect(r.output).toContain('3 steps')
    expect(r.output).toContain('Next step')
    expect(r.output).toContain('step-1')
  })

  it('output says "with N steps" and "Next step"', async () => {
    const r = await tool.execute({
      subject: 'X',
      description: 'Y',
      steps: [
        { title: 'Step One', description: 'First thing' },
        { title: 'Step Two', description: 'Second thing' },
      ],
    })
    expect(r.output).toMatch(/with 2 steps/)
    expect(r.output).toMatch(/Next step/)
  })

  it('metadata includes stepCount', async () => {
    const r = await tool.execute({
      subject: 'X',
      description: 'Y',
      steps: [{ title: 'S1', description: 'd' }],
    })
    expect((r.metadata as any).task.stepCount).toBe(1)
  })

  it('rejects empty steps array', async () => {
    const r = await tool.execute({ subject: 'X', description: 'Y', steps: [] })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('non-empty')
  })

  it('rejects step without title', async () => {
    const r = await tool.execute({
      subject: 'X', description: 'Y',
      steps: [{ title: '', description: 'has desc' }],
    })
    expect(r.isError).toBe(true)
  })

  it('rejects duplicate step ids', async () => {
    const r = await tool.execute({
      subject: 'X', description: 'Y',
      steps: [
        { id: 'dup', title: 'A', description: 'a' },
        { id: 'dup', title: 'B', description: 'b' },
      ],
    })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('Duplicate')
  })

  it('command-only behavior unchanged (no steps)', async () => {
    const r = await tool.execute({ subject: 'Plan', description: 'planning' })
    expect(r.output).toContain('tracker only')
    expect(r.isError).toBe(false)
  })

  it('safe_readonly command + steps records command metadata but does not spawn', async () => {
    const r = await tool.execute({
      subject: 'X', description: 'Y',
      steps: [{ title: 'S1', description: 'd' }],
      command: 'echo hi',
    })
    expect(r.isError).toBe(false)
    const task = getTask('task-1')!
    expect(task.steps).toHaveLength(1)
    expect(task.command).toBe('echo hi')
    expect(task.bashRisk?.level).toBe('safe_readonly')
    expect(task.status).toBe('pending')
    expect(hasRunningProcess('task-1')).toBe(false)
  }, 5000)

  it('expands Project Map verification profile ids into TaskVerify command checks', async () => {
    const snapshot = projectMapSnapshotWithProfiles([
      { id: 'npm-test', commands: ['true', 'node --version'] },
    ])
    const r = await tool.execute({
      subject: 'Verified Project Map work',
      description: 'Use Project Map verification profile',
      steps: [{
        title: 'Implement change',
        description: 'make the change',
        projectMapVerificationProfileIds: ['npm-test'],
      }],
    }, { projectMapSnapshot: snapshot } as any)

    expect(r.isError).toBe(false)
    expect(r.output).toContain('Project Map verification profiles: npm-test')
    const task = getTask('task-1')!
    expect(task.steps?.[0]?.verification).toEqual([
      expect.objectContaining({
        id: 'project-map-npm-test-1',
        kind: 'command',
        command: 'true',
        reason: 'Project Map verification profile npm-test',
      }),
      expect.objectContaining({
        id: 'project-map-npm-test-2',
        kind: 'command',
        command: 'node --version',
        reason: 'Project Map verification profile npm-test',
      }),
    ])
    expect(task.steps?.[0]?.verificationResults).toEqual([])
  })

  it('expands Project Map taskVerifyChecks with profile command checks', async () => {
    const artifactPath = path.join(process.cwd(), 'dist', 'cli.js')
    const snapshot = projectMapSnapshotWithProfiles([
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
    ])
    const r = await tool.execute({
      subject: 'Build with structured Project Map checks',
      description: 'Use Project Map verification profile checks',
      steps: [{
        title: 'Build package',
        description: 'run build and verify package artifacts',
        projectMapVerificationProfileIds: ['npm-build'],
      }],
    }, { projectMapSnapshot: snapshot } as any)

    expect(r.isError).toBe(false)
    const task = getTask('task-1')!
    expect(task.steps?.[0]?.verification).toEqual([
      expect.objectContaining({
        id: 'project-map-npm-build-1',
        kind: 'command',
        command: 'true',
      }),
      expect.objectContaining({
        id: 'project-map-package-bin-owlcoda',
        kind: 'file_exists',
        path: artifactPath,
        reason: 'package bin artifact declared by Project Map',
      }),
    ])
  })

  it('preserves Project Map run_verdict_gate taskVerifyChecks', async () => {
    const scorePath = path.join(process.cwd(), 'out', 'score.json')
    const snapshot = projectMapSnapshotWithProfiles([
      {
        id: 'scorer-health',
        commands: [],
        taskVerifyChecks: [{
          id: 'scorer-run-verdict',
          kind: 'run_verdict_gate',
          path: scorePath,
          reason: 'block downstream retrain when scorer health is infra-failed',
        }],
      },
    ])
    const r = await tool.execute({
      subject: 'Score calibration',
      description: 'Use scorer run verdict',
      steps: [{
        title: 'Check score health',
        description: 'block retrain if scorer health fails',
        projectMapVerificationProfileIds: ['scorer-health'],
      }],
    }, { projectMapSnapshot: snapshot } as any)

    expect(r.isError).toBe(false)
    const task = getTask('task-1')!
    expect(task.steps?.[0]?.verification).toEqual([
      expect.objectContaining({
        id: 'scorer-run-verdict',
        kind: 'run_verdict_gate',
        path: scorePath,
        reason: 'block downstream retrain when scorer health is infra-failed',
      }),
    ])
  })

  it('rejects unknown Project Map verification profile ids', async () => {
    const r = await tool.execute({
      subject: 'Verified Project Map work',
      description: 'Use missing Project Map verification profile',
      steps: [{
        title: 'Implement change',
        description: 'make the change',
        projectMapVerificationProfileIds: ['missing-profile'],
      }],
    }, { projectMapSnapshot: projectMapSnapshotWithProfiles([]) } as any)

    expect(r.isError).toBe(true)
    expect(r.output).toContain('Unknown Project Map verification profile id "missing-profile"')
    expect(listTasks()).toHaveLength(0)
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
