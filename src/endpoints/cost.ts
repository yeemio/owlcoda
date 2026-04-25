/**
 * GET /v1/cost — Session cost summary endpoint.
 * Returns per-model cost breakdown with real perf data.
 */

import { IncomingMessage, ServerResponse } from 'node:http'
import { getSessionCostSummary } from '../cost-estimator.js'
import { getAllModelMetrics, getModelPerfSummary } from '../perf-tracker.js'
import { getTokenUsage } from '../trace.js'

export function handleCost(_req: IncomingMessage, res: ServerResponse): void {
  const usage = getTokenUsage()
  const allMetrics = getAllModelMetrics()

  let perModel: Array<{
    model_id: string
    input_tokens: number
    output_tokens: number
    request_count: number
    cost: number
    unit: string
    source: string
    real_tps?: number
  }> = []

  let totalCost = 0
  let unit = '¥'

  if (allMetrics.length > 0) {
    const modelUsage = allMetrics.map(m => {
      const perf = getModelPerfSummary(m.modelId)
      return {
        modelId: m.modelId,
        inputTokens: m.totalInputTokens,
        outputTokens: m.totalOutputTokens,
        realTps: perf?.avgOutputTps,
      }
    })
    const summary = getSessionCostSummary(modelUsage)
    totalCost = summary.totalCost
    unit = summary.unit

    perModel = summary.perModel.map((entry, i) => ({
      model_id: entry.modelId,
      input_tokens: modelUsage[i]!.inputTokens,
      output_tokens: modelUsage[i]!.outputTokens,
      request_count: allMetrics.find(m => m.modelId === entry.modelId)?.requestCount ?? 0,
      cost: entry.cost.totalCost,
      unit: entry.cost.unit,
      source: entry.cost.source,
      real_tps: modelUsage[i]!.realTps,
    }))
  }

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    data: perModel,
    total_cost: totalCost,
    unit,
    session: {
      total_input_tokens: usage.inputTokens,
      total_output_tokens: usage.outputTokens,
      request_count: usage.requestCount,
      started_at: usage.startedAt,
    },
  }))
}
