/**
 * Training data API endpoint — /v1/training
 *
 * GET  /v1/training/status  — collection stats + manifest
 * POST /v1/training/clear   — clear collected data
 * GET  /v1/training/export  — stream collected JSONL
 */

import type * as http from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import { logWarn } from '../logger.js'
import {
  getCollectedPath,
  getManifestPath,
  readCollectedStatus,
} from '../data/training-store.js'

export async function handleTraining(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  action: string,
): Promise<void> {
  switch (action) {
    case 'status': {
      try {
        const status = await readCollectedStatus()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(status))
      } catch (e) {
        logWarn('training', `Failed to read training status: ${e}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          totalCollected: 0, totalSkipped: 0, lastCollectedAt: null,
          averageQuality: 0, fileSize: 0, lineCount: 0,
          path: getCollectedPath(), manifestPresent: false,
        }))
      }
      return
    }

    case 'clear': {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Use POST to clear', type: 'invalid_request_error' } }))
        return
      }
      try {
        await rm(getCollectedPath(), { force: true })
        await rm(getManifestPath(), { force: true })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ cleared: true }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: String(err), type: 'server_error' } }))
      }
      return
    }

    case 'export': {
      // Prefer streaming for the real ServerResponse path (collected.jsonl
      // can be hundreds of MB). Fall back to a readFile+end shape when the
      // response object is a synthetic test double that lacks the writable
      // stream interface required by pipe().
      const filePath = getCollectedPath()
      try {
        await stat(filePath)
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
        res.end('')
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      const canPipe = typeof (res as unknown as { on?: unknown }).on === 'function'
      if (canPipe) {
        const stream = createReadStream(filePath)
        stream.on('error', e => {
          logWarn('training', `Failed to stream training export: ${e}`)
          if (!res.writableEnded) res.end()
        })
        stream.pipe(res)
      } else {
        try {
          const content = await readFile(filePath, 'utf-8')
          res.end(content)
        } catch (e) {
          logWarn('training', `Failed to read training export: ${e}`)
          res.end('')
        }
      }
      return
    }

    default: {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `Unknown action: ${action}. Use status, clear, or export.`, type: 'invalid_request_error' } }))
    }
  }
}
