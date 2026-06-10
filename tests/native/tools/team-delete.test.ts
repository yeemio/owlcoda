import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rm, mkdir, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createTeamDeleteTool } from '../../../src/native/tools/team-delete.js'

const TEAM_NAME = `test-delete-${Date.now()}`
const teamDir = join(homedir(), '.owlcoda', 'teams', TEAM_NAME)
const taskDir = join(homedir(), '.owlcoda', 'tasks', TEAM_NAME)

async function createTeamFixture(members: string[] = []): Promise<void> {
  await mkdir(teamDir, { recursive: true })
  await mkdir(taskDir, { recursive: true })
  await writeFile(
    join(teamDir, 'config.json'),
    JSON.stringify({ name: TEAM_NAME, members }),
    'utf-8',
  )
}

describe('TeamDelete tool', () => {
  const tool = createTeamDeleteTool()

  afterEach(async () => {
    await rm(teamDir, { recursive: true, force: true }).catch(() => {})
    await rm(taskDir, { recursive: true, force: true }).catch(() => {})
  })

  it('has correct name', () => {
    expect(tool.name).toBe('TeamDelete')
  })

  it('deletes an empty team', async () => {
    await createTeamFixture()
    const r = await tool.execute({ team_name: TEAM_NAME })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('Deleted')

    // Verify gone
    await expect(access(teamDir)).rejects.toThrow()
    await expect(access(taskDir)).rejects.toThrow()
  })

  it('refuses to delete team with members', async () => {
    await createTeamFixture(['agent-1', 'agent-2'])
    const r = await tool.execute({ team_name: TEAM_NAME })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('active member')
  })

  it('returns error for nonexistent team', async () => {
    const r = await tool.execute({ team_name: 'nonexistent-team-xyz' })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('not found')
  })

  it('requires team_name', async () => {
    const r = await tool.execute({ team_name: '' })
    expect(r.isError).toBe(true)
  })
})
