import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rm, access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createTeamCreateTool } from '../../../src/native/tools/team-create.js'

const TEAM_NAME = `test-team-${Date.now()}`
const teamDir = join(homedir(), '.owlcoda', 'teams', TEAM_NAME)
const taskDir = join(homedir(), '.owlcoda', 'tasks', TEAM_NAME)

describe('TeamCreate tool', () => {
  const tool = createTeamCreateTool()

  afterEach(async () => {
    await rm(teamDir, { recursive: true, force: true }).catch(() => {})
    await rm(taskDir, { recursive: true, force: true }).catch(() => {})
  })

  it('has correct name', () => {
    expect(tool.name).toBe('TeamCreate')
  })

  it('creates team and task directories', async () => {
    const r = await tool.execute({ team_name: TEAM_NAME, description: 'Test team' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain(TEAM_NAME)

    // Verify directories exist
    await access(teamDir)
    await access(taskDir)

    // Verify config
    const config = JSON.parse(await readFile(join(teamDir, 'config.json'), 'utf-8'))
    expect(config.name).toBe(TEAM_NAME)
    expect(config.description).toBe('Test team')
  })

  it('rejects duplicate team', async () => {
    await tool.execute({ team_name: TEAM_NAME })
    const r = await tool.execute({ team_name: TEAM_NAME })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('already exists')
  })

  it('rejects invalid team name', async () => {
    const r = await tool.execute({ team_name: 'bad name!' })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('invalid')
  })

  it('requires team_name', async () => {
    const r = await tool.execute({ team_name: '' })
    expect(r.isError).toBe(true)
  })
})
