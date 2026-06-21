import {
  formatJudgeBackendProbeResult,
  runJudgeBackendProbe,
  type JudgeBackendProbeInput,
} from '../judge-backend-probe.js'
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

      const result = await runJudgeBackendProbe({
        ...input,
        endpoint,
        models,
      })
      return {
        output: formatJudgeBackendProbeResult(result),
        isError: false,
        metadata: { result },
      }
    },
  }
}

export type { JudgeBackendProbeInput }
