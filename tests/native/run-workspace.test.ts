import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRunWorkspace,
  getRunWorkspacePaths,
  readCheckpoint,
  readArtifactLedger,
  readManifest,
  recordArtifact,
  recordEvent,
  refreshArtifactLedger,
  writeCheckpoint,
  writePlan,
  writeSkillRoute,
  writeVerification,
} from '../../src/native/run-workspace.js'

describe('run workspace', () => {
  async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), prefix))
    try {
      return await fn(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('creates .owlcoda-run under an explicit output root with manifest and ledgers', async () => {
    await withTempDir('owlcoda-run-workspace-create-', async (dir) => {
      const outputRoot = join(dir, 'deck-output')
      const cwd = join(dir, 'workspace')
      const result = await createRunWorkspace({
        outputRoot,
        cwd,
        runId: 'run-test',
        createdAt: '2026-05-15T00:00:00.000Z',
        taskFamily: 'deck',
        deliverableMode: 'file_artifact_delivery',
      })

      expect(result.paths.runDir).toBe(join(outputRoot, '.owlcoda-run'))
      expect(existsSync(result.paths.manifestPath)).toBe(true)
      expect(existsSync(result.paths.skillRoutePath)).toBe(true)
      expect(existsSync(result.paths.planPath)).toBe(true)
      expect(existsSync(result.paths.artifactsPath)).toBe(true)
      expect(existsSync(result.paths.verificationPath)).toBe(true)
      expect(existsSync(result.paths.eventsPath)).toBe(true)
      expect(result.paths.checkpointPath).toBe(join(outputRoot, '.owlcoda-run', 'checkpoint.json'))
      expect(existsSync(result.paths.checkpointPath)).toBe(true)
      expect(existsSync(result.paths.stageDir)).toBe(true)
      expect(existsSync(result.paths.finalDir)).toBe(true)
      expect(existsSync(result.paths.assetsDir)).toBe(true)
      expect(existsSync(result.paths.scriptsDir)).toBe(true)
      expect(existsSync(result.paths.evidenceDir)).toBe(true)
      expect(existsSync(result.paths.notesDir)).toBe(true)

      const manifest = await readManifest(outputRoot)
      expect(manifest).toEqual({
        version: 1,
        structureVersion: 2,
        runId: 'run-test',
        createdAt: '2026-05-15T00:00:00.000Z',
        outputRoot,
        cwd,
        createdDirectories: ['stage', 'final', 'assets', 'scripts', 'evidence', 'notes'],
        taskFamily: 'deck',
        deliverableMode: 'file_artifact_delivery',
      })
      expect(await readCheckpoint(outputRoot)).toEqual({
        version: 1,
        updatedAt: '2026-05-15T00:00:00.000Z',
        status: 'initialized',
      })
    })
  })

  it('resolves a relative output root under cwd, not under the user home', async () => {
    await withTempDir('owlcoda-run-workspace-relative-', async (dir) => {
      await createRunWorkspace({
        outputRoot: 'out/model-connection-deck',
        cwd: dir,
        runId: 'run-relative',
      })

      const paths = getRunWorkspacePaths('out/model-connection-deck', dir)
      expect(paths.outputRoot).toBe(join(dir, 'out', 'model-connection-deck'))
      expect(existsSync(paths.manifestPath)).toBe(true)
      expect(existsSync(paths.stageDir)).toBe(true)
      expect(existsSync(paths.finalDir)).toBe(true)

      const manifest = await readManifest(paths.runDir)
      expect(manifest.outputRoot).toBe(paths.outputRoot)
      expect(manifest.cwd).toBe(dir)
      expect(manifest.structureVersion).toBe(2)
      expect(manifest.createdDirectories).toEqual(['stage', 'final', 'assets', 'scripts', 'evidence', 'notes'])
    })
  })

  it('writes skill route, plan, and verification json files', async () => {
    await withTempDir('owlcoda-run-workspace-json-', async (dir) => {
      const outputRoot = join(dir, 'out')
      const { paths } = await createRunWorkspace({ outputRoot, cwd: dir })

      await writeSkillRoute(outputRoot, {
        selectedSkill: 'guizang-ppt-skill',
        references: ['references/layouts.md'],
      })
      await writePlan(paths.runDir, { steps: [{ id: 'step-1', title: 'Write shell' }] })
      await writeVerification(paths.manifestPath, { results: [{ id: 'html-deck', passed: true }] })

      expect(JSON.parse(await readFile(paths.skillRoutePath, 'utf8'))).toMatchObject({
        selectedSkill: 'guizang-ppt-skill',
      })
      expect(JSON.parse(await readFile(paths.planPath, 'utf8')).steps).toHaveLength(1)
      expect(JSON.parse(await readFile(paths.verificationPath, 'utf8')).results[0].passed).toBe(true)
    })
  })

  it('writes and reads checkpoint json', async () => {
    await withTempDir('owlcoda-run-workspace-checkpoint-', async (dir) => {
      const outputRoot = join(dir, 'out')
      const { paths } = await createRunWorkspace({ outputRoot, cwd: dir })

      const checkpoint = {
        currentStepId: 'step-2',
        completedStepIds: ['step-1'],
        lastArtifactPath: join(outputRoot, 'stage', 'draft.html'),
      }

      await writeCheckpoint(outputRoot, checkpoint)

      expect(JSON.parse(await readFile(paths.checkpointPath, 'utf8'))).toEqual(checkpoint)
      await expect(readCheckpoint(paths.runDir)).resolves.toEqual(checkpoint)
    })
  })

  it('records artifact metadata with origin, step, and final participation', async () => {
    await withTempDir('owlcoda-run-workspace-artifact-', async (dir) => {
      const outputRoot = join(dir, 'out')
      const deckPath = join(outputRoot, 'deck.html')
      await createRunWorkspace({ outputRoot, cwd: dir, runId: 'run-artifact' })
      await writeFile(deckPath, '<!doctype html><section>one</section>\n', 'utf8')

      const record = await recordArtifact(outputRoot, {
        path: 'deck.html',
        origin: 'write',
        stepId: 'step-1',
        participatesInFinal: true,
      })

      expect(record.path).toBe(deckPath)
      expect(record.origin).toBe('write')
      expect(record.size).toBeGreaterThan(0)
      expect(record.mtime).toMatch(/^20/)
      expect(record.stepId).toBe('step-1')
      expect(record.participatesInFinal).toBe(true)
      expect(record.status).toBe('present')

      const ledger = await readArtifactLedger(outputRoot)
      expect(ledger.artifacts).toHaveLength(1)
      expect(ledger.artifacts[0]).toMatchObject({
        path: deckPath,
        origin: 'write',
        stepId: 'step-1',
        participatesInFinal: true,
        status: 'present',
      })
    })
  })

  it('records skill asset copy source and destination', async () => {
    await withTempDir('owlcoda-run-workspace-asset-', async (dir) => {
      const outputRoot = join(dir, 'out')
      const assetPath = join(outputRoot, 'assets', 'template.html')
      const sourcePath = join(dir, 'skill', 'assets', 'template.html')
      await createRunWorkspace({ outputRoot, cwd: dir })
      await mkdir(join(outputRoot, 'assets'), { recursive: true })
      await writeFile(assetPath, '<template></template>\n', 'utf8')

      const record = await recordArtifact(outputRoot, {
        path: assetPath,
        origin: 'skill_asset_copy',
        sourcePath,
        participatesInFinal: false,
      })

      expect(record.origin).toBe('skill_asset_copy')
      expect(record.sourcePath).toBe(sourcePath)
      expect(record.participatesInFinal).toBe(false)
    })
  })

  it('appends events as jsonl with run id', async () => {
    await withTempDir('owlcoda-run-workspace-events-', async (dir) => {
      const outputRoot = join(dir, 'out')
      const { paths } = await createRunWorkspace({ outputRoot, cwd: dir, runId: 'run-events' })

      await recordEvent(outputRoot, { type: 'workspace_created', message: 'ready' })
      await recordEvent(paths.runDir, { type: 'artifact_recorded', stepId: 'step-1', data: { path: 'deck.html' } })

      const lines = (await readFile(paths.eventsPath, 'utf8')).trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0])).toMatchObject({ runId: 'run-events', type: 'workspace_created' })
      expect(JSON.parse(lines[1])).toMatchObject({ runId: 'run-events', type: 'artifact_recorded', stepId: 'step-1' })
    })
  })

  it('refreshes the ledger and marks deleted artifacts as missing', async () => {
    await withTempDir('owlcoda-run-workspace-missing-', async (dir) => {
      const outputRoot = join(dir, 'out')
      const notesPath = join(outputRoot, 'build-notes.md')
      await createRunWorkspace({ outputRoot, cwd: dir })
      await writeFile(notesPath, '# Build notes\n', 'utf8')
      await recordArtifact(outputRoot, {
        path: notesPath,
        origin: 'bash_detected',
        stepId: 'step-notes',
        participatesInFinal: true,
      })

      await unlink(notesPath)

      const refreshed = await refreshArtifactLedger(outputRoot)
      expect(refreshed.artifacts[0]).toMatchObject({
        path: notesPath,
        origin: 'bash_detected',
        status: 'missing',
        stepId: 'step-notes',
        participatesInFinal: true,
      })
      expect(refreshed.artifacts[0].missingAt).toMatch(/^20/)

      const readWithRefresh = await readArtifactLedger(outputRoot, { refresh: true })
      expect(readWithRefresh.artifacts[0].status).toBe('missing')
    })
  })
})
