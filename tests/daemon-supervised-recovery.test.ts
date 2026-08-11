import { describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchHealthz, healthzMatchesRuntimeMeta, waitForHealthzGone } from '../src/healthz-client.js'

const CLI_ENTRY = join(process.cwd(), 'src', 'cli.ts')

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    child.once('close', finish)
    if (child.exitCode !== null || child.signalCode !== null) finish()
  })
}

async function waitForRuntimeMeta(metaPath: string, baseUrl: string, timeoutMs = 5000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
        const healthz = await fetchHealthz(baseUrl, 500, meta.runtimeToken)
        if (healthz && healthzMatchesRuntimeMeta(healthz, meta)) return meta
      } catch { /* daemon is still publishing its identity */ }
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for verified runtime identity at ${baseUrl}`)
}

function startSupervisedChild(configPath: string, home: string, installToken: string): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', CLI_ENTRY, 'server', '--config', configPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      OWLCODA_HOME: join(home, '.owlcoda'),
      OWLCODA_LAUNCHD: '1',
      OWLCODA_RUNTIME_TOKEN: installToken,
      OWLCODA_TRAINING_COLLECTION: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

describe('isolated supervised daemon recovery', () => {
  it('re-registers a crashed daemon with a new PID and runtime token', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'owlcoda-supervised-recovery-'))
    const configPath = join(fixtureRoot, 'config.json')
    const runtimeDir = join(fixtureRoot, '.owlcoda')
    const port = 32000 + Math.floor(Math.random() * 20000)
    const baseUrl = `http://127.0.0.1:${port}`
    const installToken = 'isolated-launchd-install-seed'
    writeFileSync(configPath, JSON.stringify({
      host: '127.0.0.1',
      port,
      routerUrl: 'http://127.0.0.1:9',
      models: [{ id: 'fixture', label: 'Fixture', backendModel: 'fixture', aliases: ['default'], tier: 'production', default: true }],
    }, null, 2))

    let first: ChildProcess | undefined
    let second: ChildProcess | undefined
    try {
      first = startSupervisedChild(configPath, fixtureRoot, installToken)
      const firstMeta = await waitForRuntimeMeta(join(runtimeDir, 'runtime.json'), baseUrl)
      const firstPid = firstMeta.pid
      const firstToken = firstMeta.runtimeToken
      first.kill('SIGKILL')
      await waitForExit(first)
      await waitForHealthzGone(baseUrl, 2000)

      second = startSupervisedChild(configPath, fixtureRoot, installToken)
      const secondMeta = await waitForRuntimeMeta(join(runtimeDir, 'runtime.json'), baseUrl)
      const secondHealthz = await fetchHealthz(baseUrl, 1000, secondMeta.runtimeToken)
      const adminResponse = await fetch(`${baseUrl}/admin/config`, {
        headers: { Authorization: `Bearer ${secondMeta.runtimeToken}` },
      })

      expect(secondMeta.pid).not.toBe(firstPid)
      expect(secondMeta.runtimeToken).not.toBe(firstToken)
      expect(secondMeta.runtimeToken).not.toBe(installToken)
      expect(secondHealthz && healthzMatchesRuntimeMeta(secondHealthz, secondMeta)).toBe(true)
      expect(adminResponse.status).toBe(200)
      expect(secondMeta.port).toBe(port)
      expect(secondMeta.version).toBe(firstMeta.version)
      expect(secondMeta.routerUrl).toBe(firstMeta.routerUrl)
      const oldIdentityHealthz = await fetchHealthz(baseUrl, 1000, firstToken)
      expect(oldIdentityHealthz && healthzMatchesRuntimeMeta(oldIdentityHealthz, firstMeta)).toBe(false)
    } finally {
      if (second && second.exitCode === null) {
        second.kill('SIGTERM')
        await waitForExit(second)
      }
      if (first && first.exitCode === null) {
        first.kill('SIGKILL')
        await waitForExit(first)
      }
      await waitForHealthzGone(baseUrl, 2000)
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  }, 15000)
})
