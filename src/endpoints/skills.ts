/**
 * /v1/skills API endpoint — CRUD for learned skills.
 * GET /v1/skills — list all skills (metadata)
 * GET /v1/skills/:id — get full skill document
 * POST /v1/skills — create/update a skill (accepts SkillDocument JSON)
 * DELETE /v1/skills/:id — delete a skill
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  loadSkill,
  listSkills,
  saveSkill,
  deleteSkill,
} from '../skills/store.js'
import { toMetadata, renderSkillMd, isValidSkillId, nameToId } from '../skills/schema.js'
import type { SkillDocument } from '../skills/schema.js'
import { invalidateSkillIndex } from '../skills/injection.js'

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { type: 'error', error: { type: 'invalid_request_error', message } })
}

/**
 * Handle /v1/skills requests.
 */
export async function handleSkills(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method?.toUpperCase() ?? 'GET'
  const url = req.url ?? ''

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')

  if (method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // Parse skill ID from URL: /v1/skills/:id
  const idMatch = url.match(/^\/v1\/skills\/([a-z0-9][a-z0-9-]+[a-z0-9])$/)
  const skillId = idMatch?.[1] ?? null

  try {
    // GET /v1/skills — list all
    if (method === 'GET' && !skillId) {
      const skills = await listSkills()
      sendJson(res, 200, {
        skills,
        count: skills.length,
      })
      return
    }

    // GET /v1/skills/:id — get one
    if (method === 'GET' && skillId) {
      const skill = await loadSkill(skillId)
      if (!skill) {
        sendError(res, 404, `Skill '${skillId}' not found`)
        return
      }
      sendJson(res, 200, {
        skill,
        markdown: renderSkillMd(skill),
      })
      return
    }

    // POST /v1/skills — create/update
    if (method === 'POST') {
      const raw = await readBody(req)
      let body: Record<string, unknown>
      try {
        body = JSON.parse(raw)
      } catch {
        sendError(res, 400, 'Invalid JSON in request body')
        return
      }

      // Validate required fields
      const name = body.name as string
      if (!name || typeof name !== 'string') {
        sendError(res, 400, 'Missing required field: name')
        return
      }

      const id = body.id as string ?? nameToId(name)
      if (!isValidSkillId(id)) {
        sendError(res, 400, `Invalid skill ID: '${id}'`)
        return
      }

      const skill: SkillDocument = {
        id,
        name,
        description: String(body.description ?? ''),
        procedure: Array.isArray(body.procedure) ? body.procedure as SkillDocument['procedure'] : [],
        pitfalls: Array.isArray(body.pitfalls) ? body.pitfalls as SkillDocument['pitfalls'] : [],
        verification: Array.isArray(body.verification) ? body.verification as SkillDocument['verification'] : [],
        tags: Array.isArray(body.tags) ? (body.tags as string[]).map(String) : [],
        whenToUse: String(body.whenToUse ?? ''),
        createdFrom: body.createdFrom as string | undefined,
        createdAt: body.createdAt as string ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        useCount: typeof body.useCount === 'number' ? body.useCount : 0,
        synthesisMode: (body.synthesisMode as SkillDocument['synthesisMode']) ?? 'manual',
      }

      await saveSkill(skill)
      invalidateSkillIndex()
      sendJson(res, 201, { skill: toMetadata(skill), status: 'saved' })
      return
    }

    // DELETE /v1/skills/:id — delete
    if (method === 'DELETE' && skillId) {
      const deleted = await deleteSkill(skillId)
      if (!deleted) {
        sendError(res, 404, `Skill '${skillId}' not found`)
        return
      }
      invalidateSkillIndex()
      sendJson(res, 200, { status: 'deleted', id: skillId })
      return
    }

    sendError(res, 405, `Method ${method} not allowed on ${url}`)
  } catch (err) {
    sendError(res, 500, `Internal error: ${err instanceof Error ? err.message : 'unknown'}`)
  }
}
