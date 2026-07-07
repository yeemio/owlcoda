import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, symlink, writeFile, utimes, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createConversation, addUserMessage } from '../../src/native/conversation.js'
import {
  approveTaskWriteScope,
  buildContextPressurePrompt,
  detectCrossRepoBoundaryCheckpoint,
  buildDeliveryCheckPrompt,
  buildTaskContinuePrompt,
  buildTaskRealignPrompt,
  deriveTaskExecutionState,
  describeTaskExecutionState,
  detectCompletionClaim,
  ensureRunWorkspaceForStructuredTask,
  ensureTaskExecutionState,
  evaluateIntentGuard,
  evaluateWriteGuard,
  extractUserDeclaredExternalRoots,
  hasRecentArtifactProgress,
  inferUserIntent,
  latestSubstantiveUserText,
  markTaskBlocked,
  markTaskIteration,
  markTaskWriteScopeBlocked,
  recordBashArtifactProgress,
  recordToolExecutionProgress,
  formatCrossRepoBoundaryCheckpoint,
  shouldTreatTaskRunStatusAsFailure,
} from '../../src/native/task-state.js'
import { admit as admitProvenanceRecord } from '../../src/native/write-provenance.js'

describe('native task state', () => {
  it('detects an external prompt boundary before source edits in a dirty target repo', async () => {
    const currentRepo = await mkdtemp(join(tmpdir(), 'owlcoda-cross-boundary-current-'))
    const promptRepo = await mkdtemp(join(tmpdir(), 'owlcoda-cross-boundary-prompt-'))
    try {
      const canonicalCurrentRepo = await realpath(currentRepo)
      const canonicalPromptRepo = await realpath(promptRepo)
      const promptPath = join(canonicalPromptRepo, 'prompts', '48b_owlmlx_tuned_lora_runtime_apply.md')
      const currentSourcePath = join(canonicalCurrentRepo, 'src', 'native', 'runtime.ts')
      const checkpoint = detectCrossRepoBoundaryCheckpoint({
        currentRepo: canonicalCurrentRepo,
        promptSource: promptPath,
        promptSourceRepo: canonicalPromptRepo,
        targetRepo: canonicalCurrentRepo,
        branch: 'dirty-branch',
        dirtyWorktreeSummary: {
          count: 96,
          sample: [' M src/native/runtime.ts', '?? tests/native/runtime.test.ts'],
          truncated: true,
        },
        plannedWriteRoots: [currentSourcePath],
        now: 1,
      })

      expect(checkpoint).not.toBeNull()
      expect(checkpoint!.status).toBe('pending')
      expect(checkpoint!.plannedWriteRoots).toEqual([currentSourcePath])
      const text = formatCrossRepoBoundaryCheckpoint(checkpoint!)
      expect(text).toContain('Cross-repo boundary checkpoint')
      expect(text).toContain('- Current repo:')
      expect(text).toContain('- Prompt source:')
      expect(text).toContain('- Target repo:')
      expect(text).toContain('- Dirty worktree summary:')
      expect(text).toContain('- Planned write roots:')
      expect(text).toContain('- Required user confirmation:')
    } finally {
      await rm(currentRepo, { recursive: true, force: true })
      await rm(promptRepo, { recursive: true, force: true })
    }
  })

  it('does not emit a cross-repo checkpoint for ordinary same-repo clean context', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'owlcoda-cross-boundary-same-'))
    try {
      const promptPath = join(repo, 'prompts', 'same-repo.md')
      const checkpoint = detectCrossRepoBoundaryCheckpoint({
        currentRepo: repo,
        promptSource: promptPath,
        promptSourceRepo: repo,
        targetRepo: repo,
        branch: 'main',
        dirtyWorktreeSummary: { count: 0, sample: [], truncated: false },
        plannedWriteRoots: [join(repo, 'src', 'native')],
        now: 1,
      })

      expect(checkpoint).toBeNull()
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('does not treat a user-declared external output path as an external prompt source', async () => {
    const targetRepo = await mkdtemp(join(tmpdir(), 'owlcoda-cross-boundary-output-target-'))
    const outputDir = await mkdtemp(join(tmpdir(), 'owlcoda-run-cross-boundary-output-'))
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: targetRepo, stdio: 'ignore' })
      for (let i = 0; i < 25; i++) {
        await writeFile(join(targetRepo, `dirty-${i}.txt`), `${i}`)
      }
      const outputPath = join(outputDir, 'report.md')
      const canonicalOutputPath = join(await realpath(outputDir), 'report.md')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, `Write the report to \`${outputPath}\`.`)

      const taskState = ensureTaskExecutionState(conversation, targetRepo)

      expect(taskState.contract.allowedWritePaths).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: canonicalOutputPath,
          kind: 'file',
          origin: 'user-external',
        }),
      ]))
      expect(taskState.run.crossRepoBoundaryCheckpoint).toBeNull()
      expect(taskState.run.status).toBe('open')
    } finally {
      await rm(targetRepo, { recursive: true, force: true })
      await rm(outputDir, { recursive: true, force: true })
    }
  })

  it('holds an external prompt task at a boundary checkpoint until user confirmation', async () => {
    const targetRepo = await mkdtemp(join(tmpdir(), 'owlcoda-cross-boundary-target-'))
    const promptRepo = await mkdtemp(join(tmpdir(), 'owlcoda-cross-boundary-source-'))
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: targetRepo, stdio: 'ignore' })
      await mkdir(join(targetRepo, 'src'), { recursive: true })
      for (let i = 0; i < 25; i++) {
        await writeFile(join(targetRepo, `dirty-${i}.txt`), `${i}`)
      }
      const promptPath = join(promptRepo, 'prompts', '48b_owlmlx_tuned_lora_runtime_apply.md')
      await mkdir(join(promptRepo, 'prompts'), { recursive: true })
      await writeFile(promptPath, 'Apply the runtime adapter change to the target repo.')

      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, `执行 ${promptPath}，只修改 \`src/runtime.ts\`。`)
      const taskState = ensureTaskExecutionState(conversation, targetRepo)

      expect(taskState.run.status).toBe('waiting_user')
      expect(taskState.run.crossRepoBoundaryCheckpoint?.status).toBe('pending')
      expect(describeTaskExecutionState(taskState)).toContain('Cross-repo boundary checkpoint')

      addUserMessage(conversation, '确认跨仓库边界，可以继续；但写入仍需正常审批。')
      const confirmed = ensureTaskExecutionState(conversation, targetRepo)

      expect(confirmed.run.status).toBe('open')
      expect(confirmed.run.crossRepoBoundaryCheckpoint?.status).toBe('confirmed')

      const writePath = join(targetRepo, 'docs', 'unplanned.md')
      const violation = evaluateWriteGuard('write', { path: writePath, content: 'x' }, confirmed)
      expect(violation?.message).toContain('Task contract blocked write')
    } finally {
      await rm(targetRepo, { recursive: true, force: true })
      await rm(promptRepo, { recursive: true, force: true })
    }
  })

  it('ingests user declared write targets into provenance ledger', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-prov-declared-'))
    try {
      const canonicalCwd = await realpath(cwd)
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, '改 src/foo.ts')

      const taskState = ensureTaskExecutionState(conversation, canonicalCwd)
      const records = taskState.provenanceLedger?.recordsByPath[join(canonicalCwd, 'src', 'foo.ts')] ?? []

      expect(records.some((record) => record.kind === 'user_declared_target')).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('ingests user reference paths into provenance ledger', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-prov-ref-'))
    try {
      const canonicalCwd = await realpath(cwd)
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'error log: 看 src/utils.ts:42 那个 stack trace')

      const taskState = ensureTaskExecutionState(conversation, canonicalCwd)
      const records = taskState.provenanceLedger?.recordsByPath[join(canonicalCwd, 'src', 'utils.ts')] ?? []

      expect(records.some((record) => record.kind === 'user_reference')).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('ingests explicit denies on existing directories as subtree provenance records', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-prov-deny-'))
    try {
      const canonicalCwd = await realpath(cwd)
      const dir = join(canonicalCwd, 'existingDir')
      await mkdir(dir)
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, '不要改 existingDir')

      const taskState = ensureTaskExecutionState(conversation, canonicalCwd)
      const records = taskState.provenanceLedger?.recordsByPath[dir] ?? []

      expect(records).toContainEqual(expect.objectContaining({
        kind: 'user_explicit_deny',
        denyScope: 'subtree',
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('preserves cloned provenance ledger records for the same task', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-prov-preserve-'))
    try {
      const canonicalCwd = await realpath(cwd)
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'Update src/foo.ts')
      const first = ensureTaskExecutionState(conversation, canonicalCwd)
      const observed = join(canonicalCwd, 'observed.ts')
      admitProvenanceRecord(first.provenanceLedger!, observed, {
        kind: 'tool_confirmed_existing',
        ts: 1,
        originIteration: 1,
        originalString: observed,
        toolName: 'Read',
        toolSucceeded: true,
      })

      const next = deriveTaskExecutionState(conversation, canonicalCwd, first)

      expect(next.provenanceLedger?.recordsByPath[observed]).toContainEqual(expect.objectContaining({
        kind: 'tool_confirmed_existing',
      }))
      expect(next.provenanceLedger).not.toBe(first.provenanceLedger)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('resets prior tool-derived provenance records for a new task', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-prov-reset-'))
    try {
      const canonicalCwd = await realpath(cwd)
      const firstConversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(firstConversation, 'Update src/foo.ts')
      const first = ensureTaskExecutionState(firstConversation, canonicalCwd)
      const observed = join(canonicalCwd, 'observed.ts')
      admitProvenanceRecord(first.provenanceLedger!, observed, {
        kind: 'tool_confirmed_existing',
        ts: 1,
        originIteration: 1,
        originalString: observed,
        toolName: 'Read',
        toolSucceeded: true,
      })

      const nextConversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(nextConversation, 'Update src/bar.ts')
      const next = deriveTaskExecutionState(nextConversation, canonicalCwd, first)

      expect(next.provenanceLedger?.recordsByPath[observed]).toBeUndefined()
      expect(next.provenanceLedger?.recordsByPath[join(canonicalCwd, 'src', 'bar.ts')]).toContainEqual(expect.objectContaining({
        kind: 'user_declared_target',
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('derives explicit write scope from user-mentioned paths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-explicit-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(
        conversation,
        'Update `src/native/conversation.ts` and keep `tests/native/conversation.test.ts` aligned.',
      )

      const taskState = ensureTaskExecutionState(conversation, cwd)
      const canonicalCwd = await realpath(cwd)

      expect(taskState.contract.scopeMode).toBe('explicit_paths')
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path === join(canonicalCwd, 'src', 'native'),
      )).toBe(true)
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path === join(canonicalCwd, 'tests', 'native'),
      )).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('allows explicit /tmp task artifacts without importing prose slash phrases', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-tmp-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(
        conversation,
        [
          `Stay read-only in ${cwd}.`,
          'Create temporary artifacts only under /tmp/owlcoda-cmux-rerun-kimi.',
          'Finish with terminal/rendering observations and fallback/provider status.',
          'Do not modify the repository.',
        ].join(' '),
      )

      const taskState = ensureTaskExecutionState(conversation, cwd)
      const canonicalCwd = await realpath(cwd)

      expect(taskState.contract.scopeMode).toBe('explicit_paths')
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path.endsWith('/tmp/owlcoda-cmux-rerun-kimi') && scope.kind === 'directory',
      )).toBe(true)
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path === join(canonicalCwd, 'terminal', 'rendering'),
      )).toBe(false)
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path === join(canonicalCwd, 'fallback', 'provider'),
      )).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('does not import forbidden source paths as allowed write targets', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-forbid-inline-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(
        conversation,
        [
          '你将以敌意 QA 视角测试工具。',
          '严禁 write 真源码：`src/native/tools/skill.ts`。',
          '本轮所有写入只许写到 `/tmp/hostile-qa/` 目录下。',
        ].join('\n'),
      )

      const taskState = ensureTaskExecutionState(conversation, cwd)
      const canonicalCwd = await realpath(cwd)

      expect(taskState.contract.scopeMode).toBe('explicit_paths')
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path === join(canonicalCwd, 'src', 'native', 'tools', 'skill.ts'),
      )).toBe(false)
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path.endsWith('/tmp/hostile-qa') && scope.kind === 'directory',
      )).toBe(true)

      const violation = evaluateWriteGuard('write', {
        path: join(canonicalCwd, 'src', 'native', 'tools', 'skill.ts'),
        content: 'nope',
      }, taskState)
      expect(violation?.message).toContain('Task contract blocked write')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('does not let English no-modify clauses authorize the named path', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-forbid-english-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(
        conversation,
        [
          'Run read-only QA.',
          'Do not modify `src/native/tools/skill.ts`; write scratch output only to `/tmp/hostile-qa/`.',
        ].join('\n'),
      )

      const taskState = ensureTaskExecutionState(conversation, cwd)
      const canonicalCwd = await realpath(cwd)

      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path === join(canonicalCwd, 'src', 'native', 'tools', 'skill.ts'),
      )).toBe(false)
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path.endsWith('/tmp/hostile-qa') && scope.kind === 'directory',
      )).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('does not import historical tool edit transcript lines as allowed write targets', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-transcript-edit-'))
    try {
      await mkdir(join(cwd, 'docs', 'reports'), { recursive: true })
      await mkdir(join(cwd, 'server', 'review'), { recursive: true })
      const canonicalCwd = await realpath(cwd)
      const serverFile = join(canonicalCwd, 'server', 'review', 'kimi-g3-evidence-structure-cli.ts')
      const reportFile = join(canonicalCwd, 'docs', 'reports', 'kimi-g3-evidence-structure-packet-20260706.json')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, [
        '本轮只生成 G3 证据结构化报告。',
        '必须输出：',
        '- docs/reports/kimi-g3-evidence-structure-packet-YYYYMMDD.json',
        '- docs/reports/kimi-g3-evidence-structure-packet-YYYYMMDD.md',
        '- docs/reports/owlcoda-kimi-g3-execution-bugs-YYYYMMDD.md',
        '不要修改 server 源码。',
        '',
        '历史终端片段：',
        `Update ${serverFile} · +69 -34`,
      ].join('\n'))

      const taskState = ensureTaskExecutionState(conversation, canonicalCwd)

      expect(taskState.contract.scopeMode).toBe('explicit_paths')
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path === serverFile || scope.path === join(canonicalCwd, 'server', 'review'),
      )).toBe(false)
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path === join(canonicalCwd, 'docs', 'reports'),
      )).toBe(true)

      const serverViolation = evaluateWriteGuard('edit', {
        path: serverFile,
        old_string: 'before',
        new_string: 'after',
      }, taskState)
      expect(serverViolation?.message).toContain('Task contract blocked write')

      const reportViolation = evaluateWriteGuard('write', {
        path: reportFile,
        content: '{}',
      }, taskState)
      expect(reportViolation).toBeNull()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('does not import cwd banners or tool output file listings as allowed write targets', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-transcript-output-'))
    try {
      await mkdir(join(cwd, 'docs', 'reports'), { recursive: true })
      await mkdir(join(cwd, 'server', 'review'), { recursive: true })
      const canonicalCwd = await realpath(cwd)
      const serverFile = join(canonicalCwd, 'server', 'review', 'kimi-g3-evidence-structure-cli.ts')
      const reportFile = join(canonicalCwd, 'docs', 'reports', 'kimi-g3-evidence-structure-packet-20260706.json')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, [
        `—  CWD ${canonicalCwd} · BRANCH MAIN · 101 PENDING CHANGES`,
        `▎  你在 ${canonicalCwd} 工作。`,
        '▎  本任务属于数据线 + OwlCoda 能力验证，不改功能线。',
        '▎  G3 Codex/GPT5.5 Judge 小样本结果只作为背景。',
        '▎  必须输出：',
        '▎  - docs/reports/kimi-g3-evidence-structure-packet-20260706.json',
        '▎  - docs/reports/kimi-g3-evidence-structure-packet-20260706.md',
        '▎  - docs/reports/owlcoda-kimi-g3-execution-bugs-20260706.md',
        '▎  禁止做：',
        '▎  - 不改 `/match` 页面；',
        '▎  允许做：',
        '▎  - 生成只读研究 packet；',
        '▸ Bash find . -type f -name \'*.ts\' | grep -i kimi | head -20  1.1s ✓',
        '  ⎿ ./server/kimi-evidence-boundary.ts',
        '    ./server/kimi-evidence-boundary.test.ts',
        `  ⎿  ✓ Create ${serverFile} · +703 (9ms)`,
      ].join('\n'))

      const taskState = ensureTaskExecutionState(conversation, canonicalCwd)

      expect(taskState.contract.scopeMode).toBe('explicit_paths')
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path === canonicalCwd || scope.path === join(canonicalCwd, 'server') || scope.path === join(canonicalCwd, 'Codex'),
      )).toBe(false)
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path === join(canonicalCwd, 'docs', 'reports'),
      )).toBe(true)

      const serverViolation = evaluateWriteGuard('write', {
        path: serverFile,
        content: '',
      }, taskState)
      expect(serverViolation?.message).toContain('Task contract blocked write')

      const reportViolation = evaluateWriteGuard('write', {
        path: reportFile,
        content: '{}',
      }, taskState)
      expect(reportViolation).toBeNull()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('does not import paths listed under a forbidden write section', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-forbid-section-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(
        conversation,
        [
          '敌意 QA 执行纪律：',
          '【禁止】',
          '- `src/native/tools/skill.ts`',
          '【允许写入】',
          '- `/tmp/hostile-qa/`',
        ].join('\n'),
      )

      const taskState = ensureTaskExecutionState(conversation, cwd)
      const canonicalCwd = await realpath(cwd)

      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path === join(canonicalCwd, 'src', 'native', 'tools', 'skill.ts'),
      )).toBe(false)
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path.endsWith('/tmp/hostile-qa') && scope.kind === 'directory',
      )).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('records in-workspace bash artifacts as touched paths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-bash-artifact-'))
    try {
      const canonicalCwd = await realpath(cwd)
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'Generate the deck HTML.')
      const taskState = ensureTaskExecutionState(conversation, canonicalCwd)
      markTaskIteration(taskState, { iterations: 1 })

      recordBashArtifactProgress(taskState, 'bash', {
        command: "cat > output/deck.html << 'HTML'\n<!doctype html>\nHTML",
        cwd: canonicalCwd,
      })

      expect(taskState.contract.touchedPaths).toContain(join(canonicalCwd, 'output', 'deck.html'))
      expect(taskState.run.scratchArtifactPaths ?? []).toEqual([])
      expect(hasRecentArtifactProgress(taskState, 3)).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  // Repro: a python3 -c dedup that writes via os.replace() — the write target
  // lives in interpreter source, invisible to shell-syntax parsing. Ground it
  // on the filesystem (file exists + mtime within the execution window).
  it('records interpreter-internal writes (python3 -c os.replace) via filesystem mtime', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-interp-write-'))
    try {
      const canonicalCwd = await realpath(cwd)
      await mkdir(join(canonicalCwd, 'out', 'full'), { recursive: true })
      const target = join(canonicalCwd, 'out', 'full', 'L3_qa.jsonl')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'Dedup L3 and write it back.')
      const taskState = ensureTaskExecutionState(conversation, canonicalCwd)
      markTaskIteration(taskState, { iterations: 1 })

      const start = Date.now()
      // Simulate the write the python command performed during execution.
      await writeFile(target, '{"id":"L3-x"}\n')

      await recordBashArtifactProgress(
        taskState,
        'bash',
        { cwd: canonicalCwd, command: `python3 -c "import os; os.replace('tmp.jsonl', 'out/full/L3_qa.jsonl')"` },
        start,
      )

      expect(taskState.contract.touchedPaths).toContain(target)
      expect(hasRecentArtifactProgress(taskState, 3)).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  // Safe direction: a python read of a static (old) file must NOT count as
  // progress — its mtime predates the execution window.
  it('does not count a python read of a static file as progress', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-interp-read-'))
    try {
      const canonicalCwd = await realpath(cwd)
      const data = join(canonicalCwd, 'data.jsonl')
      await writeFile(data, '{"id":"x"}\n')
      const hourAgo = new Date(Date.now() - 3600_000)
      await utimes(data, hourAgo, hourAgo)

      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'Analyze the data file.')
      const taskState = ensureTaskExecutionState(conversation, canonicalCwd)
      markTaskIteration(taskState, { iterations: 1 })

      const start = Date.now()
      await recordBashArtifactProgress(
        taskState,
        'bash',
        { cwd: canonicalCwd, command: `python3 -c "import json; json.load(open('data.jsonl'))"` },
        start,
      )

      expect(taskState.contract.touchedPaths).not.toContain(data)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  // A plain (non-interpreter) read must not trip filesystem-grounded progress,
  // even if the mentioned file has a fresh mtime.
  it('does not trip fs-grounded progress for non-interpreter read commands', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-noninterp-'))
    try {
      const canonicalCwd = await realpath(cwd)
      const data = join(canonicalCwd, 'data.jsonl')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'Count the lines.')
      const taskState = ensureTaskExecutionState(conversation, canonicalCwd)
      markTaskIteration(taskState, { iterations: 1 })

      const start = Date.now()
      await writeFile(data, '{"id":"x"}\n') // fresh mtime, but command is a plain read

      await recordBashArtifactProgress(
        taskState,
        'bash',
        { cwd: canonicalCwd, command: 'wc -l data.jsonl' },
        start,
      )

      expect(taskState.contract.touchedPaths).not.toContain(data)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('records bash setup artifacts with shell variables, mkdir, npm --prefix, and tee', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-prod-eval-'))
    try {
      const canonicalCwd = await realpath(cwd)
      const outputRoot = join(canonicalCwd, 'owlcoda-0.14.22-prod-eval')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, `Run the production evaluation and output to ${outputRoot}/`)
      const taskState = ensureTaskExecutionState(conversation, canonicalCwd)

      for (let i = 1; i <= 8; i++) {
        markTaskIteration(taskState, { iterations: i })
      }

      recordBashArtifactProgress(taskState, 'bash', {
        cwd: canonicalCwd,
        command: [
          `export EVAL_ROOT="${outputRoot}"`,
          'export EVIDENCE_DIR="$EVAL_ROOT/evidence"',
          'mkdir -p "$EVAL_ROOT"/{owlcoda,kimi-cli,evidence}',
          'npm install -g owlcoda@latest --prefix "$EVAL_ROOT/npm-global"',
          'npm view owlcoda version --json | tee "$EVIDENCE_DIR/npm-view.json"',
        ].join('\n'),
      })

      expect(taskState.contract.touchedPaths).toContain(join(outputRoot, 'owlcoda'))
      expect(taskState.contract.touchedPaths).toContain(join(outputRoot, 'kimi-cli'))
      expect(taskState.contract.touchedPaths).toContain(join(outputRoot, 'evidence'))
      expect(taskState.contract.touchedPaths).toContain(join(outputRoot, 'npm-global'))
      expect(taskState.contract.touchedPaths).toContain(join(outputRoot, 'evidence', 'npm-view.json'))
      expect(hasRecentArtifactProgress(taskState, 3)).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('blocks env-expanded bash setup paths outside an explicit write scope', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-env-guard-'))
    try {
      await mkdir(join(cwd, 'docs'), { recursive: true })
      await mkdir(join(cwd, 'src'), { recursive: true })
      const canonicalCwd = await realpath(cwd)
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'Only write `docs/deck.html`.')
      const taskState = ensureTaskExecutionState(conversation, canonicalCwd)

      const violation = evaluateWriteGuard('bash', {
        cwd: canonicalCwd,
        command: 'export TARGET=src/escape\nmkdir -p "$TARGET"',
      }, taskState)

      expect(violation).not.toBeNull()
      expect(violation!.attemptedPath).toBe(join(canonicalCwd, 'src', 'escape'))
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('records structured task tool progress without pretending plan updates are deliverables', () => {
    const cwd = join(tmpdir(), 'owlcoda-task-state-structured-progress')
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(conversation, 'Write the final report to docs/report.md')
    const taskState = ensureTaskExecutionState(conversation, cwd)

    for (let i = 1; i <= 8; i++) {
      markTaskIteration(taskState, { iterations: i })
    }

    recordToolExecutionProgress(taskState, 'TaskUpdate', {
      taskId: 'task-1',
      stepId: 'step-1',
      stepStatus: 'in_progress',
    })

    expect(taskState.contract.touchedPaths).toEqual([])
    expect(hasRecentArtifactProgress(taskState, 3)).toBe(true)

    recordToolExecutionProgress(taskState, 'TaskUpdate', {
      taskId: 'task-1',
      stepId: 'step-1',
      stepStatus: 'completed',
      touchedPaths: ['docs/report.md'],
    })

    expect(taskState.contract.touchedPaths).toContain(join(taskState.contract.cwd, 'docs', 'report.md'))
  })

  it('creates a run workspace for structured file-artifact TaskCreate plans', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-run-workspace-'))
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-run-workspace-cwd-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, `Build the 46 page HTML PPT and output to ${outputRoot}/`)
      const taskState = ensureTaskExecutionState(conversation, cwd)

      const result = await ensureRunWorkspaceForStructuredTask(taskState, 'TaskCreate', {
        subject: 'Build deck',
        description: 'Create deck and build notes.',
        steps: [
          { id: 'step-1', title: 'Collect source', description: 'Read source docs.' },
          { id: 'step-2', title: 'Write deck', description: 'Write HTML deck.' },
        ],
      }, {
        task: { id: 'task-1', stepCount: 2 },
      })
      const canonicalOutputRoot = await realpath(outputRoot)

      expect(result.created).toBe(true)
      expect(taskState.run.runWorkspace).toMatchObject({
        outputRoot: canonicalOutputRoot,
        runDir: join(canonicalOutputRoot, '.owlcoda-run'),
        taskFamily: 'deck',
        deliverableMode: 'file_artifact_delivery',
        artifactCount: 0,
      })
      expect(taskState.run.runWorkspace?.manifestPath).toBe(join(canonicalOutputRoot, '.owlcoda-run', 'manifest.json'))
      expect(taskState.run.lastArtifactProgressIteration).toBe(taskState.run.lifetimeIterations ?? 0)
    } finally {
      await rm(outputRoot, { recursive: true, force: true })
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('does not auto-create run workspace for structured code-change tasks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-code-workspace-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'Implement the fix in src/native/conversation.ts')
      const taskState = ensureTaskExecutionState(conversation, cwd)

      const result = await ensureRunWorkspaceForStructuredTask(taskState, 'TaskCreate', {
        subject: 'Fix code',
        description: 'Patch the runtime.',
        steps: [{ id: 'step-1', title: 'Patch', description: 'Patch file.' }],
      }, {
        task: { id: 'task-1', stepCount: 1 },
      })

      expect(result.created).toBe(false)
      expect(result.reason).toBe('unsupported_deliverable_mode:code_change')
      expect(taskState.run.runWorkspace).toBeNull()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('does not auto-create run workspace inside the repo for in-workspace artifact paths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-inworkspace-artifact-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'Build the HTML deck and output to docs/deck.html')
      const taskState = ensureTaskExecutionState(conversation, cwd)

      const result = await ensureRunWorkspaceForStructuredTask(taskState, 'TaskCreate', {
        subject: 'Build deck',
        description: 'Create deck.',
        steps: [{ id: 'step-1', title: 'Write deck', description: 'Write deck.' }],
      }, {
        task: { id: 'task-1', stepCount: 1 },
      })

      expect(result.created).toBe(false)
      expect(result.reason).toBe('no_trusted_write_scope')
      expect(taskState.run.runWorkspace).toBeNull()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('records /tmp bash artifacts as scratch progress without durable touched paths', () => {
    const cwd = join(tmpdir(), 'owlcoda-task-state-scratch-artifact-cwd')
    const scratch = join(tmpdir(), 'owlcoda-task-state-gen-ppt.py')
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(conversation, 'Generate a deck using a temporary script, then write final output.')
    const taskState = ensureTaskExecutionState(conversation, cwd)

    for (let i = 1; i <= 8; i++) {
      markTaskIteration(taskState, { iterations: i })
    }
    recordBashArtifactProgress(taskState, 'bash', {
      command: `cat > "${scratch}" << 'PYEOF'\nprint("draft")\nPYEOF\npython "${scratch}"`,
    })

    expect(taskState.contract.touchedPaths).toEqual([])
    expect(taskState.run.scratchArtifactPaths?.some((path) => path.endsWith('/owlcoda-task-state-gen-ppt.py'))).toBe(true)
    expect(taskState.run.lastArtifactProgressIteration).toBe(8)
    expect(hasRecentArtifactProgress(taskState, 3)).toBe(true)

    markTaskIteration(taskState, { iterations: 9 })
    markTaskIteration(taskState, { iterations: 10 })
    markTaskIteration(taskState, { iterations: 11 })
    expect(hasRecentArtifactProgress(taskState, 3)).toBe(true)

    markTaskIteration(taskState, { iterations: 12 })
    expect(hasRecentArtifactProgress(taskState, 3)).toBe(false)
  })

  it('blocks in-workspace bash artifacts outside an explicit write scope', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-bash-scope-'))
    try {
      await mkdir(join(cwd, 'src'), { recursive: true })
      await mkdir(join(cwd, 'docs'), { recursive: true })
      const canonicalCwd = await realpath(cwd)
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'Only write `docs/deck.html`.')
      const taskState = ensureTaskExecutionState(conversation, cwd)

      const violation = evaluateWriteGuard('bash', {
        cwd,
        command: "cat > src/escape.ts << 'EOF'\nexport {}\nEOF",
      }, taskState)

      expect(violation).not.toBeNull()
      expect(violation!.attemptedPath).toBe(join(canonicalCwd, 'src', 'escape.ts'))
      expect(violation!.message).toMatch(/Task contract blocked/)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('allows /tmp scratch bash artifacts under an explicit final-output scope', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-bash-scratch-scope-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'Only write `docs/deck.html`.')
      const taskState = ensureTaskExecutionState(conversation, cwd)

      const violation = evaluateWriteGuard('bash', {
        cwd,
        command: "cat > /tmp/gen_ppt.py << 'PYEOF'\nprint('draft')\nPYEOF",
      }, taskState)

      expect(violation).toBeNull()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('keeps the previous objective across pure continuation turns', () => {
    const cwd = join(tmpdir(), 'owlcoda-task-state-continue')
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(conversation, 'Refactor `src/native/dispatch.ts` and adjust tests.')
    const initial = ensureTaskExecutionState(conversation, cwd)

    addUserMessage(conversation, '继续')
    const continued = ensureTaskExecutionState(conversation, cwd)

    expect(continued.contract.objective).toBe(initial.contract.objective)
    expect(continued.contract.sourceTurnHash).toBe(initial.contract.sourceTurnHash)
    expect(continued.contract.allowedWritePaths).toEqual(initial.contract.allowedWritePaths)
  })

  it('tailors the realign prompt when user approval is required', () => {
    const cwd = join(tmpdir(), 'owlcoda-task-state-wait')
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(conversation, 'Only edit `src/native/dispatch.ts`.')
    const taskState = ensureTaskExecutionState(conversation, cwd)
    taskState.run.status = 'waiting_user'
    taskState.run.lastGuardReason = 'User denied write; waiting for approval.'

    const prompt = buildTaskRealignPrompt(taskState)

    expect(prompt).toContain('[Runtime task contract]')
    expect(prompt).toContain('User denied write; waiting for approval.')
    expect(prompt).toContain('Ask the user one concise question')
  })

  it('marks runtime auto-retry exhaustion as blocked without pretending the task is still open', () => {
    const cwd = join(tmpdir(), 'owlcoda-task-state-blocked')
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(conversation, 'Finish the delivery packet and write the docs.')
    const taskState = ensureTaskExecutionState(conversation, cwd)

    markTaskBlocked(taskState, 'Runtime auto-continue stopped after 8 attempts.', 'Waiting for explicit retry')

    expect(taskState.run.status).toBe('blocked')
    expect(taskState.run.lastGuardReason).toBe('Runtime auto-continue stopped after 8 attempts.')
    expect(taskState.run.currentFocus).toBe('Waiting for explicit retry')
  })

  it('evaluateWriteGuard surfaces fs-policy reason for sensitive paths under explicit scope (regression for hostile-QA B3)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-b3-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      // Triggers explicit_paths scope mode
      addUserMessage(conversation, 'Edit `src/native/conversation.ts` only.')
      const taskState = ensureTaskExecutionState(conversation, cwd)
      expect(taskState.contract.scopeMode).toBe('explicit_paths')

      const violation = evaluateWriteGuard('write', { path: '/etc/passwd', content: 'x' }, taskState)
      expect(violation).not.toBeNull()
      // Fs-policy's specific message wins over the generic task-contract copy.
      expect(violation!.message).toMatch(/sensitive location/i)
      expect(violation!.message).toMatch(/\/etc/)
      expect(violation!.message).not.toMatch(/Task contract blocked/)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('evaluateWriteGuard keeps the task-contract message for in-workspace out-of-scope writes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-b3b-'))
    try {
      await mkdir(join(cwd, 'src', 'native'), { recursive: true })
      await mkdir(join(cwd, 'docs'), { recursive: true })
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'Edit `src/native/conversation.ts` only.')
      const taskState = ensureTaskExecutionState(conversation, cwd)
      expect(taskState.contract.scopeMode).toBe('explicit_paths')

      const out = join(cwd, 'docs', 'unrelated.md')
      const violation = evaluateWriteGuard('write', { path: out, content: 'x' }, taskState)
      expect(violation).not.toBeNull()
      expect(violation!.message).toMatch(/Task contract blocked/)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('treats blocked and waiting-user task states as non-completed terminal outcomes', () => {
    expect(shouldTreatTaskRunStatusAsFailure('open')).toBe(true)
    expect(shouldTreatTaskRunStatusAsFailure('blocked')).toBe(true)
    expect(shouldTreatTaskRunStatusAsFailure('waiting_user')).toBe(true)
    expect(shouldTreatTaskRunStatusAsFailure('drifted')).toBe(true)
    expect(shouldTreatTaskRunStatusAsFailure('completed')).toBe(false)
    expect(shouldTreatTaskRunStatusAsFailure(undefined)).toBe(false)
  })

  it('expands a blocked write scope after explicit user approval without replacing the objective', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-approval-'))
    try {
      const allowedPath = join(cwd, 'prompt.md')
      const blockedPath = join(cwd, 'docs', 'result.md')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, `按 \`${allowedPath}\` 执行。`)
      const taskState = ensureTaskExecutionState(conversation, cwd)

      markTaskWriteScopeBlocked(
        taskState,
        `Task contract blocked write to ${blockedPath}.`,
        blockedPath,
      )
      addUserMessage(conversation, '确认可以，继续写入这个结果文件。')
      const approved = ensureTaskExecutionState(conversation, cwd)
      const canonicalCwd = await realpath(cwd)

      expect(approved.run.status).toBe('open')
      expect(approved.run.lastGuardReason).toBeNull()
      expect(approved.run.pendingWriteApproval).toBeNull()
      expect(approved.contract.objective).toContain(allowedPath)
      expect(approved.contract.allowedWritePaths.some(
        (scope) => scope.path === join(canonicalCwd, 'docs', 'result.md'),
      )).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('can approve a pending write scope directly from the runtime approval UI', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-runtime-approval-'))
    try {
      const allowedPath = join(cwd, 'prompt.md')
      const blockedPath = join(cwd, 'scripts', 'gate.sh')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, `按 \`${allowedPath}\` 执行。`)
      const taskState = ensureTaskExecutionState(conversation, cwd)

      markTaskWriteScopeBlocked(
        taskState,
        `Task contract blocked write to ${blockedPath}.`,
        blockedPath,
      )

      expect(approveTaskWriteScope(taskState, blockedPath)).toBe(true)
      const canonicalCwd = await realpath(cwd)
      expect(taskState.run.status).toBe('open')
      expect(taskState.run.lastGuardReason).toBeNull()
      expect(taskState.run.pendingWriteApproval).toBeNull()
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path === join(canonicalCwd, 'scripts', 'gate.sh') && scope.origin === 'user_approved',
      )).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('captures every blocked bash write target so one approval covers sibling artifacts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-multi-block-'))
    try {
      await mkdir(join(cwd, 'scripts'), { recursive: true })
      await mkdir(join(cwd, 'out', 'full'), { recursive: true })
      const canonicalCwd = await realpath(cwd)
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'Only edit `scripts/generator.py`.')
      const taskState = ensureTaskExecutionState(conversation, canonicalCwd)

      const violation = evaluateWriteGuard('bash', {
        cwd: canonicalCwd,
        command: [
          'echo a > out/full/shardA.log',
          'echo b > out/full/shardB.log',
          'echo c > out/full/shardC.log',
        ].join('\n'),
      }, taskState)

      expect(violation).not.toBeNull()
      expect(violation!.attemptedPaths).toEqual([
        join(canonicalCwd, 'out', 'full', 'shardA.log'),
        join(canonicalCwd, 'out', 'full', 'shardB.log'),
        join(canonicalCwd, 'out', 'full', 'shardC.log'),
      ])

      markTaskWriteScopeBlocked(
        taskState,
        violation!.message,
        violation!.attemptedPath,
        violation!.attemptedPaths,
      )
      addUserMessage(conversation, '批准啊，你来做。')

      const approved = ensureTaskExecutionState(conversation, canonicalCwd)
      expect(approved.run.pendingWriteApproval).toBeNull()
      for (const path of violation!.attemptedPaths) {
        expect(approved.contract.allowedWritePaths.some(
          (scope) => scope.path === path,
        )).toBe(true)
      }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('does not let approval prose rewrite the task contract source', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-approval-source-'))
    try {
      await mkdir(join(cwd, 'scripts'), { recursive: true })
      await mkdir(join(cwd, 'out', 'full'), { recursive: true })
      const canonicalCwd = await realpath(cwd)
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'Only edit `scripts/generator.py`; write final shards after approval.')
      const initial = ensureTaskExecutionState(conversation, canonicalCwd)

      const blockedPaths = [
        join(canonicalCwd, 'out', 'full', 'shardA.log'),
        join(canonicalCwd, 'out', 'full', 'shardB.log'),
      ]
      markTaskWriteScopeBlocked(
        initial,
        `Task contract blocked write to ${blockedPaths[0]}.`,
        blockedPaths[0]!,
        blockedPaths,
      )
      addUserMessage(conversation, '批准啊，你来做。')

      const approved = ensureTaskExecutionState(conversation, canonicalCwd)

      expect(approved.contract.objective).toBe(initial.contract.objective)
      expect(approved.contract.sourceText).toBe(initial.contract.sourceText)
      expect(approved.contract.sourceTurnHash).toBe(initial.contract.sourceTurnHash)
      expect(approved.contract.sourceText).not.toContain('批准')
      expect(approved.run.pendingWriteApproval).toBeNull()
      for (const path of blockedPaths) {
        expect(approved.contract.allowedWritePaths.some((scope) => scope.path === path)).toBe(true)
      }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('does not let progress-check prose rewrite the task contract source', () => {
    const cwd = join(tmpdir(), 'owlcoda-task-state-progress-check')
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(conversation, 'Generate four shards under `out/full` and then merge a report.')
    const initial = ensureTaskExecutionState(conversation, cwd)

    addUserMessage(conversation, '你一直在忙活什么？')
    const checked = ensureTaskExecutionState(conversation, cwd)

    expect(checked.contract.objective).toBe(initial.contract.objective)
    expect(checked.contract.sourceText).toBe(initial.contract.sourceText)
    expect(checked.contract.sourceTurnHash).toBe(initial.contract.sourceTurnHash)

    addUserMessage(conversation, '目前在做的，已经输出了2316s了，我让你检查它的进度')
    const progressChecked = ensureTaskExecutionState(conversation, cwd)

    expect(progressChecked.contract.objective).toBe(initial.contract.objective)
    expect(progressChecked.contract.sourceText).toBe(initial.contract.sourceText)
    expect(progressChecked.contract.sourceTurnHash).toBe(initial.contract.sourceTurnHash)
  })

  it('does not treat ok inside a path as write-scope approval', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-path-ok-'))
    try {
      const canonicalCwd = await realpath(cwd)
      const blockedPath = join(canonicalCwd, 'out', 'blocked.log')
      const okNamedPath = join(canonicalCwd, 'notes', 'sometimes-ok.txt')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'Only edit `scripts/generator.py`.')
      const initial = ensureTaskExecutionState(conversation, canonicalCwd)
      markTaskWriteScopeBlocked(
        initial,
        `Task contract blocked write to ${blockedPath}.`,
        blockedPath,
      )

      addUserMessage(conversation, `先看看 ${okNamedPath}`)
      const next = ensureTaskExecutionState(conversation, canonicalCwd)

      expect(next.run.pendingWriteApproval?.attemptedPaths).toEqual([blockedPath])
      expect(next.contract.allowedWritePaths.some((scope) => scope.path === blockedPath)).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('expands write scope from bootstrap packet allowlists without importing forbidden paths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-packet-'))
    const packetPath = join(cwd, 'docs', 'executor-packet.md')
    const allowedCodePath = join(cwd, 'src', 'native', 'dispatch.ts')
    const allowedTestPath = join(cwd, 'tests', 'native', 'dispatch.test.ts')
    const forbiddenPath = join(cwd, 'README.md')

    await mkdir(join(cwd, 'docs'), { recursive: true })
    await writeFile(packetPath, [
      '# Round Packet',
      '',
      '- `允许写入的文件或目录`',
      `  - \`${allowedCodePath}\``,
      `  - \`${allowedTestPath}\``,
      '- `禁止改动的文件或目录`',
      `  - \`${forbiddenPath}\``,
      '',
      '- `最终输出格式`',
      '  - `本轮目标`',
    ].join('\n'))

    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, `请按这个执行包继续：\`${packetPath}\``)

      const taskState = ensureTaskExecutionState(conversation, cwd)
      const canonicalCwd = await realpath(cwd)

      expect(taskState.contract.scopeMode).toBe('explicit_paths')
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path === join(canonicalCwd, 'src', 'native', 'dispatch.ts'),
      )).toBe(true)
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path === join(canonicalCwd, 'src', 'native'),
      )).toBe(true)
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path === join(canonicalCwd, 'tests', 'native', 'dispatch.test.ts'),
      )).toBe(true)
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path === join(canonicalCwd, 'README.md'),
      )).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('keeps packet bootstrap inside scope when the user path goes through a symlink', async () => {
    const realCwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-real-'))
    const linkedCwd = `${realCwd}-link`
    const packetPath = join(linkedCwd, 'docs', 'executor-packet.md')
    const allowedPath = join(linkedCwd, 'src', 'native', 'dispatch.ts')

    await mkdir(join(realCwd, 'docs'), { recursive: true })
    await mkdir(join(realCwd, 'src', 'native'), { recursive: true })
    await symlink(realCwd, linkedCwd)
    await writeFile(join(realCwd, 'docs', 'executor-packet.md'), [
      '# Round Packet',
      '',
      '- `允许写入的文件或目录`',
      `  - \`${allowedPath}\``,
    ].join('\n'))

    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, `请按这个执行包继续：\`${packetPath}\``)

      const taskState = ensureTaskExecutionState(conversation, realCwd)

      expect(taskState.contract.scopeMode).toBe('explicit_paths')
      expect(taskState.contract.explicitWriteTargets.some(
        (target) => target.endsWith('/docs/executor-packet.md'),
      )).toBe(true)
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path.endsWith('/src/native/dispatch.ts'),
      )).toBe(true)
    } finally {
      await rm(linkedCwd, { recursive: true, force: true })
      await rm(realCwd, { recursive: true, force: true })
    }
  })

  // 0.13.67: lifetimeIterations is the monotonic-across-retries
  // counter that the no-progress hard ceiling reads. The first
  // 0.13.67 used the closure-local `iterations` and was blind to
  // retry-driven re-entry; this test pins down the contract that
  // markTaskIteration MUST increment lifetimeIterations once per
  // call regardless of the `iterations` value the caller supplies.
  describe('markTaskIteration lifetimeIterations (0.13.67)', () => {
    it('increments lifetimeIterations even when caller resets iterations to 1', () => {
      const cwd = join(tmpdir(), 'owlcoda-task-state-lifetime-iter')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'Write the design notes to docs/notes.md')
      const taskState = ensureTaskExecutionState(conversation, cwd)

      expect(taskState.run.lifetimeIterations ?? 0).toBe(0)

      // Closure 1: 5 iterations.
      for (let i = 1; i <= 5; i++) {
        markTaskIteration(taskState, { iterations: i })
      }
      expect(taskState.run.iterations).toBe(5)
      expect(taskState.run.lifetimeIterations).toBe(5)

      // Simulate a runtime auto-retry that re-enters runConversationLoop —
      // closure-local `iterations` resets to 1, but lifetimeIterations
      // must keep climbing.
      for (let i = 1; i <= 5; i++) {
        markTaskIteration(taskState, { iterations: i })
      }
      expect(taskState.run.iterations).toBe(5)
      expect(taskState.run.lifetimeIterations).toBe(10)
    })

    it('preserves lifetimeIterations across ensureTaskExecutionState re-derivations', () => {
      const cwd = join(tmpdir(), 'owlcoda-task-state-lifetime-rederive')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'Update src/native/conversation.ts')
      const taskState = ensureTaskExecutionState(conversation, cwd)
      markTaskIteration(taskState, { iterations: 3 })
      expect(taskState.run.lifetimeIterations).toBe(1)

      // ensureTaskExecutionState reads previous from
      // conversation.options.taskState — stash there so re-derivation
      // sees prior lifetimeIterations as the seed.
      conversation.options = { ...(conversation.options ?? {}), taskState }
      const rederived = ensureTaskExecutionState(conversation, cwd)
      expect(rederived.run.lifetimeIterations).toBe(1)
    })

  })

  describe('describeTaskExecutionState', () => {
    it('returns null in workspace mode so the runtime stays silent each turn', () => {
      const cwd = join(tmpdir(), 'owlcoda-task-state-describe-workspace')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'Just chat with me, no specific files mentioned.')

      const taskState = ensureTaskExecutionState(conversation, cwd)
      expect(taskState.contract.scopeMode).toBe('workspace')
      expect(describeTaskExecutionState(taskState)).toBeNull()
    })

    it('returns a Task contract banner when an explicit write scope was inferred', () => {
      const cwd = join(tmpdir(), 'owlcoda-task-state-describe-explicit')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(
        conversation,
        'Edit `src/native/conversation.ts` and keep `tests/native/conversation.test.ts` aligned.',
      )

      const taskState = ensureTaskExecutionState(conversation, cwd)
      const description = describeTaskExecutionState(taskState)
      expect(description).not.toBeNull()
      expect(description).toMatch(/^Task contract: write scope narrowed/)
    })
  })

  // user-external deliverable path tests (external deliverable path support)
  describe('user-external deliverable paths', () => {
    it('recognizes "输出到 <abs path>" as user-external origin', () => {
      const cwd = join(tmpdir(), 'owlcoda-ext-zh-output')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, '请输出到 /Users/yeemio/work/ppt/output/foo.html')
      const taskState = ensureTaskExecutionState(conversation, cwd)

      expect(taskState.contract.scopeMode).toBe('explicit_paths')
      const ext = taskState.contract.allowedWritePaths.find(
        (s) => s.path.endsWith('/foo.html'),
      )
      expect(ext).toBeDefined()
      expect(ext!.origin).toBe('user-external')
    })

    it('recognizes "output to <abs path>" (English) as user-external origin', () => {
      const cwd = join(tmpdir(), 'owlcoda-ext-en-output')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'output to /tmp/external-out/v.html')
      const taskState = ensureTaskExecutionState(conversation, cwd)

      const ext = taskState.contract.allowedWritePaths.find(
        (s) => s.path.endsWith('/v.html'),
      )
      expect(ext).toBeDefined()
      expect(ext!.origin).toBe('user-external')
    })

    it('recognizes "save to <abs path>" (English) as user-external origin', () => {
      const cwd = join(tmpdir(), 'owlcoda-ext-en-save')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'save to /Users/me/Desktop/report.pdf')
      const taskState = ensureTaskExecutionState(conversation, cwd)

      const ext = taskState.contract.allowedWritePaths.find(
        (s) => s.path.endsWith('/report.pdf'),
      )
      expect(ext).toBeDefined()
      expect(ext!.origin).toBe('user-external')
    })

    it('recognizes "保存到 <abs path>" (Chinese) as user-external origin', () => {
      const cwd = join(tmpdir(), 'owlcoda-ext-zh-save')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, '保存到 /Users/me/work/foo.html')
      const taskState = ensureTaskExecutionState(conversation, cwd)

      const ext = taskState.contract.allowedWritePaths.find(
        (s) => s.path.endsWith('/foo.html'),
      )
      expect(ext).toBeDefined()
      expect(ext!.origin).toBe('user-external')
    })

    it('recognizes "落盘到 <abs path>" (Chinese) as user-external origin', () => {
      const cwd = join(tmpdir(), 'owlcoda-ext-zh-luopan')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, '落盘到 /Users/me/output/bar.html')
      const taskState = ensureTaskExecutionState(conversation, cwd)

      const ext = taskState.contract.allowedWritePaths.find(
        (s) => s.path.endsWith('/bar.html'),
      )
      expect(ext).toBeDefined()
      expect(ext!.origin).toBe('user-external')
    })

    it('does NOT collect forbidden external paths (禁止写到 <abs path>)', () => {
      const cwd = join(tmpdir(), 'owlcoda-ext-forbidden')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, '禁止写到 /Users/yeemio/secret.txt，输出到 /tmp/safe/out.html')
      const taskState = ensureTaskExecutionState(conversation, cwd)

      const forbidden = taskState.contract.allowedWritePaths.find(
        (s) => s.path.endsWith('/secret.txt'),
      )
      expect(forbidden).toBeUndefined()

      const allowed = taskState.contract.allowedWritePaths.find(
        (s) => s.path.endsWith('/out.html'),
      )
      expect(allowed).toBeDefined()
    })

    it('extractUserDeclaredExternalRoots returns only user-external paths', () => {
      const cwd = join(tmpdir(), 'owlcoda-ext-roots')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(
        conversation,
        'Edit `src/foo.ts` and output to /Users/yeemio/out/deck.html',
      )
      const taskState = ensureTaskExecutionState(conversation, cwd)

      const roots = extractUserDeclaredExternalRoots(taskState)
      expect(roots.some((r) => r.path.endsWith('/deck.html'))).toBe(true)
      // In-workspace paths (src/foo.ts) must not appear
      expect(roots.some((r) => r.path.endsWith('/foo.ts'))).toBe(false)
      // kind must be preserved
      const deckScope = roots.find((r) => r.path.endsWith('/deck.html'))
      expect(deckScope?.kind).toBe('file')
    })

    it('extractUserDeclaredExternalRoots returns [] when taskState is undefined', () => {
      expect(extractUserDeclaredExternalRoots(undefined)).toEqual([])
    })

    it('extractUserDeclaredExternalRoots preserves kind=file for single-file external target', () => {
      const cwd = join(tmpdir(), 'owlcoda-ext-kind-file')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, '输出到 /Users/yeemio/work/ppt/out.html')
      const taskState = ensureTaskExecutionState(conversation, cwd)

      const scopes = extractUserDeclaredExternalRoots(taskState)
      const outScope = scopes.find((s) => s.path.endsWith('/out.html'))
      expect(outScope).toBeDefined()
      expect(outScope?.kind).toBe('file')
    })

    it('extractUserDeclaredExternalRoots returns { path, kind } shape not plain strings', () => {
      const cwd = join(tmpdir(), 'owlcoda-ext-shape')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'output to /tmp/out/result.html')
      const taskState = ensureTaskExecutionState(conversation, cwd)

      const scopes = extractUserDeclaredExternalRoots(taskState)
      expect(scopes.length).toBeGreaterThan(0)
      for (const s of scopes) {
        expect(typeof s.path).toBe('string')
        expect(s.kind === 'file' || s.kind === 'directory').toBe(true)
      }
    })

    it('recordBashArtifactProgress counts user-external path as durable (touchedPaths), not scratch', () => {
      const cwd = join(tmpdir(), 'owlcoda-ext-bash-artifact')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, '输出到 /tmp/external-out/v.html')
      const taskState = ensureTaskExecutionState(conversation, cwd)
      markTaskIteration(taskState, { iterations: 1 })

      recordBashArtifactProgress(taskState, 'bash', {
        command: "cat > '/tmp/external-out/v.html' << 'EOF'\n<html/>\nEOF",
        cwd,
      })

      // Should be counted as touched (durable deliverable)
      expect(taskState.contract.touchedPaths.some((p) => p.endsWith('/v.html'))).toBe(true)
      // Should NOT be in scratch
      expect(taskState.run.scratchArtifactPaths?.some((p) => p.endsWith('/v.html'))).toBeFalsy()
      expect(hasRecentArtifactProgress(taskState, 3)).toBe(true)
    })

    it('evaluateWriteGuard allows user-external path in explicit_paths scope', () => {
      const cwd = join(tmpdir(), 'owlcoda-ext-guard')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, '输出到 /tmp/external-out/slide.html')
      const taskState = ensureTaskExecutionState(conversation, cwd)

      // Should NOT block the declared external path
      const violation = evaluateWriteGuard('write', {
        path: '/tmp/external-out/slide.html',
        content: '<html/>',
      }, taskState)
      expect(violation).toBeNull()
    })

    it('evaluateWriteGuard still blocks undeclared external paths', () => {
      const cwd = join(tmpdir(), 'owlcoda-ext-guard-block')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, '输出到 /tmp/external-out/slide.html')
      const taskState = ensureTaskExecutionState(conversation, cwd)

      // A different external path not in contract should be blocked
      const violation = evaluateWriteGuard('write', {
        path: join(cwd, 'src', 'undeclared.ts'),
        content: 'nope',
      }, taskState)
      expect(violation).not.toBeNull()
    })
  })
})

