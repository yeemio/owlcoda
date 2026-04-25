/**
 * Training data API endpoint — /v1/training
 *
 * GET  /v1/training/status  — collection stats + manifest
 * POST /v1/training/clear   — clear collected data
 * GET  /v1/training/export  — stream collected JSONL
 */

import type * as http from 'node:http'
import { readFile, rm, stat } from 'node:fs/promises'
import { logWarn } from '../logger.js'
import { join } from 'node:path'

function trainingDir(): string {
  return join(process.env.OWLCODA_HOME ?? join(process.env.HOME ?? '/tmp', '.owlcoda'), 'training')
}

export async function handleTraining(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  action: string,
): Promise<void> {
  const dir = trainingDir()

  switch (action) {
    case 'status': {
      try {
        const manifestRaw = await readFile(join(dir, 'manifest.json'), 'utf-8')
        const manifest = JSON.parse(manifestRaw)
        const filePath = join(dir, 'collected.jsonl')
        let fileSize = 0
        let lineCount = 0
        try {
          const s = await stat(filePath)
          fileSize = s.size
          const content = await readFile(filePath, 'utf-8')
          lineCount = content.trim().split('\n').filter(l => l.trim()).length
        } catch { /* file may not exist */ }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ...manifest, fileSize, lineCount, path: filePath }))
      } catch (e) {
        logWarn('training', `Failed to read training status: ${e}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          totalCollected: 0, totalSkipped: 0, lastCollectedAt: null,
          averageQuality: 0, fileSize: 0, lineCount: 0,
          path: join(dir, 'collected.jsonl'),
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
        await rm(join(dir, 'collected.jsonl'), { force: true })
        await rm(join(dir, 'manifest.json'), { force: true })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ cleared: true }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: String(err), type: 'server_error' } }))
      }
      return
    }

    case 'export': {
      try {
        const filePath = join(dir, 'collected.jsonl')
        const content = await readFile(filePath, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
        res.end(content)
      } catch (e) {
        logWarn('training', `Failed to export training data: ${e}`)
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
        res.end('')
      }
      return
    }

    default: {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `Unknown action: ${action}. Use status, clear, or export.`, type: 'invalid_request_error' } }))
    }
  }
}
