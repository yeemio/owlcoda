/**
 * /v1/skill-stats API endpoint — skill injection observability.
 * GET /v1/skill-stats — returns injection statistics (hit rate, top skills, timing)
 * DELETE /v1/skill-stats — reset all stats
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { getSkillStats, resetSkillStats } from '../skills/stats.js'

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

/**
 * Handle /v1/skill-stats requests.
 */
export async function handleSkillStats(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method?.toUpperCase() ?? 'GET'

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS')

  if (method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (method === 'GET') {
    sendJson(res, 200, getSkillStats())
    return
  }

  if (method === 'DELETE') {
    resetSkillStats()
    sendJson(res, 200, { status: 'reset' })
    return
  }

  res.writeHead(405, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Method not allowed' } }))
}