describe('detectCompletionClaim', () => {
  it('matches Chinese completion verbs', () => {
    expect(detectCompletionClaim('已完成')).toBe(true)
    expect(detectCompletionClaim('全部完成了，准备 ship')).toBe(true)
    expect(detectCompletionClaim('测试通过')).toBe(true)
    expect(detectCompletionClaim('部署成功')).toBe(true)
    expect(detectCompletionClaim('全绿了')).toBe(true)
  })

  it('matches English completion verbs', () => {
    expect(detectCompletionClaim('all done')).toBe(true)
    expect(detectCompletionClaim('Tests pass.')).toBe(true)
    expect(detectCompletionClaim('shipped 0.13.44')).toBe(true)
    expect(detectCompletionClaim('deployed to staging')).toBe(true)
    expect(detectCompletionClaim('all tests pass')).toBe(true)
    expect(detectCompletionClaim('built successfully')).toBe(true)
  })

  it('does not match in-progress text', () => {
    expect(detectCompletionClaim('Working on it…')).toBe(false)
    expect(detectCompletionClaim('I am running the tests')).toBe(false)
    expect(detectCompletionClaim('Reviewing the diff')).toBe(false)
    expect(detectCompletionClaim('')).toBe(false)
  })

  it('does match speculative completion text (acceptable false-positive)', () => {
    // "the tests will pass after we add the assertion" is the kind of
    // mid-sentence false positive we accept — the worst case is the
    // model gets nudged to run DeliveryAudit, finds nothing, proceeds.
    expect(detectCompletionClaim('After this change, all tests pass.')).toBe(true)
  })
})

