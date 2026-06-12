import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { streamSSE } from 'hono/streaming'
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { listModels, health } from './owlcoda.js'
import { getCapabilities } from './capabilities.js'
import { runAnalysis, type AnalysisArtifacts } from './analyze.js'
import { schedule, showcases, teamByName, teams, teamsMeta } from './data.js'
import type { AnalyzeRequest } from './framework/types.js'

const DEFAULT_OWLCODA = 'http://127.0.0.1:8019'
const runsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'runs')

// Archive every real analysis for replay/comparison (mirrors the hermes
// task-directory layout). Scout evidence is the point: it must persist.
function archiveRun(matchId: string, a: AnalysisArtifacts) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(runsDir, String(matchId), stamp)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'evidence_brief.md'), a.evidenceBrief)
  if (a.vision != null) writeFileSync(path.join(dir, 'vision_transcript.md'), a.vision)
  if (a.recon != null) writeFileSync(path.join(dir, 'recon_brief.md'), a.recon)
  writeFileSync(path.join(dir, 'pro.json'), JSON.stringify(a.pro, null, 2))
  writeFileSync(path.join(dir, 'anti.json'), JSON.stringify(a.anti, null, 2))
  writeFileSync(path.join(dir, 'judge.json'), JSON.stringify(a.judge, null, 2))
  writeFileSync(
    path.join(dir, 'run_manifest.json'),
    JSON.stringify({ match_key: a.matchKey, archived_at: stamp, total_ms: a.totalMs, roles: a.manifests }, null, 2),
  )
}

const app = new Hono()
app.use('*', cors())

app.get('/api/fixtures', (c) =>
  c.json({
    generated_at: schedule.generated_at,
    fixtures: schedule.fixtures.map((f) => ({
      ...f,
      showcase_id:
        Object.values(showcases).find(
          (s: any) => s.match.home === f.home_team && s.match.away === f.away_team,
        )?.id ?? null,
    })),
  }),
)

app.get('/api/teams', (c) => c.json({ ...teamsMeta, teams }))

app.get('/api/showcase/:id', (c) => {
  const pkg = showcases[c.req.param('id')]
  return pkg ? c.json(pkg) : c.json({ error: 'not found' }, 404)
})

app.get('/api/models', async (c) => {
  const base = c.req.query('base') ?? DEFAULT_OWLCODA
  try {
    return c.json({ ok: true, models: await listModels(base) })
  } catch (err) {
    return c.json({ ok: false, error: String(err), models: [] })
  }
})

app.get('/api/capabilities', async (c) => {
  const base = c.req.query('base') ?? DEFAULT_OWLCODA
  try {
    return c.json({ ok: true, capabilities: await getCapabilities(base) })
  } catch (err) {
    return c.json({ ok: false, error: String(err), capabilities: {} })
  }
})

app.get('/api/health', async (c) => {
  const base = c.req.query('base') ?? DEFAULT_OWLCODA
  return c.json(await health(base))
})

app.post('/api/analyze', async (c) => {
  const req = (await c.req.json()) as AnalyzeRequest
  const fixture = schedule.fixtures.find((f) => String(f.match_id) === String(req.matchId))
  if (!fixture) return c.json({ error: 'fixture not found' }, 404)
  const home = teamByName.get(fixture.home_team) ?? null
  const away = teamByName.get(fixture.away_team) ?? null
  return streamSSE(c, async (stream) => {
    // Serialize writes and flush the queue before the stream closes,
    // otherwise trailing events (manifest/done) get dropped.
    let queue: Promise<void> = Promise.resolve()
    await runAnalysis(
      req,
      fixture,
      home,
      away,
      (event) => {
        queue = queue.then(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }))
      },
      (artifacts) => {
        try {
          archiveRun(String(req.matchId), artifacts)
        } catch (err) {
          console.error('[archive] failed:', err)
        }
      },
    )
    await queue
  })
})

app.get('/api/runs/:matchId', (c) => {
  const dir = path.join(runsDir, c.req.param('matchId'))
  if (!existsSync(dir)) return c.json({ runs: [] })
  const runs = readdirSync(dir)
    .sort()
    .reverse()
    .map((stamp) => {
      try {
        const manifest = JSON.parse(readFileSync(path.join(dir, stamp, 'run_manifest.json'), 'utf8'))
        const judge = JSON.parse(readFileSync(path.join(dir, stamp, 'judge.json'), 'utf8'))
        return { stamp, manifest, judge }
      } catch {
        return { stamp, manifest: null, judge: null }
      }
    })
  return c.json({ runs })
})

const port = Number(process.env.PORT ?? 8030)
serve({ fetch: app.fetch, port }, () => {
  console.log(`[worldcup-predictor] server listening on http://127.0.0.1:${port}`)
  console.log(`[worldcup-predictor] expecting owlcoda proxy at ${DEFAULT_OWLCODA} (override per-request with ?base=)`)
})

export { app }
