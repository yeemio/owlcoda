import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunWorkspaceTool } from '../../../src/native/tools/run-workspace.js'
import { NATIVE_TOOL_SCHEMAS } from '../../../src/native/tool-defs.js'

describe('RunWorkspace native tool', () => {
  let tempDir = ''
  let previousAllowFsRoots: string | undefined

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'owlcoda-native-run-workspace-'))
    previousAllowFsRoots = process.env['OWLCODA_ALLOW_FS_ROOTS']
    process.env['OWLCODA_ALLOW_FS_ROOTS'] = tempDir
  })

  afterEach(async () => {
    if (previousAllowFsRoots === undefined) delete process.env['OWLCODA_ALLOW_FS_ROOTS']
    else process.env['OWLCODA_ALLOW_FS_ROOTS'] = previousAllowFsRoots
    await rm(tempDir, { recursive: true, force: true })
  })

  it('exposes schemas for core actions and inputs', () => {
    const schema = NATIVE_TOOL_SCHEMAS['RunWorkspace']!
    const properties = schema.properties as Record<string, unknown>
    const action = properties['action'] as { enum: string[] }
    expect(schema.required).toEqual(['action'])
    expect(action.enum).toContain('writeCheckpoint')
    expect(action.enum).toContain('readCheckpoint')
    expect(properties['outputRoot']).toBeDefined()
    expect(properties['runRef']).toBeDefined()
    expect(properties['origin']).toBeDefined()
    expect(properties['environment']).toBeDefined()
    expect(properties['project']).toBeDefined()
    expect(properties['jobId']).toBeDefined()
    expect(properties['artifactType']).toBeDefined()
    expect(properties['status']).toBeDefined()
    expect(properties['checkpoint']).toBeDefined()
  })

  it('creates metadata, records artifacts, refreshes the ledger, and records events', async () => {
    const tool = createRunWorkspaceTool()
    const outputRoot = join(tempDir, 'deck-output')
    const created = await tool.execute({
      action: 'create',
      outputRoot,
      cwd: tempDir,
      taskFamily: 'deck',
      deliverableMode: 'file_artifact_delivery',
      skillRoute: { selectedSkill: 'guizang-ppt-skill' },
      plan: { steps: [{ id: 'write-deck' }] },
      verification: { checks: [] },
    })

    expect(created.isError).toBe(false)
    const createPayload = JSON.parse(created.output) as { paths: { runDir: string }; manifest: { runId: string } }
    expect(createPayload.paths.runDir).toBe(join(outputRoot, '.owlcoda-run'))
    expect(existsSync(join(outputRoot, '.owlcoda-run', 'manifest.json'))).toBe(true)
    expect(existsSync(join(outputRoot, 'stage'))).toBe(true)
    expect(existsSync(join(outputRoot, 'final'))).toBe(true)
    expect(existsSync(join(outputRoot, 'assets'))).toBe(true)
    expect(existsSync(join(outputRoot, 'scripts'))).toBe(true)
    expect(existsSync(join(outputRoot, 'evidence'))).toBe(true)
    expect(existsSync(join(outputRoot, 'notes'))).toBe(true)
    expect(existsSync(join(outputRoot, '.owlcoda-run', 'checkpoint.json'))).toBe(true)

    const deckPath = join(outputRoot, 'deck.html')
    await writeFile(deckPath, '<!doctype html><title>Deck</title><section>one</section>\n', 'utf8')
    const artifact = await tool.execute({
      action: 'recordArtifact',
      runRef: outputRoot,
      path: 'deck.html',
      origin: 'write',
      environment: 'dogfood',
      project: 'owlcoda-platform',
      jobId: 'job-browser-1',
      artifactType: 'html_deck',
      stepId: 'write-deck',
      participatesInFinal: true,
    })

    expect(artifact.isError).toBe(false)
    expect(JSON.parse(artifact.output)).toMatchObject({
      path: deckPath,
      origin: 'write',
      environment: 'dogfood',
      project: 'owlcoda-platform',
      runId: createPayload.manifest.runId,
      jobId: 'job-browser-1',
      artifactType: 'html_deck',
      status: 'present',
      stepId: 'write-deck',
      participatesInFinal: true,
    })

    const ledger = await tool.execute({ action: 'readLedger', runRef: outputRoot })
    expect(ledger.isError).toBe(false)
    expect(JSON.parse(ledger.output).artifacts).toHaveLength(1)

    await unlink(deckPath)
    const refreshed = await tool.execute({ action: 'refreshLedger', runRef: outputRoot })
    expect(refreshed.isError).toBe(false)
    expect(JSON.parse(refreshed.output).artifacts[0]).toMatchObject({
      status: 'missing',
      environment: 'dogfood',
      project: 'owlcoda-platform',
      runId: createPayload.manifest.runId,
      jobId: 'job-browser-1',
      artifactType: 'html_deck',
    })

    const event = await tool.execute({
      action: 'recordEvent',
      runRef: outputRoot,
      type: 'verification_failed',
      stepId: 'verify-deck',
      data: { packId: 'html_deck' },
    })
    expect(event.isError).toBe(false)
    expect(JSON.parse(event.output)).toMatchObject({
      runId: createPayload.manifest.runId,
      type: 'verification_failed',
      stepId: 'verify-deck',
    })
    const eventLines = (await readFile(join(outputRoot, '.owlcoda-run', 'events.jsonl'), 'utf8')).trim().split('\n')
    expect(eventLines).toHaveLength(1)
  })

  it('resolves omitted runRef from the active task run workspace', async () => {
    const tool = createRunWorkspaceTool()
    const outputRoot = join(tempDir, 'active-run')
    const created = await tool.execute({ action: 'create', outputRoot, cwd: tempDir })
    const runDir = JSON.parse(created.output).paths.runDir as string
    await writeFile(join(outputRoot, 'report.md'), '# Report\n', 'utf8')

    const result = await tool.execute({
      action: 'recordArtifact',
      path: 'report.md',
      origin: 'write',
      cwd: tempDir,
    }, {
      taskState: {
        contract: { cwd: tempDir, allowedWritePaths: [] },
        run: { runWorkspace: { runDir } },
      } as any,
    })

    expect(result.isError).toBe(false)
    expect(JSON.parse(result.output).path).toBe(join(outputRoot, 'report.md'))
  })

  it('filters artifact ledger reads by runtime metadata', async () => {
    const tool = createRunWorkspaceTool()
    const outputRoot = join(tempDir, 'filtered-output')
    await tool.execute({ action: 'create', outputRoot, cwd: tempDir })

    await writeFile(join(outputRoot, 'browser-a.html'), '<html>A</html>\n', 'utf8')
    await writeFile(join(outputRoot, 'browser-b.html'), '<html>B</html>\n', 'utf8')
    await tool.execute({
      action: 'recordArtifact',
      runRef: outputRoot,
      path: 'browser-a.html',
      origin: 'manual',
      environment: 'dogfood',
      project: 'owlcoda-platform',
      jobId: 'job:browser:a',
      artifactType: 'browser_html',
      status: 'present',
    })
    await tool.execute({
      action: 'recordArtifact',
      runRef: outputRoot,
      path: 'browser-b.html',
      origin: 'manual',
      environment: 'ci',
      project: 'owlcoda-platform',
      jobId: 'job:browser:b',
      artifactType: 'browser_html',
      status: 'present',
    })

    const byJob = await tool.execute({ action: 'readLedger', runRef: outputRoot, jobId: 'job:browser:a' })
    expect(byJob.isError).toBe(false)
    expect(JSON.parse(byJob.output)).toMatchObject({
      artifactCount: 1,
      filters: { jobId: 'job:browser:a' },
      ledger: {
        artifacts: [expect.objectContaining({
          jobId: 'job:browser:a',
          environment: 'dogfood',
          artifactType: 'browser_html',
        })],
      },
    })

    const byEnvironment = await tool.execute({ action: 'readLedger', runRef: outputRoot, environment: 'ci' })
    expect(byEnvironment.isError).toBe(false)
    const payload = JSON.parse(byEnvironment.output)
    expect(payload.artifactCount).toBe(1)
    expect(payload.ledger.artifacts[0]).toMatchObject({
      jobId: 'job:browser:b',
      environment: 'ci',
    })
  })

  it('writes and reads checkpoint metadata', async () => {
    const tool = createRunWorkspaceTool()
    const outputRoot = join(tempDir, 'checkpoint-output')
    await tool.execute({ action: 'create', outputRoot, cwd: tempDir })

    const checkpoint = {
      currentStepId: 'step-2',
      completedStepIds: ['step-1'],
      notes: { status: 'drafting' },
    }

    const written = await tool.execute({
      action: 'writeCheckpoint',
      runRef: outputRoot,
      checkpoint,
    })
    expect(written.isError).toBe(false)
    expect(JSON.parse(written.output)).toEqual(checkpoint)

    const read = await tool.execute({ action: 'readCheckpoint', runRef: outputRoot })
    expect(read.isError).toBe(false)
    expect(JSON.parse(read.output)).toEqual(checkpoint)
  })

  it('records skill asset copy source without writing the copied artifact itself', async () => {
    const tool = createRunWorkspaceTool()
    const outputRoot = join(tempDir, 'asset-output')
    await tool.execute({ action: 'create', outputRoot, cwd: tempDir })
    await mkdir(join(outputRoot, 'assets'), { recursive: true })
    await writeFile(join(outputRoot, 'assets', 'template.html'), '<template></template>\n', 'utf8')

    const result = await tool.execute({
      action: 'recordArtifact',
      runRef: outputRoot,
      path: 'assets/template.html',
      origin: 'skill_asset_copy',
      sourcePath: join(tempDir, 'skill', 'assets', 'template.html'),
      participatesInFinal: false,
    })

    expect(result.isError).toBe(false)
    expect(JSON.parse(result.output)).toMatchObject({
      origin: 'skill_asset_copy',
      participatesInFinal: false,
      sourcePath: join(tempDir, 'skill', 'assets', 'template.html'),
    })
  })

  it('rejects invalid actions before touching the filesystem', async () => {
    const outputRoot = join(tempDir, 'should-not-exist')
    const result = await createRunWorkspaceTool().execute({ action: 'shell', outputRoot })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('action is required')
    expect(existsSync(outputRoot)).toBe(false)
  })

  it('applies fs-policy before creating metadata outside allowed roots', async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'owlcoda-native-run-workspace-outside-'))
    await rm(outsideRoot, { recursive: true, force: true })

    const result = await createRunWorkspaceTool().execute({
      action: 'create',
      outputRoot: outsideRoot,
      cwd: tempDir,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('outside the allowed workspace')
    expect(existsSync(outsideRoot)).toBe(false)
  })

  it('rejects artifact paths that resolve outside the run output root', async () => {
    const tool = createRunWorkspaceTool()
    const outputRoot = join(tempDir, 'scope-output')
    await tool.execute({ action: 'create', outputRoot, cwd: tempDir })

    const result = await tool.execute({
      action: 'recordArtifact',
      runRef: outputRoot,
      path: join(tempDir, 'outside-deck.html'),
      origin: 'write',
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('outside run workspace outputRoot')
  })
})