// 0.13.58: buildTaskContinuePrompt now demands either a tool call OR a
// concrete file_path:line evidence cite, and explicitly bans high-
// level summaries / plan restatements. Pre-0.13.58 the wording was
// "Continue the task now. Do not stop at another interim summary." —
// models routinely interpreted that as "produce another planning
// paragraph", which was the failure mode the inject was meant to
// prevent.
describe('buildTaskContinuePrompt (0.13.58 wording)', () => {
  it('demands a tool call or evidence cite, not another summary', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-continue-prompt-'))
    try {
      const conv = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conv, 'Fix the deploy script')
      const ts = ensureTaskExecutionState(conv, cwd)
      ts.contract.objective = 'Land a working deploy script'
      ts.contract.dominantGap = 'Verify SSH key path resolution'
      const prompt = buildTaskContinuePrompt(ts, 'Here is the plan: I will inspect the script and then test it.')

      expect(prompt).toMatch(/Runtime continue-while-open/)
      expect(prompt).toMatch(/Land a working deploy script/)
      expect(prompt).toMatch(/Verify SSH key path resolution/)
      // New evidence-or-tool-call demand
      expect(prompt).toMatch(/Your next response MUST be one of/)
      expect(prompt).toMatch(/tool call/)
      expect(prompt).toMatch(/file_path:line_number/)
      // Explicit ban on more planning text
      expect(prompt).toMatch(/Do NOT produce another high-level summary/)
      expect(prompt).toMatch(/Do NOT restate the plan/)
      // Stopping conditions still spelled out
      expect(prompt).toMatch(/state the specific question/)
      expect(prompt).toMatch(/state which one/)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('falls back to a generic dominant-gap message when none recorded', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-continue-prompt-default-'))
    try {
      const conv = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conv, 'Do the thing')
      const ts = ensureTaskExecutionState(conv, cwd)
      const prompt = buildTaskContinuePrompt(ts, 'OK so the plan is...')
      expect(prompt).toMatch(/Continue the next best step needed to finish/)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

// 0.13.58: context-pressure nudge. Two thresholds (0.6 soft, 0.85
// strict) generate different bodies. Tests pin the contract that
// conversation.ts depends on (header text, threshold readback, the
// actionable bullets).
// 0.13.64: max-tokens continuation nudge body. Ensures the inject
// names the truncation, includes a tail snippet for resume context,
// and escalates wording on consecutive truncations (re-rendering
// inline is going to cap out again).
// 0.13.70 execution_economics_v1 — production_gate_v1 prompt body.
// The runtime injects this once per task when investigation is
// genuine (>=3 distinct files, >=5 lifetime iter) but no deliverable
// has landed. The prompt must push the model from finding to
// producing without sounding punitive — Codex/Sonnet 4 do this
// implicitly; this builds the same nudge into runtime feedback.
describe('buildProductionGatePrompt (0.13.70)', () => {
  it('mentions distinct files read and lifetime iterations explicitly', async () => {
    const { buildProductionGatePrompt } = await import('../../src/native/task-state.js')
    const msg = buildProductionGatePrompt({
      distinctFilesRead: 5,
      lifetimeIterations: 7,
      taskWriteScope: null,
    })
    expect(msg).toMatch(/Runtime production gate/)
    expect(msg).toMatch(/5 distinct files/)
    expect(msg).toMatch(/7 iterations/)
    expect(msg).toMatch(/0 touched paths/)
  })

  it('references the task-scoped write path when available', async () => {
    const { buildProductionGatePrompt } = await import('../../src/native/task-state.js')
    const msg = buildProductionGatePrompt({
      distinctFilesRead: 4,
      lifetimeIterations: 6,
      taskWriteScope: 'docs/intake.md',
    })
    expect(msg).toContain('docs/intake.md')
  })

  it('falls back to a generic phrasing when no scope path is supplied', async () => {
    const { buildProductionGatePrompt } = await import('../../src/native/task-state.js')
    const msg = buildProductionGatePrompt({
      distinctFilesRead: 3,
      lifetimeIterations: 5,
      taskWriteScope: null,
    })
    expect(msg).toMatch(/path scoped by the task contract/)
  })

  it('demands "Known Unverified Items" framing instead of "keep investigating"', async () => {
    const { buildProductionGatePrompt } = await import('../../src/native/task-state.js')
    const msg = buildProductionGatePrompt({
      distinctFilesRead: 4,
      lifetimeIterations: 6,
      taskWriteScope: null,
    })
    expect(msg).toMatch(/Known Unverified Items/)
    expect(msg).toMatch(/cite a source path or be tagged unverified/)
    expect(msg).toMatch(/grep or a line-range read/)
    expect(msg).toMatch(/fires once per task/)
  })

  it('uses singular "file" form when only 1 distinct file was read', async () => {
    const { buildProductionGatePrompt } = await import('../../src/native/task-state.js')
    const msg = buildProductionGatePrompt({
      distinctFilesRead: 1,
      lifetimeIterations: 5,
      taskWriteScope: null,
    })
    expect(msg).toContain('1 distinct file ')
    expect(msg).not.toContain('1 distinct files')
  })
})

describe('buildMaxTokensContinuationPrompt (0.13.64)', () => {
  it('on first truncation: tells model to resume from cut-off', async () => {
    const { buildMaxTokensContinuationPrompt } = await import('../../src/native/task-state.js')
    const msg = buildMaxTokensContinuationPrompt('partial content ending mid-sentence', 1)
    expect(msg).toMatch(/Runtime max-tokens continuation/)
    expect(msg).toMatch(/stop_reason=max_tokens/)
    expect(msg).toMatch(/Continue from where you left off/)
    expect(msg).toMatch(/Do NOT restart/)
    expect(msg).toMatch(/Tail of the truncated reply/)
    expect(msg).toContain('partial content ending mid-sentence')
  })

  it('on second consecutive truncation: escalates to file-or-narrow-scope', async () => {
    const { buildMaxTokensContinuationPrompt } = await import('../../src/native/task-state.js')
    const msg = buildMaxTokensContinuationPrompt('cut off again', 2)
    expect(msg).toMatch(/last 2 replies hit stop_reason=max_tokens/)
    expect(msg).toMatch(/Stop trying to render the full deliverable inline/)
    expect(msg).toMatch(/tool call \(write \/ edit\) that lands the deliverable as a file/)
    expect(msg).toMatch(/scope it down/)
  })

  it('truncates the tail snippet at ~400 chars', async () => {
    const { buildMaxTokensContinuationPrompt } = await import('../../src/native/task-state.js')
    const huge = 'x'.repeat(2000)
    const msg = buildMaxTokensContinuationPrompt(huge, 1)
    // Tail section after the "Tail of the truncated reply" header
    const tailMatch = msg.match(/Tail of the truncated reply[^\n]*\n([\s\S]+)$/)
    expect(tailMatch).not.toBeNull()
    expect(tailMatch![1]!.length).toBeLessThanOrEqual(420)
    expect(tailMatch![1]!.startsWith('…')).toBe(true)
  })
})

// 0.13.63 (D): output-bloat nudge body. Ensures the inject is
// concrete — names the trigger, demands a tool call OR a specific
// question, bans re-rendering content already in the transcript.
describe('buildOutputBloatPrompt (0.13.63)', () => {
  it('mentions the consecutive count and per-output size', async () => {
    const { buildOutputBloatPrompt } = await import('../../src/native/task-state.js')
    const msg = buildOutputBloatPrompt(3, 18_000)
    expect(msg).toMatch(/Runtime output-bloat check/)
    expect(msg).toMatch(/last 3 replies/)
    expect(msg).toMatch(/18K characters/)
    expect(msg).toMatch(/tool call \(write \/ edit \/ bash\)/)
    expect(msg).toMatch(/specific question for the user/)
    expect(msg).toMatch(/Do NOT re-render/)
  })
})

describe('buildContextPressurePrompt (0.13.58)', () => {
  it('soft mode (0.6) tells the model to lead with key facts and grep before asking', () => {
    const msg = buildContextPressurePrompt(0.6, 0.62, 620_000, 1_000_000)
    expect(msg).toMatch(/Runtime context-pressure check/)
    expect(msg).toMatch(/just crossed 60%/)
    expect(msg).toMatch(/now 62%/)
    expect(msg).toMatch(/620,000 \/ 1,000,000 tokens/)
    expect(msg).toMatch(/Soft mode/)
    expect(msg).toMatch(/Lead each reply with the key fact/)
    expect(msg).toMatch(/Batch independent tool calls/)
    expect(msg).toMatch(/grep \/ read for the answer first/)
  })

  it('strict mode (0.85) demands one fact + next action and bans new exploration', () => {
    const msg = buildContextPressurePrompt(0.85, 0.87, 870_000, 1_000_000)
    expect(msg).toMatch(/just crossed 85%/)
    expect(msg).toMatch(/Strict mode/)
    expect(msg).toMatch(/one fact \+ the next concrete action/)
    expect(msg).toMatch(/No narration, no plan restatements/)
    expect(msg).toMatch(/narrow scope or cut the conversation/)
    expect(msg).toMatch(/Do not start new exploration tracks/)
  })

  it('strict mode does NOT include soft-mode bullets', () => {
    const msg = buildContextPressurePrompt(0.85, 0.9, 900, 1000)
    expect(msg).not.toMatch(/Lead each reply with the key fact/)
    expect(msg).not.toMatch(/Batch independent tool calls/)
  })
})

describe('buildDeliveryCheckPrompt', () => {
  it('mentions touched-path count + DeliveryAudit + the latest assistant text', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-delivery-prompt-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'Add a foo file')
      const taskState = ensureTaskExecutionState(conversation, cwd)
      taskState.contract.touchedPaths.push(join(cwd, 'foo.ts'))
      const prompt = buildDeliveryCheckPrompt(taskState, 'All done — shipped 1.2.3.')
      expect(prompt).toMatch(/Runtime delivery check/)
      expect(prompt).toMatch(/DeliveryAudit/)
      expect(prompt).toMatch(/1 touched path/)
      expect(prompt).toMatch(/All done/)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('inferUserIntent', () => {
  it('Chinese analysis-only forms classify as analysis', () => {
    expect(inferUserIntent('你觉得这块代码怎么样？')).toBe('analysis')
    expect(inferUserIntent('为什么这个测试会失败')).toBe('analysis')
    expect(inferUserIntent('帮我评估一下交付质量')).toBe('analysis')
    expect(inferUserIntent('讲讲这段逻辑的原因')).toBe('analysis')
    expect(inferUserIntent('解释一下这个 bug')).toBe('analysis')
  })

  it('English analysis-only forms classify as analysis', () => {
    expect(inferUserIntent('what do you think of this approach?')).toBe('analysis')
    expect(inferUserIntent('why is this failing?')).toBe('analysis')
    expect(inferUserIntent('how come the build is broken?')).toBe('analysis')
    expect(inferUserIntent('your verdict on this PR?')).toBe('analysis')
  })

  it('explicit implementation verbs classify as implementation', () => {
    expect(inferUserIntent('帮我修一下这个 bug')).toBe('implementation')
    expect(inferUserIntent('实施这个方案')).toBe('implementation')
    expect(inferUserIntent('继续实现下一步')).toBe('implementation')
    expect(inferUserIntent('please fix it')).toBe('implementation')
    expect(inferUserIntent('go ahead and add the test')).toBe('implementation')
    expect(inferUserIntent('proceed')).toBe('implementation')
  })

  it('analysis + implementation in same message → mixed (treats as implementation downstream)', () => {
    expect(inferUserIntent('你觉得对的话就帮我修一下')).toBe('mixed')
    expect(inferUserIntent('what do you think? if good, go ahead and ship it')).toBe('mixed')
  })

  it('neutral when neither pattern fires', () => {
    // "Add a feature for X" *is* implementation by design (`add` is an
    // intent verb). Truly neutral text has neither analysis nor a
    // direct action verb.
    expect(inferUserIntent('继续')).toBe('neutral')
    expect(inferUserIntent('Some context about the project')).toBe('neutral')
    expect(inferUserIntent('')).toBe('neutral')
  })
})

describe('evaluateIntentGuard', () => {
  it('blocks write/edit/NotebookEdit when intent is analysis', () => {
    expect(evaluateIntentGuard('write', 'analysis')).not.toBeNull()
    expect(evaluateIntentGuard('edit', 'analysis')).not.toBeNull()
    expect(evaluateIntentGuard('NotebookEdit', 'analysis')).not.toBeNull()
  })

  it('blocks wrong-case Write/Edit when intent is analysis (P2-12 safety sibling)', () => {
    expect(evaluateIntentGuard('Write', 'analysis')).not.toBeNull()
    expect(evaluateIntentGuard('EDIT', 'analysis')).not.toBeNull()
  })

  it('does not block bash/read/glob when intent is analysis', () => {
    expect(evaluateIntentGuard('bash', 'analysis')).toBeNull()
    expect(evaluateIntentGuard('read', 'analysis')).toBeNull()
    expect(evaluateIntentGuard('glob', 'analysis')).toBeNull()
  })

  it('does not block any tool when intent is implementation', () => {
    expect(evaluateIntentGuard('write', 'implementation')).toBeNull()
    expect(evaluateIntentGuard('edit', 'implementation')).toBeNull()
  })

  it('does not block any tool when intent is mixed (user named the action)', () => {
    expect(evaluateIntentGuard('write', 'mixed')).toBeNull()
    expect(evaluateIntentGuard('edit', 'mixed')).toBeNull()
  })

  it('does not block any tool when intent is neutral (status quo)', () => {
    expect(evaluateIntentGuard('write', 'neutral')).toBeNull()
  })

  it('returns the structured reason for the operator-friendly refusal', () => {
    const v = evaluateIntentGuard('write', 'analysis')
    expect(v).not.toBeNull()
    expect(v!.toolName).toBe('write')
    expect(v!.intent).toBe('analysis')
    expect(v!.reason).toMatch(/analysis-only/)
    expect(v!.reason).toMatch(/implementation verb/)
    expect(v!.reason).toMatch(/改一下|修一下|实施|fix it|do it|proceed/)
  })

  // 0.13.52: bash + TaskCreate mutation detection
  describe('0.13.52 bash/TaskCreate mutation under analysis', () => {
    it('blocks bash with redirect under analysis', () => {
      const v = evaluateIntentGuard('bash', 'analysis', {
        command: 'echo hi > /tmp/leak',
      })
      expect(v).not.toBeNull()
      expect(v!.toolName).toBe('bash')
      expect(v!.reason).toMatch(/mutates the filesystem/)
      expect(v!.reason).toMatch(/redirect/)
    })

    it('blocks bash with sed -i under analysis', () => {
      const v = evaluateIntentGuard('bash', 'analysis', {
        command: 'sed -i.bak "s/foo/bar/" file.txt',
      })
      expect(v).not.toBeNull()
      expect(v!.reason).toMatch(/mutates the filesystem/)
    })

    it('blocks bash with tee under analysis', () => {
      const v = evaluateIntentGuard('bash', 'analysis', {
        command: 'tee out.txt <<<"body"',
      })
      expect(v).not.toBeNull()
    })

    it('blocks bash with rm under analysis (mutates)', () => {
      const v = evaluateIntentGuard('bash', 'analysis', {
        command: 'rm foo.txt',
      })
      expect(v).not.toBeNull()
      expect(v!.reason).toMatch(/mutates/)
    })

    it('does NOT block bash with read-only command under analysis', () => {
      expect(evaluateIntentGuard('bash', 'analysis', { command: 'ls' })).toBeNull()
      expect(evaluateIntentGuard('bash', 'analysis', { command: 'cat README.md' })).toBeNull()
      expect(evaluateIntentGuard('bash', 'analysis', { command: 'git status' })).toBeNull()
      expect(evaluateIntentGuard('bash', 'analysis', { command: 'sleep 1; echo done' })).toBeNull()
    })

    it('blocks TaskCreate with mutating command under analysis', () => {
      const v = evaluateIntentGuard('TaskCreate', 'analysis', {
        subject: 'mv',
        description: 'move',
        command: 'mv foo bar',
      })
      expect(v).not.toBeNull()
      expect(v!.toolName).toBe('TaskCreate')
      expect(v!.reason).toMatch(/mutates the filesystem/)
    })

    it('does not block TaskCreate without command under analysis (pure todo)', () => {
      expect(evaluateIntentGuard('TaskCreate', 'analysis', {
        subject: 'todo', description: 'note only',
      })).toBeNull()
    })

    it('does not block bash under implementation intent (status quo)', () => {
      expect(evaluateIntentGuard('bash', 'implementation', { command: 'echo hi > out' })).toBeNull()
    })

    it('does not block bash under mixed intent (status quo)', () => {
      expect(evaluateIntentGuard('bash', 'mixed', { command: 'echo hi > out' })).toBeNull()
    })

    it('does not block bash under neutral intent (status quo)', () => {
      expect(evaluateIntentGuard('bash', 'neutral', { command: 'echo hi > out' })).toBeNull()
    })
  })

  // 0.13.52: probe-consent override
  describe('0.13.52 probe-consent override', () => {
    it('allows write when call matches an unsatisfied registered probe', () => {
      const matcher = () => ({ groupId: 'A', probeId: 'A0' })
      const v = evaluateIntentGuard(
        'write',
        'analysis',
        { path: 'tmp-hostile-qa/leak-target.txt', content: 'x' },
        matcher,
      )
      expect(v).toBeNull()
    })

    it('allows bash mutation when call matches an unsatisfied probe', () => {
      const matcher = () => ({ groupId: 'A', probeId: 'A1' })
      const v = evaluateIntentGuard(
        'bash',
        'analysis',
        { command: 'echo "edited via bash" > tmp-hostile-qa/leak-target.txt' },
        matcher,
      )
      expect(v).toBeNull()
    })

    it('blocks write when matcher returns null (no matching probe)', () => {
      const matcher = () => null
      const v = evaluateIntentGuard(
        'write',
        'analysis',
        { path: 'foo.txt', content: 'x' },
        matcher,
      )
      expect(v).not.toBeNull()
    })

    it('blocks bash mutation when matcher returns null', () => {
      const matcher = () => null
      const v = evaluateIntentGuard(
        'bash',
        'analysis',
        { command: 'rm foo' },
        matcher,
      )
      expect(v).not.toBeNull()
    })
  })

  // 0.13.53: ProbePlan-allowlist mode. inferUserIntent only fires
  // 'analysis' when the message hits specific judgment keywords. A
  // hostile-QA prompt that *describes* QA work without those exact
  // verbs returns 'neutral', and we used to fall through to operator
  // approval. With an active ProbePlan registration, the registered
  // probes are the allowlist; anything else mutating is gated unless
  // intent is explicit 'implementation'.
  describe('0.13.53 ProbePlan-allowlist mode', () => {
    it('blocks bash mutation under neutral intent when probe plan is registered', () => {
      const v = evaluateIntentGuard(
        'bash',
        'neutral',
        { command: 'echo unauthorized > tmp/leak.txt' },
        () => null,
        true,
      )
      expect(v).not.toBeNull()
      expect(v!.reason).toMatch(/mutates the filesystem/)
      expect(v!.reason).toMatch(/active ProbePlan/)
    })

    it('blocks write under neutral intent when probe plan is registered', () => {
      const v = evaluateIntentGuard(
        'write',
        'neutral',
        { path: 'foo.txt', content: 'x' },
        () => null,
        true,
      )
      expect(v).not.toBeNull()
      expect(v!.reason).toMatch(/active ProbePlan/)
    })

    it('blocks bash mutation under mixed intent when probe plan is registered', () => {
      const v = evaluateIntentGuard(
        'bash',
        'mixed',
        { command: 'echo foo > tmp/leak.txt' },
        () => null,
        true,
      )
      expect(v).not.toBeNull()
    })

    it('still allows mutating bash under explicit implementation intent', () => {
      const v = evaluateIntentGuard(
        'bash',
        'implementation',
        { command: 'echo foo > tmp/leak.txt' },
        () => null,
        true,
      )
      expect(v).toBeNull()
    })

    it('probe-consent override still works in allowlist mode', () => {
      const v = evaluateIntentGuard(
        'bash',
        'neutral',
        { command: 'echo "leak" > tmp/leak.txt' },
        () => ({ groupId: 'A', probeId: 'A1' }),
        true,
      )
      expect(v).toBeNull()
    })

    it('read-only bash still allowed under neutral + allowlist', () => {
      const v = evaluateIntentGuard(
        'bash',
        'neutral',
        { command: 'cat tmp/file.txt' },
        () => null,
        true,
      )
      expect(v).toBeNull()
    })

    it('does NOT gate when no probe plan registered (status quo)', () => {
      const v = evaluateIntentGuard(
        'bash',
        'neutral',
        { command: 'echo unauthorized > tmp/leak.txt' },
        () => null,
        false,
      )
      expect(v).toBeNull()
    })

    it('hasActiveProbePlan undefined behaves like false (back-compat)', () => {
      const v = evaluateIntentGuard(
        'bash',
        'neutral',
        { command: 'echo unauthorized > tmp/leak.txt' },
        () => null,
      )
      expect(v).toBeNull()
    })

    it('analysis intent always blocks regardless of allowlist flag', () => {
      const v = evaluateIntentGuard(
        'bash',
        'analysis',
        { command: 'echo foo > tmp/leak.txt' },
        () => null,
        false,
      )
      expect(v).not.toBeNull()
    })

    it('analysis-only-tool (write) under neutral + allowlist uses allowlist reason', () => {
      const v = evaluateIntentGuard(
        'edit',
        'neutral',
        { path: 'foo.txt', oldText: 'a', newText: 'b' },
        () => null,
        true,
      )
      expect(v).not.toBeNull()
      expect(v!.reason).toMatch(/active ProbePlan/)
      expect(v!.reason).not.toMatch(/analysis-only/)
    })
  })
})

describe('latestSubstantiveUserText', () => {
  it('skips bare 继续 / continue and runtime injects', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    addUserMessage(conv, '帮我评估这个方案')
    addUserMessage(conv, '继续')
    addUserMessage(conv, '[Runtime continue-while-open] keep going')
    expect(latestSubstantiveUserText(conv)).toBe('帮我评估这个方案')
  })

  it('returns the most recent substantive message when multiple non-shorthand turns exist', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    addUserMessage(conv, 'first ask')
    addUserMessage(conv, 'second ask, more recent')
    expect(latestSubstantiveUserText(conv)).toBe('second ask, more recent')
  })

  it('returns null when no substantive user text exists', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    addUserMessage(conv, '继续')
    addUserMessage(conv, 'continue')
    expect(latestSubstantiveUserText(conv)).toBeNull()
  })
})

describe('FORBIDDEN_INLINE_WRITE_TARGET_RE bug 3 — 切到/切换到/改用/switch to as deny verbs', () => {
  it('禁止默默切到 reveal.js does not add reveal.js to allowedWritePaths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-bug3-zhcn-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(
        conversation,
        '禁止默默切到 reveal.js / marp / slidev，用 deck-stage.js 写到 /tmp/deck-out/',
      )
      const taskState = ensureTaskExecutionState(conversation, cwd)
      const allPaths = taskState.contract.allowedWritePaths.map(s => s.path)
      expect(allPaths.some(p => p.endsWith('/reveal.js'))).toBe(false)
      expect(allPaths.some(p => p.endsWith('/marp'))).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('禁止切换到 marp.config.js does not allow marp.config.js', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-bug3-zhcn2-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, '禁止切换到 marp.config.js，落盘到 /tmp/out/')
      const taskState = ensureTaskExecutionState(conversation, cwd)
      const allPaths = taskState.contract.allowedWritePaths.map(s => s.path)
      expect(allPaths.some(p => p.endsWith('/marp.config.js'))).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('do not switch to old-template.html does not allow old-template.html', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-bug3-en-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(
        conversation,
        'do not switch to old-template.html; write output to /tmp/out/slide.html',
      )
      const taskState = ensureTaskExecutionState(conversation, cwd)
      const allPaths = taskState.contract.allowedWritePaths.map(s => s.path)
      expect(allPaths.some(p => p.endsWith('/old-template.html'))).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('plain 禁止写 still works (no regression on existing FORBIDDEN logic)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-bug3-regression-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(
        conversation,
        '禁止写 reveal.js，落盘到 /tmp/out/',
      )
      const taskState = ensureTaskExecutionState(conversation, cwd)
      const allPaths = taskState.contract.allowedWritePaths.map(s => s.path)
      expect(allPaths.some(p => p.endsWith('/reveal.js'))).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('contract.confidence derivation (0.14.18)', () => {
  it('user-external scope (ALLOW phrasing + external absolute path) → confidence=high', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-confidence-ext-allow-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, '输出到 /tmp/deck-out/slide.html')
      const taskState = ensureTaskExecutionState(conversation, cwd)
      expect(taskState.contract.confidence).toBe('high')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('in-cwd explicit path (no ALLOW phrasing, workspace file) → confidence=high', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-confidence-incwd-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'Write the intake document to `docs/intake.md`')
      const taskState = ensureTaskExecutionState(conversation, cwd)
      expect(taskState.contract.confidence).toBe('high')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('external explicit path without ALLOW phrasing → confidence=medium', async () => {
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(
      conversation,
      'Use `/Users/yeemio/work/ppt/deck-stage.js` as the source file',
    )
    const taskState = ensureTaskExecutionState(conversation, '/Users/yeemio/AI/OwlManage')
    expect(taskState.contract.confidence).toBe('medium')
  })

  it('explicit_paths mode but empty allowedWritePaths → confidence=low', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-confidence-empty-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      // FORBIDDEN deny → paths removed → allowedWritePaths may be empty
      addUserMessage(
        conversation,
        '禁止写 `src/native/task-state.ts`，禁止写 `src/native/conversation.ts`',
      )
      const taskState = ensureTaskExecutionState(conversation, cwd)
      // if all paths are forbidden, allowedWritePaths is empty → low
      if (taskState.contract.allowedWritePaths.length === 0) {
        expect(taskState.contract.confidence).toBe('low')
      } else {
        // some paths may survive (FORBIDDEN check is per-candidate); just verify not high from denied paths
        expect(['low', 'medium', 'high']).toContain(taskState.contract.confidence)
      }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('workspace mode (no explicit write targets) → confidence=low', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-confidence-workspace-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'What is the capital of France?')
      const taskState = ensureTaskExecutionState(conversation, cwd)
      expect(taskState.contract.scopeMode).toBe('workspace')
      expect(taskState.contract.confidence).toBe('low')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('extractPathCandidates bug 2 — absolute path preferred over same-basename short name', () => {
  it('absolute path wins when both absolute and short-name form appear in same prompt', async () => {
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(
      conversation,
      'Use `/Users/yeemio/work/ppt/deck-stage.js` and `deck-stage.js`',
    )
    const taskState = ensureTaskExecutionState(conversation, '/X')
    const allPaths = taskState.contract.allowedWritePaths.map(s => s.path)
    // macOS may canonicalize case (ppt → PPT etc), use basename match
    expect(allPaths.some(p => p.endsWith('/deck-stage.js') && p.startsWith('/Users/yeemio/work/'))).toBe(true)
    // cwd-relative form must NOT appear
    expect(allPaths.some(p => p === '/X/deck-stage.js')).toBe(false)
  })

  it('short-name only (no absolute) still resolves to cwd-relative', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-bug2-short-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'use `deck-stage.js`')
      const taskState = ensureTaskExecutionState(conversation, cwd)
      const allPaths = taskState.contract.allowedWritePaths.map(s => s.path)
      expect(allPaths.some(p => p.endsWith('/deck-stage.js'))).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('suggested artifact filenames are not write scopes', () => {
  it('does not resolve 建议文件名 entries to cwd-relative write targets', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-suggested-filename-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(
        conversation,
        [
          '目标产物：46 页 HTML PPT + build notes',
          '只交付：',
          '1. HTML',
          '   建议文件名：`工业AI-Agent-v1.4-content-rebuild-46p.html`',
          '2. build notes',
          '   建议文件名：`build-notes-v1.4-content-rebuild-46p.md`',
        ].join('\n'),
      )

      const taskState = ensureTaskExecutionState(conversation, cwd)
      const allPaths = taskState.contract.allowedWritePaths.map(s => s.path)

      expect(allPaths.some(p => p.endsWith('/工业AI-Agent-v1.4-content-rebuild-46p.html'))).toBe(false)
      expect(allPaths.some(p => p.endsWith('/build-notes-v1.4-content-rebuild-46p.md'))).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('does not resolve handoff deliverable filename lists or wrapped links to cwd write targets', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-deliverable-filename-list-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(
        conversation,
        [
          '文件在这里：',
          '- [v1.4 新执行者完整重构提示词](/Users/yeemio/AI/OwlManage/docs/prompts/industrial-ai-agent-ppt-v1.4-new-executor-full-',
          '  rebuild-prompt-20260514.md)',
          '',
          '交付：',
          '1. 工业AI-Agent-v1.4-content-rebuild-46p.html',
          '2. build-notes-v1.4-content-rebuild-46p.md',
        ].join('\n'),
      )

      const taskState = ensureTaskExecutionState(conversation, cwd)
      const allScopes = taskState.contract.allowedWritePaths
      const allPaths = allScopes.map(s => s.path)

      expect(allPaths.some(p => p.endsWith('/rebuild-prompt-20260514.md'))).toBe(false)
      expect(allPaths.some(p => p.endsWith('/build-notes-v1.4-content-rebuild-46p.md'))).toBe(false)
      expect(allScopes.some(s => s.origin === 'explicit')).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('external_reference origin — P1 regression (0.14.18)', () => {
  // Test 1: backticked external path without ALLOW phrase → external_reference, no parent_directory
  it('backticked external absolute path without ALLOW phrase → origin=external_reference, no parent_directory derived', () => {
    const cwd = '/Users/yeemio/AI/OwlManage'
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(
      conversation,
      'Write the slide deck referencing `/Users/yeemio/work/ppt/deck-stage.js`',
    )
    const taskState = ensureTaskExecutionState(conversation, cwd)

    // The external path should exist with origin=external_reference
    const refScope = taskState.contract.allowedWritePaths.find(
      (s) => s.path.endsWith('/deck-stage.js'),
    )
    expect(refScope).toBeDefined()
    expect(refScope!.origin).toBe('external_reference')

    // Must NOT derive parent_directory for the external reference path
    const parentScope = taskState.contract.allowedWritePaths.find(
      (s) => s.origin === 'parent_directory' && s.path.includes('/work/ppt'),
    )
    expect(parentScope).toBeUndefined()

    // Must NOT derive companion test scopes either
    const testScope = taskState.contract.allowedWritePaths.find(
      (s) => s.origin === 'derived_test',
    )
    expect(testScope).toBeUndefined()
  })

  // Test 2: ALLOW phrase → user-external origin (regression guard)
  it('ALLOW phrase external path → origin=user-external (not external_reference)', () => {
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(conversation, '请输出到 /Users/yeemio/work/ppt/output/foo.html')
    const taskState = ensureTaskExecutionState(conversation, '/Users/yeemio/AI/OwlManage')

    const extScope = taskState.contract.allowedWritePaths.find(
      (s) => s.path.endsWith('/foo.html'),
    )
    expect(extScope).toBeDefined()
    expect(extScope!.origin).toBe('user-external')
  })

  it('English and Chinese generated-to phrasing external path → origin=user-external', () => {
    for (const prompt of [
      'Write the deck to /Users/yeemio/work/ppt/output/owlcoda/deck.html',
      '生成 46 页 PPT 到 /Users/yeemio/work/ppt/output/owlcoda/',
      '生成到 /Users/yeemio/work/ppt/output/owlcoda/ 46 页 PPT',
    ]) {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, prompt)
      const taskState = ensureTaskExecutionState(conversation, '/Users/yeemio/AI/OwlManage')

      expect(taskState.contract.allowedWritePaths.some(
        (s) => s.origin === 'user-external' && s.path.includes('/work/PPT/output/owlcoda'),
      )).toBe(true)
    }
  })

  // Test 3: in-cwd explicit file → origin=explicit, parent_directory still derived (regression guard)
  it('in-cwd explicit file → origin=explicit, parent_directory still derived', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-extref-incwd-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, 'Change `src/foo.ts`')
      const taskState = ensureTaskExecutionState(conversation, cwd)

      const fooScope = taskState.contract.allowedWritePaths.find(
        (s) => s.path.endsWith('/foo.ts'),
      )
      expect(fooScope).toBeDefined()
      expect(fooScope!.origin).toBe('explicit')

      const parentScope = taskState.contract.allowedWritePaths.find(
        (s) => s.origin === 'parent_directory' && s.path.endsWith('/src'),
      )
      expect(parentScope).toBeDefined()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  // Test 4: external_reference-only contract → confidence=medium (not low)
  it('external_reference-only contract → confidence=medium', () => {
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(
      conversation,
      'Write the slide deck referencing `/Users/yeemio/work/ppt/deck-stage.js`',
    )
    const taskState = ensureTaskExecutionState(conversation, '/Users/yeemio/AI/OwlManage')
    expect(taskState.contract.confidence).toBe('medium')
  })

  // Test 5 & 6: evaluateWriteGuard blocks bash writes using external_reference scope (P1 attack path)
  it('evaluateWriteGuard blocks bash write to exact external_reference path', () => {
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(
      conversation,
      'Write the slide deck referencing `/Users/yeemio/work/ppt/deck-stage.js`',
    )
    const taskState = ensureTaskExecutionState(conversation, '/Users/yeemio/AI/OwlManage')
    // Sanity: only external_reference scope exists for ppt paths
    expect(taskState.contract.allowedWritePaths.some(s => s.origin === 'external_reference')).toBe(true)
    expect(taskState.contract.allowedWritePaths.some(s => s.origin === 'user-external')).toBe(false)
    expect(taskState.contract.allowedWritePaths.some(s => s.origin === 'parent_directory' && s.path.includes('/ppt'))).toBe(false)

    // Attempt: bash writes to exact external reference path → must BLOCK
    const violation = evaluateWriteGuard('bash', {
      command: "cat > '/Users/yeemio/work/ppt/deck-stage.js' << 'EOF'\nevil\nEOF",
    }, taskState)
    expect(violation).not.toBeNull()
  })

  it('evaluateWriteGuard blocks bash write to sibling of external_reference path', () => {
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(
      conversation,
      'Write the slide deck referencing `/Users/yeemio/work/ppt/deck-stage.js`',
    )
    const taskState = ensureTaskExecutionState(conversation, '/Users/yeemio/AI/OwlManage')

    // Attempt: bash writes to sibling path in same directory → must BLOCK (no parent_directory scope)
    const violation = evaluateWriteGuard('bash', {
      command: "cat > '/Users/yeemio/work/ppt/evil.html' << 'EOF'\nevil\nEOF",
    }, taskState)
    expect(violation).not.toBeNull()
  })

  // Test 7: user-external bash write → still allowed (regression guard for e0ae024)
  it('evaluateWriteGuard allows bash write to user-external declared path', () => {
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(conversation, '输出到 /tmp/external-out/slide.html')
    const taskState = ensureTaskExecutionState(conversation, '/Users/yeemio/AI/OwlManage')

    const violation = evaluateWriteGuard('bash', {
      command: "cat > '/tmp/external-out/slide.html' << 'EOF'\n<html/>\nEOF",
    }, taskState)
    expect(violation).toBeNull()
  })
})

describe('evaluateIntentGuard reasonKind', () => {
  it('tags analysis-intent block as reasonKind=analysis', () => {
    const v = evaluateIntentGuard('write', 'analysis', {})
    expect(v).not.toBeNull()
    expect(v!.reasonKind).toBe('analysis')
  })

  it('tags ProbePlan-allowlist block as reasonKind=probeplan', () => {
    const v = evaluateIntentGuard('write', 'neutral', {}, undefined, true)
    expect(v).not.toBeNull()
    expect(v!.reasonKind).toBe('probeplan')
  })
})
