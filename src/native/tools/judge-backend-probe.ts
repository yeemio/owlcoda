import {
  formatJudgeBackendProbeResult,
  runJudgeBackendProbe,
  type JudgeBackendProbeResult,
  type JudgeBackendProbeInput,
} from '../judge-backend-probe.js'
import {
  appendJobOutput,
  createJob,
  finishJob,
  getJob,
  recordJobCleanup,
  registerJobAbortAdapter,
  startJob,
  unregisterJobAbortAdapter,
  type JobTerminalStatus,
} from '../job-supervisor.js'
import type { NativeToolDef, ToolResult } from './types.js'

export function createJudgeBackendProbeTool(): NativeToolDef<JudgeBackendProbeInput> {
  return {
    name: 'JudgeBackendProbe',
    description:
      'Probe OpenAI-compatible judge backends with fixed prompts before a full scorer run. ' +
      'Records latency, JSON parse success, empty responses, malformed JSON, timeout, and fallback recommendation.',
    maturity: 'beta' as const,
    async execute(input: JudgeBackendProbeInput): Promise<ToolResult> {
      const endpoint = typeof input?.endpoint === 'string' ? input.endpoint.trim() : ''
      const models = Array.isArray(input?.models)
        ? input.models.map((model) => typeof model === 'string' ? model.trim() : '').filter(Boolean)
        : []
      if (!endpoint) return { output: 'endpoint is required for JudgeBackendProbe.', isError: true }
      if (models.length === 0) return { output: 'models must contain at least one model id.', isError: true }

      const job = createJob({
        type: 'api',
        stage: 'queued',
        tool: 'JudgeBackendProbe',
        provider: models.join(','),
        command: endpoint,
        recoveryHint: `JudgeBackendProbe endpoint=${endpoint} models=${models.join(',')}`,
      })
      startJob(job.jobId, { stage: 'probing', externalHandle: endpoint })
      const liveCancelController = new AbortController()
      registerJobAbortAdapter(job.jobId, (reason) => {
        liveCancelController.abort(new Error(`JobCancel: ${reason}`))
      })

      let result: JudgeBackendProbeResult
      try {
        result = await runJudgeBackendProbe({
          ...input,
          endpoint,
          models,
        }, {
          signal: liveCancelController.signal,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        appendJobOutput(job.jobId, `${message}\n`)
        if (getJob(job.jobId)?.status === 'cancelled') {
          return {
            output: `JudgeBackendProbe cancelled: ${job.jobId}`,
            isError: true,
            metadata: { job: getJob(job.jobId) },
          }
        }
        finishJob(job.jobId, 'failed', {
          stage: 'failed',
          error: message,
          terminationReason: 'judge_backend_probe_error',
        })
        recordJobCleanup(job.jobId, { attempted: false, succeeded: true, remainingPids: [] })
        return {
          output: `JudgeBackendProbe failed: ${message}`,
          isError: true,
          metadata: { job: getJob(job.jobId) },
        }
      } finally {
        unregisterJobAbortAdapter(job.jobId)
      }
      const output = formatJudgeBackendProbeResult(result)
      appendJobOutput(job.jobId, output)
      if (getJob(job.jobId)?.status === 'cancelled') {
        return {
          output: `JudgeBackendProbe cancelled: ${job.jobId}`,
          isError: true,
          metadata: { result, job: getJob(job.jobId) },
        }
      }
      const jobStatus = judgeProbeJobStatus(result)
      finishJob(job.jobId, jobStatus, {
        stage: jobStatus === 'done' ? 'healthy' : jobStatus,
        ...(jobStatus !== 'done' ? { terminationReason: judgeProbeTerminationReason(result) } : {}),
      })
      recordJobCleanup(job.jobId, { attempted: false, succeeded: true, remainingPids: [] })
      return {
        output,
        isError: false,
        metadata: { result, job: getJob(job.jobId) },
      }
    },
  }
}

function judgeProbeJobStatus(result: JudgeBackendProbeResult): JobTerminalStatus {
  if (result.recommendedModel) return 'done'
  const summaries = Object.values(result.models)
  return summaries.some(summary => summary.timeout > 0) ? 'timeout' : 'failed'
}

function judgeProbeTerminationReason(result: JudgeBackendProbeResult): string {
  const summaries = Object.values(result.models)
  if (summaries.some(summary => summary.timeout > 0)) return 'judge_backend_timeout'
  if (summaries.some(summary => summary.httpError > 0)) return 'judge_backend_http_error'
  if (summaries.some(summary => summary.fetchError > 0)) return 'judge_backend_fetch_error'
  if (summaries.some(summary => summary.emptyResponse > 0)) return 'judge_backend_empty_response'
  if (summaries.some(summary => summary.malformedJson > 0)) return 'judge_backend_malformed_json'
  return 'judge_backend_unhealthy'
}

export type { JudgeBackendProbeInput }
