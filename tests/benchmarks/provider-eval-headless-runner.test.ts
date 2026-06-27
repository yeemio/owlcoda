import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createBenchmarkHeadlessRunnerActualBuilder,
  createBenchmarkProviderEvalExecutor,
  runBenchmarkProviderEvalCase,
  type BenchmarkProviderEvalHeadlessRunnerInput,
  type ConfiguredModel,
} from '../../src/benchmark/index.js'

describe('benchmark provider eval headless runner', () => {
  it('connects provider response context to a headless artifact audit run', async () => {
    const previousAllowRoots = process.env['OWLCODA_ALLOW_FS_ROOTS']
    process.env['OWLCODA_ALLOW_FS_ROOTS'] = 'preexisting-root'
    let seen: BenchmarkProviderEvalHeadlessRunnerInput | undefined
    try {
      const model = configuredModel()
      const executor = createBenchmarkProviderEvalExecutor({
        model,
        fetch: async () => jsonResponse({
          id: 'chatcmpl-headless-runner',
          object: 'chat.completion',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'provider observed task' },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
          },
        }),
        actualResultBuilder: createBenchmarkHeadlessRunnerActualBuilder({
          apiBaseUrl: 'https://daemon.test/v1',
          apiKey: 'daemon-key',
          model: 'gpt-test-backend',
          autoApprove: true,
          allowTools: ['read', 'write'],
          runHeadlessAudit: async (input) => {
            seen = input
            expect(input.responseText).toBe('provider observed task')
            expect(input.usage).toMatchObject({
              inputTokens: 100,
              outputTokens: 20,
              totalTokens: 120,
            })
            expect(input.rawResponse).toMatchObject({ id: 'chatcmpl-headless-runner' })
            expect(process.env['OWLCODA_ALLOW_FS_ROOTS']?.split(':')).toEqual(expect.arrayContaining([
              'preexisting-root',
              input.workspaceDir,
            ]))
            await writeFile(join(input.workspaceDir, 'deck.html'), '<section>One</section>', 'utf8')
            await writeFile(join(input.workspaceDir, 'build-notes.md'), 'notes', 'utf8')
            return {
              exitCode: 0,
              stopReason: 'end_turn',
              taskStatus: 'completed',
              timeToFirstWriteMs: input.input.expected.timeToFirstWriteMs,
              toolCalls: [
                { tool: 'read', input: { file_path: join(input.workspaceDir, 'brief.md') } },
                { tool: 'write', input: { file_path: join(input.workspaceDir, 'deck.html') } },
              ],
              verification: input.input.expected.verification.map(item => ({
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
        evalRunId: 'headless-runner',
        executor,
      })

      expect(seen).toMatchObject({
        apiBaseUrl: 'https://daemon.test/v1',
        apiKey: 'daemon-key',
        model: 'gpt-test-backend',
        autoApprove: true,
        allowTools: ['read', 'write'],
      })
      expect(result.observation.error).toBeUndefined()
      expect(result.observation.actual).toMatchObject({
        caseId: 'deck-12p',
        finalStatus: 'passed',
        readCallsBeforeFirstWrite: 1,
      })
      expect(result.scorecardPacket.scorecard.verdict).toBe('pass')
    } finally {
      if (previousAllowRoots === undefined) {
        delete process.env['OWLCODA_ALLOW_FS_ROOTS']
      } else {
        process.env['OWLCODA_ALLOW_FS_ROOTS'] = previousAllowRoots
      }
    }
  })

  it('does not pass when headless returns text without required artifacts or verification', async () => {
    const model = configuredModel()
    const executor = createBenchmarkProviderEvalExecutor({
      model,
      fetch: async () => jsonResponse({
        id: 'chatcmpl-text-only',
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'looks done' },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      }),
      actualResultBuilder: createBenchmarkHeadlessRunnerActualBuilder({
        apiBaseUrl: 'https://daemon.test/v1',
        apiKey: 'daemon-key',
        model: 'gpt-test-backend',
        runHeadlessAudit: async () => ({
          exitCode: 0,
          stopReason: 'end_turn',
          taskStatus: 'completed',
          text: 'Done.',
        }),
      }),
    })

    const result = await runBenchmarkProviderEvalCase({
      caseId: 'deck-12p',
      providerId: 'openai',
      modelId: model.id,
      evalRunId: 'headless-runner-text-only',
      executor,
    })

    expect(result.observation.error).toBeUndefined()
    expect(result.observation.actual?.finalStatus).toBe('failed')
    expect(result.observation.actual?.verification).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'not_run', passed: false }),
    ]))
    expect(result.scorecardPacket.scorecard.verdict).toBe('fail')
  })
})

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
