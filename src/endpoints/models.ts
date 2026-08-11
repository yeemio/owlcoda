import { IncomingMessage, ServerResponse } from 'node:http'
import type { OwlCodaConfig } from '../config.js'
import { listConfiguredModels } from '../config.js'
import type { ModelAvailability, ModelTruthAggregator } from '../model-truth.js'
import { resolveModelCapabilities } from '../model-capabilities.js'
import {
  CODEX_CLI_DRIVER_ID,
  CURSOR_AGENT_DRIVER_ID,
  KIMI_CLI_DRIVER_ID,
  inspectVendorCliAvailability,
  type VendorCliDriverName,
} from '../native/runtime-execution-control/index.js'
import type { ModelExecutorKind } from '../model-registry.js'

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

  const data = await Promise.all(models.map(async m => {
    const configuredCapabilities = resolveModelCapabilities(m)
    const contextCapability = snapshot?.byModelId[m.id]?.contextCapability
      ?? configuredCapabilities.context
    const visionCapability = configuredCapabilities.vision
    const vendor = m.executor ? vendorIdentity(m.executor.kind) : undefined
    const vendorAvailability = vendor
      ? await inspectVendorCliAvailability(vendor.name, m.executor)
      : undefined
    return {
      id: m.id,
      display_name: m.label,
      created_at: '2026-01-01T00:00:00Z',
      type: 'model',
      availability: vendorAvailability
        ? (vendorAvailability.available ? 'available' : 'unavailable')
        : snapshot?.byModelId[m.id]
        ? legacyAvailability(snapshot.byModelId[m.id]!.availability)
        : (m.availability ?? 'unknown'),
      ...(vendor && vendorAvailability ? {
        provider: m.executor!.kind,
        executor: m.executor!.kind,
        driver_id: vendor.driverId,
        backend_model: m.backendModel,
        availability_reason: vendorAvailability.reason,
        authentication: vendorAvailability.authentication,
        ...(vendorAvailability.cliVersion ? { cli_version: vendorAvailability.cliVersion } : {}),
      } : {}),
      context_window: contextCapability.contextWindow,
      context_window_source: contextCapability.source,
      context_window_confidence: contextCapability.confidence,
      context_window_labels: contextCapability.labels,
      vision: visionCapability.status,
      input_images: visionCapability.inputImages,
      vision_source: visionCapability.source,
      vision_labels: visionCapability.labels,
    }
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

function vendorIdentity(kind: ModelExecutorKind): {
  name: VendorCliDriverName
  driverId: string
} {
  switch (kind) {
    case 'kimi-cli': return { name: 'kimi', driverId: KIMI_CLI_DRIVER_ID }
    case 'cursor-agent': return { name: 'cursor', driverId: CURSOR_AGENT_DRIVER_ID }
    case 'codex-cli': return { name: 'codex', driverId: CODEX_CLI_DRIVER_ID }
  }
}
