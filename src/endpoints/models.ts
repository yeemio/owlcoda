import { IncomingMessage, ServerResponse } from 'node:http'
import type { OwlCodaConfig } from '../config.js'
import { listConfiguredModels } from '../config.js'
import type { ModelAvailability, ModelTruthAggregator } from '../model-truth.js'

function legacyAvailability(availability: ModelAvailability): 'available' | 'unavailable' | 'unknown' {
  switch (availability.kind) {
    case 'ok':
      return 'available'
    case 'unknown':
      return 'unknown'
    default:
      return 'unavailable'
  }
}

export async function handleModels(
  _req: IncomingMessage,
  res: ServerResponse,
  config: OwlCodaConfig,
  modelTruth?: ModelTruthAggregator,
): Promise<void> {
  const models = listConfiguredModels(config)
  const snapshot = modelTruth ? await modelTruth.getSnapshot() : null

  const data = models.map(m => ({
    id: m.id,
    display_name: m.label,
    created_at: '2026-01-01T00:00:00Z',
    type: 'model',
    availability: snapshot?.byModelId[m.id]
      ? legacyAvailability(snapshot.byModelId[m.id]!.availability)
      : (m.availability ?? 'unknown'),
  }))

  const responseBody = {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  }

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(responseBody))
}
