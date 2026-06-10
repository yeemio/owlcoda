import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createProjectMapTool } from '../../../src/native/tools/project-map.js'
import { createRunWorkspace } from '../../../src/native/run-workspace.js'
import { NATIVE_TOOL_SCHEMAS } from '../../../src/native/tool-defs.js'

describe('ProjectMap native tool', () => {
  let tempDir = ''
  let previousAllowFsRoots: string | undefined

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'owlcoda-project-map-tool-'))
    previousAllowFsRoots = process.env['OWLCODA_ALLOW_FS_ROOTS']
    process.env['OWLCODA_ALLOW_FS_ROOTS'] = tempDir
    await writeFile(join(tempDir, 'AGENTS.md'), 'project rules', 'utf8')
    await mkdir(join(tempDir, 'src'), { recursive: true })
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({
      name: 'tool-fixture',
      version: '1.0.0',
      scripts: { test: 'vitest run' },
    }, null, 2), 'utf8')
  })

  afterEach(async () => {
    if (previousAllowFsRoots === undefined) delete process.env['OWLCODA_ALLOW_FS_ROOTS']
    else process.env['OWLCODA_ALLOW_FS_ROOTS'] = previousAllowFsRoots
    await rm(tempDir, { recursive: true, force: true })
  })

  it('exposes a schema for scan/show/refresh actions', () => {
    const schema = NATIVE_TOOL_SCHEMAS['ProjectMap']!
    const properties = schema.properties as Record<string, unknown>
    const action = properties['action'] as { enum: string[] }
    expect(schema.required).toEqual(['action'])
    expect(action.enum).toEqual(['scan', 'show', 'refresh'])
    expect(properties['cwd']).toBeDefined()
    expect(properties['runRef']).toBeDefined()
  })

  it('scans the current project without requiring a run workspace', async () => {
    const result = await createProjectMapTool().execute({ action: 'scan', cwd: tempDir })

    expect(result.isError).toBe(false)
    const payload = JSON.parse(result.output)
    expect(payload.packageName).toBe('tool-fixture')
    expect(payload.sourceFiles.map((source: { kind: string }) => source.kind)).toContain('AGENTS.md')
    expect(payload.verificationProfiles[0].commands).toEqual(['npm test'])
  })

  it('refresh persists project-map.json and show reads it back', async () => {
    const outputRoot = join(tempDir, 'out')
    await createRunWorkspace({ outputRoot, cwd: tempDir, runId: 'run-project-map' })

    const refreshed = await createProjectMapTool().execute({
      action: 'refresh',
      cwd: tempDir,
      runRef: outputRoot,
    })

    expect(refreshed.isError).toBe(false)
    const projectMapPath = join(outputRoot, '.owlcoda-run', 'project-map.json')
    expect(existsSync(projectMapPath)).toBe(true)
    expect(JSON.parse(await readFile(projectMapPath, 'utf8')).packageName).toBe('tool-fixture')

    const shown = await createProjectMapTool().execute({ action: 'show', cwd: tempDir, runRef: outputRoot })
    expect(shown.isError).toBe(false)
    expect(JSON.parse(shown.output)).toMatchObject({
      packageName: 'tool-fixture',
      freshness: { status: 'fresh' },
    })
  })

  it('keeps scan read-only even when a runRef is supplied', async () => {
    const outputRoot = join(tempDir, 'scan-out')
    await createRunWorkspace({ outputRoot, cwd: tempDir, runId: 'run-project-map-scan' })
    const projectMapPath = join(outputRoot, '.owlcoda-run', 'project-map.json')
    await rm(projectMapPath, { force: true })

    const result = await createProjectMapTool().execute({
      action: 'scan',
      cwd: tempDir,
      runRef: outputRoot,
    })

    expect(result.isError).toBe(false)
    expect(JSON.parse(result.output).packageName).toBe('tool-fixture')
    expect(existsSync(projectMapPath)).toBe(false)
  })
})
