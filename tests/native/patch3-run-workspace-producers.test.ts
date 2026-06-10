/**
 * Patch 3 end-to-end: B1/B2/B3/B5 — RunWorkspace producer wire-up.
 *
 * Verifies that the four ledger files get populated when the relevant tools run
 * inside a live RunWorkspace:
 *   B1 — SkillRoutePreview.execute writes skill-route.json
 *   B2 — TodoWrite via dispatch mirrors todos to plan.json
 *   B3 — write/edit/bash via dispatch appends entries to artifacts.json (outputRoot-scoped)
 *   B5 — ensureRunWorkspaceForStructuredTask adds outputRoot to allowedWritePaths
 *         with origin='run_workspace', and evaluateWriteGuard does NOT filter it
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSkillRoutePreviewTool } from '../../src/native/tools/skill-route-preview.js'
import { ToolDispatcher } from '../../src/native/dispatch.js'
import { createConversation, addUserMessage } from '../../src/native/conversation.js'
import {
  ensureTaskExecutionState,
  ensureRunWorkspaceForStructuredTask,
  evaluateWriteGuard,
} from '../../src/native/task-state.js'
import type { AnthropicToolUseBlock } from '../../src/native/protocol/types.js'
import { createRunWorkspace } from '../../src/native/run-workspace.js'

describe('Patch 3 · RunWorkspace producer wire-up', () => {
  let workspaceDir = ''
  let prevAllow: string | undefined
  let prevHome: string | undefined

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'owlcoda-p3-ws-'))
    prevAllow = process.env['OWLCODA_ALLOW_FS_ROOTS']
    prevHome = process.env['OWLCODA_HOME']
    // Allow writes in both workspace and tmpdir for test artifacts
    process.env['OWLCODA_ALLOW_FS_ROOTS'] = `${workspaceDir}:${tmpdir()}`
    process.env['OWLCODA_HOME'] = workspaceDir
    await installGuizangFixture(workspaceDir)
  })

  afterEach(async () => {
    if (prevAllow === undefined) delete process.env['OWLCODA_ALLOW_FS_ROOTS']
    else process.env['OWLCODA_ALLOW_FS_ROOTS'] = prevAllow
    if (prevHome === undefined) delete process.env['OWLCODA_HOME']
    else process.env['OWLCODA_HOME'] = prevHome
    await rm(workspaceDir, { recursive: true, force: true })
  })

  // ---------------------------------------------------------------------------
  // B1: SkillRoutePreview writes skill-route.json
  // ---------------------------------------------------------------------------
  describe('B1 · SkillRoutePreview → skill-route.json', () => {
    it('writes skill-route.json when RunWorkspace is attached', async () => {
      // Use a separate outputRoot outside workspaceDir (like real usage)
      const outputRoot = await mkdtemp(join(tmpdir(), 'owlcoda-p3-output-'))
      try {
        const rw = await createRunWorkspace({ outputRoot, cwd: workspaceDir })

        // Verify ledger starts empty
        const before = JSON.parse(await readFile(rw.paths.skillRoutePath, 'utf8'))
        expect(before).toEqual({})

        const tool = createSkillRoutePreviewTool()

        const result = await tool.execute(
          { prompt: '请生成一个 46 页横向 HTML PPT 输出到 /tmp/deck.html' },
          { taskState: { run: { runWorkspace: { runDir: rw.paths.runDir } } } as Parameters<typeof tool.execute>[1] extends { taskState?: infer T } ? T : never },
        )
        expect(result.isError).toBe(false)

        // Give the async fire-and-forget write time to land
        await new Promise((r) => setTimeout(r, 100))

        const after = JSON.parse(await readFile(rw.paths.skillRoutePath, 'utf8'))
        expect(after).toMatchObject({
          prompt: expect.stringContaining('PPT'),
          decidedAt: expect.any(String),
        })
      } finally {
        await rm(outputRoot, { recursive: true, force: true })
      }
    })

    it('does NOT throw when no RunWorkspace is attached', async () => {
      const tool = createSkillRoutePreviewTool()
      const result = await tool.execute({ prompt: 'write a report' })
      expect(result.isError).toBe(false)
    })

    it('silently swallows ledger write failures without degrading the result', async () => {
      const tool = createSkillRoutePreviewTool()
      // Inject a runWorkspace with a bogus runDir — write will fail silently
      const result = await tool.execute(
        { prompt: 'Generate PPT at /tmp/test.html' },
        { taskState: { run: { runWorkspace: { runDir: '/nonexistent/path' } } } as Parameters<typeof tool.execute>[1] extends { taskState?: infer T } ? T : never },
      )
      expect(result.isError).toBe(false)
      const payload = JSON.parse(result.output)
      expect(payload).toHaveProperty('selectedSkill')
    })
  })

  // ---------------------------------------------------------------------------
  // B2: TodoWrite mirrors to plan.json via dispatch
  // ---------------------------------------------------------------------------
  describe('B2 · TodoWrite → plan.json mirror', () => {
    it('mirrors todos to plan.json when RunWorkspace exists', async () => {
      // outputRoot must be outside workspaceDir so it parses as user-external
      const outputRoot = await mkdtemp(join(tmpdir(), 'owlcoda-p3-b2-output-'))
      try {
        const conversation = createConversation({ system: 'test', model: 'm' })
        addUserMessage(conversation, `Build the HTML PPT and output to ${outputRoot}/`)
        const taskState = ensureTaskExecutionState(conversation, workspaceDir)

        const dispatcher = new ToolDispatcher()

        // Create the run workspace (TaskCreate path)
        await dispatcher.executeTool({
          type: 'tool_use',
          id: 'task-create',
          name: 'TaskCreate',
          input: {
            subject: 'Build deck',
            description: 'Create deck and notes.',
            steps: [
              { id: 's1', title: 'Read sources', description: 'Read source material.' },
              { id: 's2', title: 'Write deck', description: 'Write deck file.' },
            ],
          },
        } as AnthropicToolUseBlock, { taskState })

        const rw = taskState.run.runWorkspace
        expect(rw).toBeDefined()
        expect(rw).not.toBeNull()

        // Now call TodoWrite — should mirror to plan.json
        await dispatcher.executeTool({
          type: 'tool_use',
          id: 'todo-write',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Research topic', status: 'completed', activeForm: 'Researching topic' },
              { content: 'Write slides', status: 'in_progress', activeForm: 'Writing slides' },
              { content: 'Export HTML', status: 'pending', activeForm: 'Exporting HTML' },
            ],
          },
        } as AnthropicToolUseBlock, { taskState })

        await new Promise((r) => setTimeout(r, 100))

        const planAfter = JSON.parse(await readFile(rw!.runDir + '/plan.json', 'utf8'))
        expect(planAfter.source).toBe('TodoWrite')
        expect(planAfter.steps).toHaveLength(3)
        expect(planAfter.steps[0].title).toBe('Research topic')
        expect(planAfter.steps[0].status).toBe('completed')
        expect(planAfter.steps[1].title).toBe('Write slides')
        expect(planAfter.steps[1].status).toBe('in_progress')
        expect(planAfter.steps[2].status).toBe('pending')
      } finally {
        await rm(outputRoot, { recursive: true, force: true })
      }
    })
  })

  // ---------------------------------------------------------------------------
  // B3: write/edit/bash → artifacts.json (outputRoot-scoped)
  // ---------------------------------------------------------------------------
  describe('B3 · artifact-producing tools → artifacts.json', () => {
    it('appends artifact when write lands inside outputRoot', async () => {
      const outputRoot = await mkdtemp(join(tmpdir(), 'owlcoda-p3-b3-output-'))
      try {
        const conversation = createConversation({ system: 'test', model: 'm' })
        addUserMessage(conversation, `Build the HTML PPT and output to ${outputRoot}/`)
        const taskState = ensureTaskExecutionState(conversation, workspaceDir)

        const dispatcher = new ToolDispatcher()

        // Create run workspace
        await dispatcher.executeTool({
          type: 'tool_use',
          id: 'task-create',
          name: 'TaskCreate',
          input: {
            subject: 'Build deck',
            description: 'Create deck.',
            steps: [{ id: 's1', title: 'Write deck', description: 'Write it.' }],
          },
        } as AnthropicToolUseBlock, { taskState })

        const rw = taskState.run.runWorkspace
        expect(rw).toBeDefined()
        expect(rw).not.toBeNull()

        const canonicalOutputRoot = await realpath(rw!.outputRoot)
        const artifactFile = join(canonicalOutputRoot, 'deck.html')

        // Write a file inside outputRoot
        await dispatcher.executeTool({
          type: 'tool_use',
          id: 'write-deck',
          name: 'write',
          input: { path: artifactFile, content: '<!doctype html><html><body>deck</body></html>' },
        } as AnthropicToolUseBlock, { taskState })

        const ledger = JSON.parse(await readFile(rw!.runDir + '/artifacts.json', 'utf8'))
        expect(ledger.artifacts.length).toBeGreaterThan(0)
        const artifact = ledger.artifacts.find((a: { path: string }) => a.path.endsWith('deck.html'))
        expect(artifact).toBeDefined()
        expect(artifact.origin).toBe('write')
      } finally {
        await rm(outputRoot, { recursive: true, force: true })
      }
    })

    it('does NOT append artifact when write lands outside outputRoot', async () => {
      const outputRoot = await mkdtemp(join(tmpdir(), 'owlcoda-p3-b3-exclude-'))
      try {
        const conversation = createConversation({ system: 'test', model: 'm' })
        addUserMessage(conversation, `Build the HTML PPT and output to ${outputRoot}/`)
        const taskState = ensureTaskExecutionState(conversation, workspaceDir)

        const dispatcher = new ToolDispatcher()

        await dispatcher.executeTool({
          type: 'tool_use',
          id: 'task-create',
          name: 'TaskCreate',
          input: {
            subject: 'Build deck',
            description: 'Create deck.',
            steps: [{ id: 's1', title: 'Write deck', description: 'Write it.' }],
          },
        } as AnthropicToolUseBlock, { taskState })

        const rw = taskState.run.runWorkspace
        expect(rw).toBeDefined()
        expect(rw).not.toBeNull()

        // Write to a completely different tmpdir location
        const scratchFile = join(tmpdir(), `owlcoda-p3-scratch-${Date.now()}.txt`)
        await dispatcher.executeTool({
          type: 'tool_use',
          id: 'write-scratch',
          name: 'write',
          input: { path: scratchFile, content: 'scratch' },
        } as AnthropicToolUseBlock, { taskState })

        const ledger = JSON.parse(await readFile(rw!.runDir + '/artifacts.json', 'utf8'))
        const scratchEntry = ledger.artifacts.find((a: { path: string }) => a.path === scratchFile)
        expect(scratchEntry).toBeUndefined()
      } finally {
        await rm(outputRoot, { recursive: true, force: true })
      }
    })

    it('appends artifact when bash writes inside outputRoot', async () => {
      const outputRoot = await mkdtemp(join(tmpdir(), 'owlcoda-p3-b3-bash-'))
      try {
        const conversation = createConversation({ system: 'test', model: 'm' })
        addUserMessage(conversation, `Build the HTML PPT and output to ${outputRoot}/`)
        const taskState = ensureTaskExecutionState(conversation, workspaceDir)

        const dispatcher = new ToolDispatcher()

        await dispatcher.executeTool({
          type: 'tool_use',
          id: 'task-create',
          name: 'TaskCreate',
          input: {
            subject: 'Build deck',
            description: 'Create deck.',
            steps: [{ id: 's1', title: 'Write deck', description: 'Write it.' }],
          },
        } as AnthropicToolUseBlock, { taskState })

        const rw = taskState.run.runWorkspace
        expect(rw).toBeDefined()
        expect(rw).not.toBeNull()

        const artifactFile = join(rw!.outputRoot, 'bash-deck.html')
        const result = await dispatcher.executeTool({
          type: 'tool_use',
          id: 'bash-deck',
          name: 'bash',
          input: {
            command: `cat > ${artifactFile} <<'EOF'\n<!doctype html><html><body>deck</body></html>\nEOF`,
            cwd: workspaceDir,
          },
        } as AnthropicToolUseBlock, { taskState })
        expect(result.result.isError).toBe(false)

        const ledger = JSON.parse(await readFile(rw!.runDir + '/artifacts.json', 'utf8'))
        const artifact = ledger.artifacts.find((a: { path: string }) => a.path.endsWith('bash-deck.html'))
        expect(artifact).toBeDefined()
        expect(artifact.origin).toBe('bash_detected')
        expect(artifact.status).toBe('present')
      } finally {
        await rm(outputRoot, { recursive: true, force: true })
      }
    })
  })

  // ---------------------------------------------------------------------------
  // B5: outputRoot added to allowedWritePaths with origin='run_workspace'
  // ---------------------------------------------------------------------------
  describe('B5 · outputRoot → allowedWritePaths origin=run_workspace', () => {
    it('adds outputRoot scope with run_workspace origin after workspace creation', async () => {
      const outputRoot = await mkdtemp(join(tmpdir(), 'owlcoda-p3-b5-'))
      try {
        const conversation = createConversation({ system: 'test', model: 'm' })
        addUserMessage(conversation, `Build the HTML PPT and output to ${outputRoot}/`)
        const taskState = ensureTaskExecutionState(conversation, workspaceDir)

        await ensureRunWorkspaceForStructuredTask(taskState, 'TaskCreate', {
          subject: 'Build deck',
          description: 'Create deck.',
          steps: [{ id: 's1', title: 'Write', description: 'Write it.' }],
        }, undefined)

        const rw = taskState.run.runWorkspace
        expect(rw).toBeDefined()
        expect(rw).not.toBeNull()

        const runWorkspaceScope = taskState.contract.allowedWritePaths.find(
          (s) => s.origin === 'run_workspace',
        )
        expect(runWorkspaceScope).toBeDefined()
        expect(runWorkspaceScope!.kind).toBe('directory')
        expect(runWorkspaceScope!.path).toBe(rw!.outputRoot)
      } finally {
        await rm(outputRoot, { recursive: true, force: true })
      }
    })

    it('evaluateWriteGuard does NOT block writes to outputRoot (run_workspace scope)', async () => {
      const outputRoot = await mkdtemp(join(tmpdir(), 'owlcoda-p3-b5-guard-'))
      try {
        const conversation = createConversation({ system: 'test', model: 'm' })
        addUserMessage(conversation, `Build the HTML PPT and output to ${outputRoot}/`)
        const taskState = ensureTaskExecutionState(conversation, workspaceDir)

        await ensureRunWorkspaceForStructuredTask(taskState, 'TaskCreate', {
          subject: 'Build deck',
          description: 'Create deck.',
          steps: [{ id: 's1', title: 'Write', description: 'Write it.' }],
        }, undefined)

        const rw = taskState.run.runWorkspace
        expect(rw).toBeDefined()
        expect(rw).not.toBeNull()

        // A write to a file inside outputRoot must NOT be blocked
        const targetPath = join(rw!.outputRoot, 'deck.html')
        const violation = evaluateWriteGuard('write', { path: targetPath }, taskState)
        expect(violation).toBeNull()
      } finally {
        await rm(outputRoot, { recursive: true, force: true })
      }
    })

    it('run_workspace scope is added exactly once even on duplicate create calls', async () => {
      const outputRoot = await mkdtemp(join(tmpdir(), 'owlcoda-p3-b5-dedup-'))
      try {
        const conversation = createConversation({ system: 'test', model: 'm' })
        addUserMessage(conversation, `Build the HTML PPT and output to ${outputRoot}/`)
        const taskState = ensureTaskExecutionState(conversation, workspaceDir)

        // First call — creates workspace and adds scope
        await ensureRunWorkspaceForStructuredTask(taskState, 'TaskCreate', {
          subject: 'Build deck',
          description: 'Create deck.',
          steps: [{ id: 's1', title: 'Write', description: 'Write it.' }],
        }, undefined)

        // Second call — already_exists, should not re-add scope
        await ensureRunWorkspaceForStructuredTask(taskState, 'TaskCreate', {
          subject: 'Build deck',
          description: 'Create deck.',
          steps: [{ id: 's1', title: 'Write', description: 'Write it.' }],
        }, undefined)

        const runWorkspaceScopes = taskState.contract.allowedWritePaths.filter(
          (s) => s.origin === 'run_workspace',
        )
        expect(runWorkspaceScopes.length).toBe(1)
      } finally {
        await rm(outputRoot, { recursive: true, force: true })
      }
    })

    it('does not create RunWorkspace from a single external file target', async () => {
      const outputRoot = await mkdtemp(join(tmpdir(), 'owlcoda-p3-b5-file-scope-'))
      try {
        const targetFile = join(outputRoot, 'deck.html')
        const conversation = createConversation({ system: 'test', model: 'm' })
        addUserMessage(conversation, `Build the HTML PPT and output to ${targetFile}`)
        const taskState = ensureTaskExecutionState(conversation, workspaceDir)

        const result = await ensureRunWorkspaceForStructuredTask(taskState, 'TaskCreate', {
          subject: 'Build deck',
          description: 'Create deck.',
          steps: [{ id: 's1', title: 'Write', description: 'Write it.' }],
        }, undefined)

        expect(result.created).toBe(false)
        expect(result.reason).toBe('no_trusted_write_scope')
        expect(taskState.run.runWorkspace).toBeNull()
        expect(taskState.contract.allowedWritePaths.some((s) => s.origin === 'run_workspace')).toBe(false)
      } finally {
        await rm(outputRoot, { recursive: true, force: true })
      }
    })
  })
})

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------
async function installGuizangFixture(root: string): Promise<void> {
  const skillDir = join(root, 'skills', 'guizang-ppt-skill')
  await mkdir(join(skillDir, 'references'), { recursive: true })
  await mkdir(join(skillDir, 'assets'), { recursive: true })
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---
name: guizang-ppt-skill
description: Generate horizontal HTML PPT decks.
when_to_use: Use for HTML PPT and web deck artifact generation.
---
# Guizang PPT Skill
`,
    'utf8',
  )
  await writeFile(join(skillDir, 'references', 'themes.md'), '# Themes\n', 'utf8')
  await writeFile(join(skillDir, 'assets', 'template.html'), '<!doctype html>\n', 'utf8')
}
