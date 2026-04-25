/**
 * Skill stats + observability tests.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { recordInjection, getSkillStats, resetSkillStats } from '../src/skills/stats.js'

beforeEach(() => {
  resetSkillStats()
})

describe('skill stats', () => {
  it('starts with zero counters', () => {
    const s = getSkillStats()
    expect(s.totalQueries).toBe(0)
    expect(s.hits).toBe(0)
    expect(s.misses).toBe(0)
    expect(s.hitRate).toBe(0)
    expect(s.avgMatchMs).toBe(0)
    expect(s.topSkills).toEqual([])
    expect(s.lastQueryAt).toBeNull()
  })

  it('records a miss', () => {
    recordInjection([], 5)
    const s = getSkillStats()
    expect(s.totalQueries).toBe(1)
    expect(s.hits).toBe(0)
    expect(s.misses).toBe(1)
    expect(s.hitRate).toBe(0)
    expect(s.avgMatchMs).toBe(5)
    expect(s.lastQueryAt).toBeTruthy()
  })

  it('records a hit with matched IDs', () => {
    recordInjection(['skill-a', 'skill-b'], 10)
    const s = getSkillStats()
    expect(s.totalQueries).toBe(1)
    expect(s.hits).toBe(1)
    expect(s.misses).toBe(0)
    expect(s.hitRate).toBe(1)
    expect(s.topSkills).toHaveLength(2)
    expect(s.topSkills[0].id).toBe('skill-a')
    expect(s.topSkills[0].count).toBe(1)
  })

  it('accumulates counts across multiple injections', () => {
    recordInjection(['skill-a'], 8)
    recordInjection(['skill-a', 'skill-b'], 12)
    recordInjection([], 3)

    const s = getSkillStats()
    expect(s.totalQueries).toBe(3)
    expect(s.hits).toBe(2)
    expect(s.misses).toBe(1)
    expect(s.hitRate).toBeCloseTo(2 / 3)
    expect(s.avgMatchMs).toBeCloseTo((8 + 12 + 3) / 3)
    expect(s.topSkills[0].id).toBe('skill-a')
    expect(s.topSkills[0].count).toBe(2)
    expect(s.topSkills[1].id).toBe('skill-b')
    expect(s.topSkills[1].count).toBe(1)
  })

  it('limits top skills to 10', () => {
    for (let i = 0; i < 15; i++) {
      recordInjection([`skill-${i}`], 1)
    }
    const s = getSkillStats()
    expect(s.topSkills).toHaveLength(10)
  })

  it('sorts top skills by count descending', () => {
    recordInjection(['rare'], 1)
    for (let i = 0; i < 5; i++) {
      recordInjection(['popular'], 1)
    }
    recordInjection(['medium'], 1)
    recordInjection(['medium'], 1)

    const s = getSkillStats()
    expect(s.topSkills[0].id).toBe('popular')
    expect(s.topSkills[0].count).toBe(5)
    expect(s.topSkills[1].id).toBe('medium')
    expect(s.topSkills[1].count).toBe(2)
    expect(s.topSkills[2].id).toBe('rare')
    expect(s.topSkills[2].count).toBe(1)
  })

  it('resets all counters', () => {
    recordInjection(['skill-a'], 10)
    recordInjection([], 5)
    resetSkillStats()

    const s = getSkillStats()
    expect(s.totalQueries).toBe(0)
    expect(s.hits).toBe(0)
    expect(s.topSkills).toEqual([])
    expect(s.lastQueryAt).toBeNull()
  })
})

describe('skill-stats endpoint', () => {
  it('handleSkillStats returns stats on GET', async () => {
    const { handleSkillStats } = await import('../src/endpoints/skill-stats.js')

    // Record some stats first
    recordInjection(['test-skill'], 15)

    const chunks: Buffer[] = []
    let statusCode = 0
    const headers: Record<string, string> = {}

    const req = { method: 'GET', url: '/v1/skill-stats' } as any
    const res = {
      writeHead: (s: number, h: Record<string, string>) => { statusCode = s; Object.assign(headers, h) },
      end: (data: string) => { chunks.push(Buffer.from(data)) },
      setHeader: (k: string, v: string) => { headers[k] = v },
      headersSent: false,
    } as any

    await handleSkillStats(req, res)
    expect(statusCode).toBe(200)

    const body = JSON.parse(chunks.map(c => c.toString()).join(''))
    expect(body.totalQueries).toBe(1)
    expect(body.hits).toBe(1)
    expect(body.topSkills[0].id).toBe('test-skill')
  })

  it('handleSkillStats resets on DELETE', async () => {
    const { handleSkillStats } = await import('../src/endpoints/skill-stats.js')

    recordInjection(['x'], 1)

    let statusCode = 0
    const headers: Record<string, string> = {}
    let body = ''

    const req = { method: 'DELETE', url: '/v1/skill-stats' } as any
    const res = {
      writeHead: (s: number, h: Record<string, string>) => { statusCode = s; Object.assign(headers, h) },
      end: (data: string) => { body = data },
      setHeader: (k: string, v: string) => { headers[k] = v },
      headersSent: false,
    } as any

    await handleSkillStats(req, res)
    expect(statusCode).toBe(200)
    expect(JSON.parse(body).status).toBe('reset')

    const s = getSkillStats()
    expect(s.totalQueries).toBe(0)
  })
})
