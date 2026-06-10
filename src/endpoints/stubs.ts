import { IncomingMessage, ServerResponse } from 'node:http'
import type { OwlCodaConfig } from '../config.js'
import { listConfiguredModels, getDefaultConfiguredModel } from '../config.js'

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * Bootstrap startup config. Return OwlCoda model registry.
 */
export function handleBootstrap(
  _req: IncomingMessage,
  res: ServerResponse,
  config: OwlCodaConfig,
): void {
  const models = listConfiguredModels(config)
  const defaultModel = getDefaultConfiguredModel(config)

  sendJson(res, 200, {
    models: models.map(m => ({
      id: m.id,
      display_name: m.label,
      created_at: '2026-01-01T00:00:00Z',
      type: 'model',
    })),
    default_model: defaultModel?.id ?? models[0]?.id ?? 'unknown',
    features: {},
    client_config: {},
  })
}

/**
 * /api/oauth/usage
 * Return local usage data.
 */
export function handleUsage(
  _req: IncomingMessage,
  res: ServerResponse,
  _config: OwlCodaConfig,
): void {
  const now = Date.now() / 1000

  sendJson(res, 200, {
    five_hour: {
      utilization: 0,
      resets_at: now + 5 * 3600,
    },
    seven_day: {
      utilization: 0,
      resets_at: now + 7 * 86400,
    },
    extra_usage: null,
    tier: 'local',
    plan: 'owlcoda-local',
  })
}

/**
 * /api/oauth/profile
 * Return OwlCoda local user info.
 */
export function handleProfile(
  _req: IncomingMessage,
  res: ServerResponse,
  _config: OwlCodaConfig,
): void {
  sendJson(res, 200, {
    id: 'local-user',
    email: 'local@owlcoda',
    name: 'OwlCoda Local User',
    organizations: [{
      id: 'local-org',
      name: 'OwlCoda Local',
      role: 'owner',
    }],
    plan: 'owlcoda-local',
  })
}

/**
 * /api/oauth/account/settings
 * Local account settings.
 */
export function handleAccountSettings(
  _req: IncomingMessage,
  res: ServerResponse,
  _config: OwlCodaConfig,
): void {
  sendJson(res, 200, {
    grove_enabled: false,
    grove_notice_viewed: true,
  })
}

/**
 * Local notice config.
 */
export function handleGroveConfig(
  _req: IncomingMessage,
  res: ServerResponse,
  _config: OwlCodaConfig,
): void {
  sendJson(res, 200, {
    show_notice: false,
    enabled: false,
  })
}
