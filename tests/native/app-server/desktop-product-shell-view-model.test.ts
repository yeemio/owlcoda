import { describe, expect, it } from 'vitest'
import type { AppServerClient } from '../../../src/native/app-server/client.js'
import {
  latestRunIdFromDesktopTranscript,
  loadDesktopProductShellViewModel,
} from '../../../src/native/app-server/desktop-product-shell-view-model.js'

describe('desktop product shell view model', () => {
  it('loads a read-only product shell view model from App Server client surfaces', async () => {
    const calls: string[] = []
    const change = {
      id: 'diff-1',
      threadId: 'thread-1',
      toolUseId: 'tool-1',
      toolName: 'edit',
      path: '/repo/owlcoda/src/app.ts',
      operation: 'update',
      mode: 'string-replace',
      oldText: 'old',
      newText: 'new',
      oldStr: 'old',
      newStr: 'new',
      replaceAll: false,
      diffPreview: '-old\n+new',
    } as any
    const client = {
      projectList: async () => {
        calls.push('project/list')
        return { projects: [{ id: 'project-1', name: 'OwlCoda', root: '/repo/owlcoda', source: 'cwd' }] }
      },
      threadList: async (params: any) => {
        calls.push(`thread/list:${params.projectId}`)
        return {
          threads: [{ id: 'thread-1', projectId: 'project-1', title: 'Thread 1', model: 'model-1', status: 'ready', createdAt: 1, updatedAt: 2, cwd: '/repo/owlcoda', sessionPath: '/sessions/thread-1.json', turnCount: 1 }],
          totalCount: 1,
          offset: 0,
          limit: 100,
          hasMore: false,
        }
      },
      runtimeRailRead: async (params: any) => {
        calls.push(`runtimeRail/read:${params.projectId}`)
        return { projectId: params.projectId, freshness: 'missing', summary: null, source: 'not_connected' }
      },
      providerEvalReportRead: async () => {
        calls.push('benchmark/providerEvalReport/read')
        return {
          schemaVersion: 1,
          source: 'local_provider_eval_store',
          recordPath: '/tmp/provider-eval.jsonl',
          recordCount: 1,
          report: {
            schemaVersion: 1,
            generatedAt: '2026-06-26T09:00:00.000Z',
            recordCount: 2,
            providerModelCount: 2,
            caseCount: 1,
            passedCount: 1,
            failedCount: 1,
            localOnly: true,
            redactionMode: 'local_redacted_v0',
            trainingUse: 'not_collected',
            leaderboard: [{
              providerId: 'openai',
              modelId: 'gpt-strong',
              runCount: 1,
              passedCount: 1,
              failedCount: 0,
              passRate: 1,
              averageScore: 94,
              totalTokens: 150,
              totalCostUsd: 0.01,
              averageDurationMs: 1000,
              costPerPassedRunUsd: 0.01,
              verdict: 'pass',
            }, {
              providerId: 'moonshot',
              modelId: 'kimi-lite',
              runCount: 1,
              passedCount: 0,
              failedCount: 1,
              passRate: 0,
              averageScore: 55,
              totalTokens: 220,
              totalCostUsd: 0.004,
              averageDurationMs: 1800,
              costPerPassedRunUsd: null,
              verdict: 'fail',
            }],
            caseMatrix: [{
              caseId: 'deck-12p',
              providerId: 'openai',
              modelId: 'gpt-strong',
              evalRunId: 'eval-openai-1',
              recordedAt: '2026-06-26T09:00:00.000Z',
              passed: true,
              hasActualResult: true,
              score: 94,
              verdict: 'pass',
              antiCheat: 'pass',
              totalTokens: 150,
              costUsd: 0.01,
              durationMs: 1000,
              evidenceRefCount: 3,
            }, {
              caseId: 'deck-12p',
              providerId: 'moonshot',
              modelId: 'kimi-lite',
              evalRunId: 'eval-kimi-1',
              recordedAt: '2026-06-26T09:01:00.000Z',
              passed: false,
              hasActualResult: true,
              score: 55,
              verdict: 'fail',
              antiCheat: 'warn',
              totalTokens: 220,
              costUsd: 0.004,
              durationMs: 1800,
              evidenceRefCount: 2,
              error: 'missing verification',
            }],
            summary: 'Benchmark provider eval batch report: 1/2 passed',
          },
          markdown: 'Benchmark Provider Eval Batch Report',
        }
      },
      runtimeTranscriptRead: async (params: any) => {
        calls.push(`runtimeTranscript/read:${params.threadId}`)
        return {
          threadId: 'thread-1',
          projectId: 'project-1',
          title: 'Thread 1',
          model: 'model-1',
          status: 'ready',
          createdAt: 1,
          updatedAt: 2,
          itemCount: 2,
          runtimeEventCount: 2,
          items: [
            { id: 'turn:0:text:0', kind: 'message', role: 'user', text: 'hello', timestamp: 1, turnIndex: 0, contentIndex: 0 },
            { id: 'turn:1:tool:0', kind: 'tool_call', toolUseId: 'tool-1', toolName: 'TaskVerify', input: {}, status: 'completed', timestamp: 2, turnIndex: 1, contentIndex: 0, runtime: { runId: 'run-1', eventIds: ['event-1'] } },
          ],
        }
      },
      runtimeFactsRead: async (params: any) => {
        calls.push(`runtimeFacts/read:${params.runId}`)
        return {
          schemaVersion: 1,
          runId: 'run-1',
          threadId: 'thread-1',
          projectId: 'project-1',
          threadIds: ['thread-1'],
          turnIds: ['turn-1'],
          taskIds: ['task-1'],
          stepIds: [],
          jobIds: ['job-1'],
          artifactIds: [],
          checkpointIds: [],
          proofIds: ['proof-1'],
          eventIds: ['event-1'],
          checkpointRecordIds: [],
          events: [],
          checkpoints: [],
          jobs: [],
          artifacts: [],
          runtimeEventCount: 1,
          checkpointCount: 0,
          jobCount: 1,
          artifactCount: 0,
        }
      },
      runtimeScorecardRead: async (params: any) => {
        calls.push(`runtimeScorecard/read:${params.runId}`)
        return {
          schemaVersion: 1,
          threadId: 'thread-1',
          projectId: 'project-1',
          runId: 'run-1',
          scorecard: {
            scorecardVersion: 1,
            runId: 'run-1',
            threadIds: ['thread-1'],
            turnIds: ['turn-1'],
            generatedAt: '2026-06-26T09:00:00.000Z',
            overallScore: 88,
            verdict: 'pass',
            dimensions: [{
              id: 'verification',
              score: 1,
              verdict: 'pass',
              evidenceRefs: ['event-1'],
              notes: ['verification passed'],
            }],
            antiCheat: {
              verdict: 'pass',
              gates: [],
            },
            evidenceRefs: ['event-1', 'job-1', 'proof-1'],
          },
          summary: 'Scorecard run=run-1 score=88 verdict=pass anti_cheat=pass',
          trajectory: {
            recordCount: 1,
            localOnly: true,
            redactionMode: 'local_redacted_v0',
            records: [],
          },
          facts: {
            runtimeEventCount: 1,
            checkpointCount: 0,
            jobCount: 1,
            artifactCount: 0,
          },
        }
      },
      structuredOutputArtifactsRead: async (params: any) => {
        calls.push(`structuredOutputArtifacts/read:${params.runId}`)
        return {
          schemaVersion: 1,
          surface: 'structured-output-artifacts',
          threadId: 'thread-1',
          projectId: 'project-1',
          runId: 'run-1',
          artifactCount: 1,
          successCount: 0,
          failedCount: 1,
          warningCount: 0,
          items: [{
            artifactId: 'structured-output-1',
            attemptLedgerId: 'structured-output-1-attempts',
            status: 'failed',
            ok: false,
            parsed: true,
            schemaValid: true,
            fallbackUsed: true,
            validationErrors: ['forbidden_phrase: EV'],
            artifactPreview: {
              artifact: 'failed_fallback.v1',
              ok: false,
              failureReason: 'forbidden_phrase',
            },
            attempts: [],
            rawText: '{"artifact":"failed_fallback.v1"}',
            rerunAction: {
              available: true,
              httpEndpoint: '/v1/structured-output/rerun',
              request: {
                runRef: '/repo/owlcoda/out',
                previousArtifactId: 'structured-output-1',
                role: 'judge',
                model: 'model-1',
                preset: 'canonical-judge.v1',
                artifactRef: 'structured-output-1',
              },
            },
          }],
          warnings: [],
        }
      },
      approvalList: async (params: any) => {
        calls.push(`approval/list:${params.threadId}`)
        return { approvals: [] }
      },
      interactionList: async (params: any) => {
        calls.push(`interaction/list:${params.threadId}`)
        return { interactions: [] }
      },
      reviewList: async (params: any) => {
        calls.push(`review/list:${params.threadId}`)
        return { threadId: 'thread-1', changes: [change] }
      },
      reviewBatchPreflight: async (params: any) => {
        calls.push(`review/batchPreflight:${params.diffIds.join(',')}`)
        return {
          status: 'ready',
          threadId: 'thread-1',
          diffIds: ['diff-1'],
          preflights: [{ status: 'ready', reason: 'source_match', message: 'ready', change }],
          blocked: [],
        }
      },
    } as unknown as AppServerClient

    const view = await loadDesktopProductShellViewModel(client)

    expect(calls).not.toContain('diagnostic/health')
    expect(calls).toEqual([
      'project/list',
      'thread/list:project-1',
      'runtimeRail/read:project-1',
      'benchmark/providerEvalReport/read',
      'runtimeTranscript/read:thread-1',
      'runtimeFacts/read:run-1',
      'runtimeScorecard/read:run-1',
      'structuredOutputArtifacts/read:run-1',
      'approval/list:thread-1',
      'interaction/list:thread-1',
      'review/list:thread-1',
      'review/batchPreflight:diff-1',
    ])
    expect(view).toMatchObject({
      surface: 'desktop-product-shell-view-model',
      status: 'ready',
      project: { id: 'project-1' },
      thread: { id: 'thread-1' },
      runtime: {
        runId: 'run-1',
        runtimeFactsStatus: 'ready',
        drilldown: {
          scorecardStatus: 'ready',
          scorecard: {
            overallScore: 88,
            verdict: 'pass',
            antiCheat: 'pass',
          },
        },
        structuredOutputArtifacts: {
          surface: 'structured-output-artifacts',
          failedCount: 1,
          items: [{
            artifactId: 'structured-output-1',
            status: 'failed',
            fallbackUsed: true,
          }],
        },
      },
      review: {
        readyCount: 1,
      },
      providerEvalReport: {
        recordCount: 1,
      },
      modelComparison: {
        surface: 'model-comparison-panel',
        status: 'ready',
        sourceMethod: 'benchmark/providerEvalReport/read',
        recordPath: '/tmp/provider-eval.jsonl',
        recordCount: 2,
        providerModelCount: 2,
        caseCount: 1,
        passedCount: 1,
        failedCount: 1,
        localOnly: true,
        trainingUse: 'not_collected',
        leaderboard: [
          {
            providerModel: 'openai/gpt-strong',
            passRatePercent: 100,
            averageScore: 94,
            verdict: 'pass',
          },
          {
            providerModel: 'moonshot/kimi-lite',
            passRatePercent: 0,
            averageScore: 55,
            verdict: 'fail',
          },
        ],
        cases: [
          {
            caseId: 'deck-12p',
            providerModel: 'openai/gpt-strong',
            passed: true,
            score: 94,
          },
          {
            caseId: 'deck-12p',
            providerModel: 'moonshot/kimi-lite',
            passed: false,
            score: 55,
            error: 'missing verification',
          },
        ],
      },
    })
    expect(view.runtime.runtimeFacts?.taskIds).toEqual(['task-1'])
    expect(view.runtime.drilldown?.summary).toMatchObject({
      events: 1,
      jobs: 1,
      proofs: 1,
    })
  })

  it('does not call runtimeFacts/read when the transcript has no runId', async () => {
    const calls: string[] = []
    const client = {
      projectList: async () => ({ projects: [{ id: 'project-1', name: 'OwlCoda', root: '/repo/owlcoda', source: 'cwd' }] }),
      threadList: async () => ({
        threads: [{ id: 'thread-1', projectId: 'project-1', title: 'Thread 1', model: 'model-1', status: 'ready', createdAt: 1, updatedAt: 2, cwd: '/repo/owlcoda', sessionPath: '/sessions/thread-1.json', turnCount: 1 }],
        totalCount: 1,
        offset: 0,
        limit: 100,
        hasMore: false,
      }),
      runtimeRailRead: async () => ({ projectId: 'project-1', freshness: 'missing', summary: null, source: 'not_connected' }),
      providerEvalReportRead: async () => ({ unavailable: true, message: 'not configured' }),
      runtimeTranscriptRead: async () => ({
        threadId: 'thread-1',
        projectId: 'project-1',
        title: 'Thread 1',
        model: 'model-1',
        status: 'ready',
        createdAt: 1,
        updatedAt: 2,
        itemCount: 1,
        runtimeEventCount: 0,
        items: [{ id: 'turn:0:text:0', kind: 'message', role: 'assistant', text: 'no run id', timestamp: 1, turnIndex: 0, contentIndex: 0 }],
      }),
      runtimeFactsRead: async () => {
        calls.push('runtimeFacts/read')
        throw new Error('runtimeFacts/read should not be called without runId')
      },
      runtimeScorecardRead: async () => {
        calls.push('runtimeScorecard/read')
        throw new Error('runtimeScorecard/read should not be called without runId')
      },
      structuredOutputArtifactsRead: async () => {
        calls.push('structuredOutputArtifacts/read')
        throw new Error('structuredOutputArtifacts/read should not be called without runId')
      },
      approvalList: async () => ({ approvals: [] }),
      interactionList: async () => ({ interactions: [] }),
      reviewList: async () => ({ threadId: 'thread-1', changes: [] }),
    } as unknown as AppServerClient

    const view = await loadDesktopProductShellViewModel(client)

    expect(calls).toEqual([])
    expect(view.runtime).toMatchObject({
      runId: null,
      runtimeFactsStatus: 'missing_run_id',
      drilldown: null,
    })
    expect(view.modelComparison).toMatchObject({
      surface: 'model-comparison-panel',
      status: 'unavailable',
      sourceMethod: 'benchmark/providerEvalReport/read',
      localOnly: true,
      trainingUse: 'not_collected',
      unavailableReason: 'not configured',
    })
  })

  it('extracts the latest runId from transcript runtime anchors', () => {
    expect(latestRunIdFromDesktopTranscript({
      threadId: 'thread-1',
      model: 'model',
      status: 'ready',
      createdAt: 1,
      updatedAt: 2,
      itemCount: 2,
      runtimeEventCount: 2,
      items: [
        { id: 'older', kind: 'tool_call', toolUseId: 'tool-1', toolName: 'edit', input: {}, status: 'completed', timestamp: 1, turnIndex: 0, contentIndex: 0, runtime: { runId: 'run-old', eventIds: [] } },
        { id: 'newer', kind: 'tool_result', toolUseId: 'tool-2', status: 'completed', timestamp: 2, turnIndex: 1, contentIndex: 0, result: { content: 'ok', isError: false }, runtime: { runId: 'run-new', eventIds: [] } },
      ],
    })).toBe('run-new')
  })
})
