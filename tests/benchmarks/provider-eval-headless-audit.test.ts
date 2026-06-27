import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildBenchmarkEvalPacket,
  buildBenchmarkProviderEvalActualFromHeadless,
  createBenchmarkHeadlessArtifactAuditBuilder,
  createBenchmarkProviderEvalExecutor,
  getBenchmarkCase,
  renderBenchmarkTaskPrompt,
  runBenchmarkCaseDryRun,
  runBenchmarkProviderEvalCase,
  type BenchmarkProviderEvalExecutorInput,
  type ConfiguredModel,
} from '../../src/benchmark/index.js'

describe('benchmark provider eval headless artifact audit', () => {
  it('builds a benchmark actual from headless workspace artifacts and verification evidence', async () => {
    const workspaceDir = join(await makeTempRoot(), 'workspace')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(join(workspaceDir, 'deck.html'), '<section>One</section>', 'utf8')
    await writeFile(join(workspaceDir, 'build-notes.md'), 'built by headless run', 'utf8')

    try {
      const input = providerEvalInput('deck-12p', workspaceDir)
      const actual = await buildBenchmarkProviderEvalActualFromHeadless(input, {
        exitCode: 0,
        stopReason: 'end_turn',
        taskStatus: 'completed',
        timeToFirstWriteMs: 4321,
        toolCalls: [
          { tool: 'read', input: { file_path: join(workspaceDir, 'brief.md') } },
          { tool: 'write', input: { file_path: join(workspaceDir, 'deck.html') } },
        ],
        verification: [{
          id: 'deck-12p.section_count',
          kind: 'html_deck.section_count',
          passed: true,
          message: 'section smoke passed',
          expected: 12,
          actual: 12,
        }],
      })

      expect(actual).toMatchObject({
        caseId: 'deck-12p',
        packageVersion: input.expected.packageVersion,
        binaryBuild: 'headless-audit',
        timeToFirstWriteMs: 4321,
        readCallsBeforeFirstWrite: 1,
        taskNoProgress: { hard: 0, suppressed: 0 },
        finalStatus: 'passed',
      })
      expect(actual.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'deck.html', kind: 'html_deck', exists: true, source: 'write' }),
        expect.objectContaining({ path: 'build-notes.md', kind: 'build_notes', exists: true, source: 'write' }),
      ]))
      expect(actual.verification).toEqual([
        expect.objectContaining({
          id: 'deck-12p.section_count',
          status: 'passed',
          passed: true,
        }),
      ])
      expect(actual.trace).toEqual([
        { name: 'read', input: { file_path: join(workspaceDir, 'brief.md') } },
        { name: 'write', input: { file_path: join(workspaceDir, 'deck.html') } },
      ])
    } finally {
      await rm(workspaceDir, { recursive: true, force: true })
    }
  })

  it('fails the actual when expected artifacts are missing even if headless text looks successful', async () => {
    const workspaceDir = join(await makeTempRoot(), 'workspace')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(join(workspaceDir, 'deck.html'), '<section>One</section>', 'utf8')

    try {
      const input = providerEvalInput('deck-12p', workspaceDir)
      const actual = await buildBenchmarkProviderEvalActualFromHeadless(input, {
        exitCode: 0,
        stopReason: 'end_turn',
        taskStatus: 'completed',
        text: 'Done. Both files are ready.',
      })

      expect(actual.finalStatus).toBe('failed')
      expect(actual.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'deck.html', exists: true }),
        expect.objectContaining({ path: 'build-notes.md', exists: false }),
      ]))
      expect(actual.verification).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'not_run', passed: false }),
      ]))
    } finally {
      await rm(workspaceDir, { recursive: true, force: true })
    }
  })

  it('connects the headless audit builder to the provider eval default executor', async () => {
    const model = configuredModel()
    const executor = createBenchmarkProviderEvalExecutor({
      model,
      fetch: async () => jsonResponse({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'provider returned instructions' },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
        },
      }),
      actualResultBuilder: createBenchmarkHeadlessArtifactAuditBuilder({
        runHeadlessAudit: async ({ input }) => {
          await writeFile(join(input.workspaceDir, 'deck.html'), '<section>One</section>', 'utf8')
          await writeFile(join(input.workspaceDir, 'build-notes.md'), 'notes', 'utf8')
          return {
            exitCode: 0,
            stopReason: 'end_turn',
            taskStatus: 'completed',
            timeToFirstWriteMs: input.expected.timeToFirstWriteMs,
            toolCalls: [
              { tool: 'write', input: { file_path: join(input.workspaceDir, 'deck.html') } },
            ],
            verification: input.expected.verification.map(item => ({
              id: item.id,
              kind: item.kind,
              passed: item.passed,
              message: item.message,
              expected: item.expected,
              actual: item.actual,
            })),
          }
        },
      }),
    })

    const result = await runBenchmarkProviderEvalCase({
      caseId: 'deck-12p',
      providerId: 'openai',
      modelId: model.id,
      evalRunId: 'headless-audit-builder',
      executor,
    })

    expect(result.observation.error).toBeUndefined()
    expect(result.observation.actual).toMatchObject({
      caseId: 'deck-12p',
      finalStatus: 'passed',
    })
    expect(result.observation.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    })
    expect(result.scorecardPacket.scorecard.verdict).toBe('pass')
  })
})

function providerEvalInput(caseId: 'deck-12p', workspaceDir: string): BenchmarkProviderEvalExecutorInput {
  const fixture = getBenchmarkCase(caseId)
  return {
    caseId,
    providerId: 'openai',
    modelId: 'gpt-test',
    fixture,
    prompt: renderBenchmarkTaskPrompt(fixture, workspaceDir),
    evalPacket: buildBenchmarkEvalPacket(fixture, workspaceDir),
    expected: runBenchmarkCaseDryRun(caseId, {
      packageVersion: '0.15.test',
      binaryBuild: 'headless-expected',
    }),
    workspaceDir,
  }
}

async function makeTempRoot(): Promise<string> {
  const root = join(tmpdir(), `owlcoda-headless-audit-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(root, { recursive: true })
  return root
}

function configuredModel(): ConfiguredModel {
  return {
    id: 'gpt-test',
    label: 'gpt-test',
    backendModel: 'gpt-test-backend',
    aliases: [],
    tier: 'cloud',
    provider: 'openai',
    endpoint: 'https://api.openai.test/v1',
    apiKey: 'sk-test',
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
