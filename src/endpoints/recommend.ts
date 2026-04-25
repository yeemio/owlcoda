/**
 * GET /v1/recommend — Model recommendation endpoint.
 * Returns scored model recommendations for a given intent.
 */

import { IncomingMessage, ServerResponse } from 'node:http'
import type { OwlCodaConfig } from '../config.js'
import { recommendModel, type Intent } from '../model-recommender.js'

const VALID_INTENTS: Intent[] = ['code', 'analysis', 'search', 'chat', 'general']

export function handleRecommend(req: IncomingMessage, res: ServerResponse, config: OwlCodaConfig): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const intentParam = url.searchParams.get('intent') ?? 'general'

  if (!VALID_INTENTS.includes(intentParam as Intent)) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: `Invalid intent "${intentParam}". Use: ${VALID_INTENTS.join(', ')}` },
    }))
    return
  }

  const rec = recommendModel(config, intentParam as Intent)

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    intent: rec.intent,
    recommended: {
      model_id: rec.recommended.modelId,
      score: rec.recommended.score,
      reasons: rec.recommended.reasons,
    },
    alternatives: rec.alternatives.map(a => ({
      model_id: a.modelId,
      score: a.score,
      reasons: a.reasons,
    })),
  }))
}
