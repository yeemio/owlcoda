import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { handleSkills } from '../src/endpoints/skills.js'
import { saveSkill } from '../src/skills/store.js'
import { _resetIndex } from '../src/skills/injection.js'
import type { SkillDocument } from '../src/skills/schema.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'

// ─── Mock HTTP helpers ───

function mockReq(method: string, url: string, body?: string): IncomingMessage {
  const socket = new Socket()
  const req = new IncomingMessage(socket)
  req.method = method
  req.url = url
  if (body) {
    process.nextTick(() => {
      req.push(Buffer.from(body))
      req.push(null)
    })
  } else {
    process.nextTick(() => req.push(null))
  }
  return req
}

function mockRes(): ServerResponse & { _body: string; _status: number } {
  const socket = new Socket()
  const res = new ServerResponse(new IncomingMessage(socket)) as ServerResponse & { _body: string; _status: number }
  res._body = ''
  res._status = 200
  const origWriteHead = res.writeHead.bind(res)
  res.writeHead = function (status: number, ...args: unknown[]) {
    res._status = status
    return origWriteHead(status, ...args as [Record<string, string>])
  } as typeof res.writeHead
  const origEnd = res.end.bind(res)
  res.end = function (data?: unknown) {
    if (typeof data === 'string') res._body = data
    else if (Buffer.isBuffer(data)) res._body = data.toString()
    return origEnd()
  } as typeof res.end
  return res
}

function parseBody(res: { _body: string }): unknown {
  return JSON.parse(res._body)
}

// ─── Fixture ───

function makeSkill(id: string): SkillDocument {
  return {
    id,
    name: `Skill ${id}`,
    description: `Description for ${id}`,
    procedure: [{ order: 1, action: 'Step 1' }],
    pitfalls: [],
    verification: [],
    tags: ['test'],
    whenToUse: 'When testing',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    useCount: 0,
    synthesisMode: 'template',
  }
}

// ─── Tests ───

describe('skills endpoint', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'owlcoda-skills-api-'))
    process.env.OWLCODA_HOME = tmpDir
    _resetIndex()
  })

  afterEach(async () => {
    delete process.env.OWLCODA_HOME
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('GET /v1/skills returns empty list initially', async () => {
    const req = mockReq('GET', '/v1/skills')
    const res = mockRes()
    await handleSkills(req, res)
    const body = parseBody(res) as { skills: unknown[]; count: number }
    expect(res._status).toBe(200)
    expect(body.count).toBe(0)
    expect(body.skills).toEqual([])
  })

  it('POST /v1/skills creates a skill', async () => {
    const skill = makeSkill('test-skill')
    const req = mockReq('POST', '/v1/skills', JSON.stringify(skill))
    const res = mockRes()
    await handleSkills(req, res)
    const body = parseBody(res) as { status: string; skill: { id: string } }
    expect(res._status).toBe(201)
    expect(body.status).toBe('saved')
    expect(body.skill.id).toBe('test-skill')
  })

  it('GET /v1/skills lists created skills', async () => {
    await saveSkill(makeSkill('alpha-skill'))
    await saveSkill(makeSkill('beta-skill'))

    const req = mockReq('GET', '/v1/skills')
    const res = mockRes()
    await handleSkills(req, res)
    const body = parseBody(res) as { count: number }
    expect(body.count).toBe(2)
  })

  it('GET /v1/skills/:id returns a specific skill', async () => {
    await saveSkill(makeSkill('test-skill'))

    const req = mockReq('GET', '/v1/skills/test-skill')
    const res = mockRes()
    await handleSkills(req, res)
    const body = parseBody(res) as { skill: { id: string }; markdown: string }
    expect(res._status).toBe(200)
    expect(body.skill.id).toBe('test-skill')
    expect(body.markdown).toContain('Skill test-skill')
  })

  it('GET /v1/skills/:id returns 404 for missing', async () => {
    const req = mockReq('GET', '/v1/skills/nonexistent')
    const res = mockRes()
    await handleSkills(req, res)
    expect(res._status).toBe(404)
  })

  it('DELETE /v1/skills/:id deletes a skill', async () => {
    await saveSkill(makeSkill('doomed-skill'))

    const req = mockReq('DELETE', '/v1/skills/doomed-skill')
    const res = mockRes()
    await handleSkills(req, res)
    const body = parseBody(res) as { status: string; id: string }
    expect(res._status).toBe(200)
    expect(body.status).toBe('deleted')

    // Verify gone
    const req2 = mockReq('GET', '/v1/skills/doomed-skill')
    const res2 = mockRes()
    await handleSkills(req2, res2)
    expect(res2._status).toBe(404)
  })

  it('DELETE /v1/skills/:id returns 404 for missing', async () => {
    const req = mockReq('DELETE', '/v1/skills/ghost-skill')
    const res = mockRes()
    await handleSkills(req, res)
    expect(res._status).toBe(404)
  })

  it('POST /v1/skills rejects invalid JSON', async () => {
    const req = mockReq('POST', '/v1/skills', 'not json')
    const res = mockRes()
    await handleSkills(req, res)
    expect(res._status).toBe(400)
  })

  it('POST /v1/skills rejects missing name', async () => {
    const req = mockReq('POST', '/v1/skills', '{"description":"no name"}')
    const res = mockRes()
    await handleSkills(req, res)
    expect(res._status).toBe(400)
  })

  it('POST /v1/skills auto-generates ID from name', async () => {
    const req = mockReq('POST', '/v1/skills', JSON.stringify({
      name: 'Fix TypeScript Config',
      description: 'Auto ID test',
      tags: ['test'],
    }))
    const res = mockRes()
    await handleSkills(req, res)
    const body = parseBody(res) as { skill: { id: string } }
    expect(res._status).toBe(201)
    expect(body.skill.id).toBe('fix-typescript-config')
  })

  it('OPTIONS returns 204', async () => {
    const req = mockReq('OPTIONS', '/v1/skills')
    const res = mockRes()
    await handleSkills(req, res)
    expect(res._status).toBe(204)
  })
})
