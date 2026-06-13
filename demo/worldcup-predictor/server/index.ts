import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { streamSSE } from 'hono/streaming'
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { listModels, health, streamMessage } from './owlcoda.js'
import { getCapabilities } from './capabilities.js'
import { finalProPrompt, finalAntiPrompt, finalJudgePrompt } from './framework/prompts.js'
import { extractJson } from './framework/parse.js'
import { runAnalysis, type AnalysisArtifacts } from './analyze.js'
import { schedule, showcases, teamByName, teams, teamsMeta } from './data.js'
import type { AnalyzeRequest } from './framework/types.js'

const DEFAULT_OWLCODA = 'http://127.0.0.1:8019'
const runsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'runs')

// Archive every real analysis for replay/comparison (mirrors the hermes
// task-directory layout). Scout evidence is the point: it must persist.
// latest archived stamp per match, so finalize can attach to the right run
const latestStamp = new Map<string, string>()

function archiveRun(matchId: string, a: AnalysisArtifacts) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  latestStamp.set(String(matchId), stamp)
  const dir = path.join(runsDir, String(matchId), stamp)
  mkdirSync(dir, { recursive: true })
  if (a.reconSources.length > 0) writeFileSync(path.join(dir, 'recon_sources.json'), JSON.stringify(a.reconSources, null, 2))
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

// full artifacts of a single archived run — so the UI can reload everything
app.get('/api/runs/:matchId/:stamp', (c) => {
  const dir = path.join(runsDir, c.req.param('matchId'), c.req.param('stamp'))
  if (!existsSync(dir)) return c.json({ error: 'not found' }, 404)
  const readText = (f: string) => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8') : null)
  const readJson = (f: string) => {
    const t = readText(f)
    if (t == null) return null
    try { return JSON.parse(t) } catch { return t }
  }
  return c.json({
    stamp: c.req.param('stamp'),
    evidence_brief: readText('evidence_brief.md'),
    vision_transcript: readText('vision_transcript.md'),
    recon_brief: readText('recon_brief.md'),
    recon_sources: readJson('recon_sources.json') ?? [],
    pro: readJson('pro.json'),
    anti: readJson('anti.json'),
    judge: readJson('judge.json'),
    final: readJson('final.json'),
    final_pro: readJson('final_pro.json'),
    final_anti: readJson('final_anti.json'),
    human_note: readText('human_note.txt'),
    manifest: readJson('run_manifest.json'),
  })
})

// Final gate: a SECOND debate round. The human note is tested — Pro and
// Anti each examine it with their own frameworks (they may refute it),
// then a final Judge rules adopt/partial/reject. Dialectic, not obedience.
app.post('/api/finalize', async (c) => {
  const body = (await c.req.json()) as {
    matchId: string | number
    stamp?: string
    humanNote?: string
    models?: { pro?: string; anti?: string; judge?: string }
    model: string // fallback for all three roles
    owlcodaBaseUrl?: string
  }
  const stamp = body.stamp ?? latestStamp.get(String(body.matchId))
  if (!stamp) return c.json({ error: 'no archived run to finalize; run an analysis first' }, 400)
  const dir = path.join(runsDir, String(body.matchId), stamp)
  if (!existsSync(dir)) return c.json({ error: `run ${stamp} not found` }, 404)
  const read = (f: string) => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8') : 'null')
  const judge1 = read('judge.json')
  const pro1 = read('pro.json')
  const anti1 = read('anti.json')
  const note = body.humanNote ?? ''
  const baseUrl = body.owlcodaBaseUrl ?? DEFAULT_OWLCODA
  const modelFor = (role: 'pro' | 'anti' | 'judge') => body.models?.[role] || body.model

  const call = async (model: string, p: { system: string; user: string }) => {
    const r = await streamMessage({ baseUrl, model, system: p.system, user: p.user })
    return { output: extractJson<Record<string, unknown>>(r.text), raw: r.text }
  }
  try {
    const fp = await call(modelFor('pro'), finalProPrompt(judge1, pro1, anti1, note))
    const fpJson = fp.output ? JSON.stringify(fp.output, null, 1) : fp.raw
    const fa = await call(modelFor('anti'), finalAntiPrompt(judge1, pro1, anti1, note, fpJson))
    const faJson = fa.output ? JSON.stringify(fa.output, null, 1) : fa.raw
    const fj = await call(modelFor('judge'), finalJudgePrompt(judge1, pro1, anti1, note, fpJson, faJson))
    if (!fj.output) return c.json({ error: 'final judge output unparseable', raw: fj.raw }, 502)
    writeFileSync(path.join(dir, 'final_pro.json'), JSON.stringify(fp.output ?? fp.raw, null, 2))
    writeFileSync(path.join(dir, 'final_anti.json'), JSON.stringify(fa.output ?? fa.raw, null, 2))
    writeFileSync(path.join(dir, 'final.json'), JSON.stringify(fj.output, null, 2))
    if (note.trim()) writeFileSync(path.join(dir, 'human_note.txt'), note.trim())
    return c.json({ ok: true, stamp, final: fj.output, final_pro: fp.output, final_anti: fa.output })
  } catch (err) {
    return c.json({ error: String(err) }, 502)
  }
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
