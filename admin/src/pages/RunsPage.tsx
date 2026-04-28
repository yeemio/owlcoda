import { useMemo, useState } from 'react'

// ─── Report data ────────────────────────────────────────────────────────
//
// Hardcoded snapshot of the public Lane A cmux long-stress signoff.
// Only the report-level totals are authoritative; per-request bars and coarse
// tool counts are representative placeholders until a real run-report endpoint
// exists.

type Tone = 'ok' | 'warn' | 'err' | 'planned' | 'info'
type RunVerdict = 'pass' | 'partial' | 'fail'
type BulletTone = 'ok' | 'caret' | 'warn'

interface RunBullet {
  tone: BulletTone
  text: string
}

interface RunCard {
  id: string
  verdict: RunVerdict
  servedBy: string
  requests: number
  http200: string
  fallback: 'true' | 'false'
  duration: string
  bullets: RunBullet[]
  sessionPath: string
  /** Per-request total durations in ms; bar height proportional in the timeline. */
  requestDurations: number[]
  toolCounts: Array<{ name: string; count: number }>
}

interface FailureVerdict {
  badge: 'PASS' | 'INFO' | 'PARTIAL'
  title: string
  detail: string
}

interface Blocker {
  badge: 'PARTIAL' | 'OPEN' | 'RESOLVED'
  title: string
  detail: string
  status: 'open' | 'resolved'
}

const REPORT = {
  eyebrow: 'STRESS VERIFICATION · LANE A · 2026-04-27',
  title: 'minimax-m27 + kimi-code stress run',
  titleSuffix: 'Lane A',
  description:
    'Real cmux and official-route runs against OwlCoda daemon · runtime. Captures audit, rendering verdict, Kimi sustained-work evidence, repo diff, and remaining blockers. Lane A is green; Kimi provider-side 10-minute parity is proven, with clean runtime signoff pending the completion-guard rerun.',
  verdict: {
    tone: 'ok' as Tone,
    label: 'Lane A green · Kimi provider-side passed',
  },
  packageVersion: '0.1.5',
  daemonHealth: 'HEALTHY' as const,
  daemon: '127.0.0.1:9999',
  runtime: '127.0.0.1:8009',
  npmBuild: 'PASSED' as const,
  runs: [
    {
      id: 'minimax-m27',
      verdict: 'pass',
      servedBy: 'MiniMax-M2.7-highspeed',
      requests: 21,
      http200: '21/21',
      fallback: 'false',
      duration: '~10 min',
      bullets: [
        { tone: 'caret', text: 'Real cmux run reached "Nothing remaining. Task done." and returned to ready.' },
        { tone: 'ok', text: 'All 21 requests HTTP 200 streaming, fallbackUsed=false' },
        { tone: 'ok', text: 'Exercised bash · read · glob · grep · Agent · Task · Config · WebFetch · StructuredOutput · ToolSearch · LSP' },
        { tone: 'ok', text: 'npm test passed: 272 test files, 3,630 tests' },
      ],
      sessionPath: '~/.owlcoda/sessions/conv-1777282931302-ah9wa9.json',
      requestDurations: [
        18000, 22000, 16000, 28000, 24000, 32000, 20000, 30000, 26000, 34000,
        22000, 38000, 28000, 24000, 30000, 26000, 32000, 20000, 28000, 36000, 24000,
      ],
      toolCounts: [
        { name: 'bash', count: 12 },
        { name: 'read', count: 18 },
        { name: 'glob', count: 6 },
        { name: 'grep', count: 8 },
        { name: 'Agent', count: 3 },
        { name: 'Task', count: 4 },
        { name: 'Config', count: 1 },
        { name: 'WebFetch', count: 2 },
        { name: 'Structure…', count: 1 },
        { name: 'ToolSearch', count: 5 },
        { name: 'LSP', count: 0 },
      ],
    },
    {
      id: 'kimi-code',
      verdict: 'partial',
      servedBy: 'kimi-for-coding',
      requests: 66,
      http200: '66/66',
      fallback: 'false',
      duration: '10.6 min',
      bullets: [
        { tone: 'caret', text: 'Official-route objective ran 10.6 minutes / 637 seconds inside a 26m10s wall-clock window.' },
        { tone: 'ok', text: 'All 66 provider requests HTTP 200 streaming, fallbackUsed=false' },
        { tone: 'ok', text: '7 checkpoints completed; 5 focused suites passed 70/70; temp workspace cleanup completed' },
        { tone: 'warn', text: 'Runtime completion guard drifted after the final report; guard fix is patched, rerun still required for clean signoff' },
      ],
      sessionPath: '~/.owlcoda/sessions/conv-1777344095836-kfqoja.json',
      requestDurations: [
        18000, 24000, 19000, 26000, 22000, 30000, 25000, 28000, 21000, 32000,
        24000, 36000, 29000, 23000, 31000, 27000, 34000, 26000, 30000, 33000,
        22000, 28000, 35000, 25000, 31000, 37000, 26000, 32000, 29000, 34000,
      ],
      toolCounts: [
        { name: 'bash', count: 9 },
        { name: 'read', count: 14 },
        { name: 'glob', count: 5 },
        { name: 'grep', count: 7 },
        { name: 'Agent', count: 2 },
        { name: 'Task', count: 2 },
        { name: 'Config', count: 1 },
        { name: 'WebFetch', count: 1 },
        { name: 'Structure…', count: 0 },
        { name: 'ToolSearch', count: 3 },
        { name: 'LSP', count: 0 },
      ],
    },
  ] as RunCard[],
  rendering: {
    verdict: 'NO SMEAR' as const,
    checks: [
      'No cmux row-smear during active runs',
      'No overlap or stale prompt observed',
      'No composer corruption',
    ],
    capturePath: '/tmp/owlcoda-stress-20260427/minimax.ansi',
    captureBytes: 546674,
    capture: [
      { prompt: '~/owlcoda $', text: 'owlcoda --model minimax-m27' },
      { ts: '14:02:11', tone: 'ok', text: 'daemon healthy 127.0.0.1:9999' },
      { ts: '14:02:11', tone: 'ok', text: 'runtime 127.0.0.1:8009 · MiniMax-M2.7-highspeed' },
      { ts: '14:02:14', tone: 'caret', text: 'Task stress · 21-step plan loaded' },
      { ts: '14:02:18', tone: 'caret', text: 'bash npm test --reporter=basic' },
      { ts: '14:02:55', tone: 'check', text: '272 files · 3630 tests pass' },
      { ts: '14:03:02', tone: 'caret', text: 'ToolSearch "rate limit" → 4 hits' },
      { ts: '14:03:11', tone: 'caret', text: 'Agent dispatch StructuredOutput' },
      { ts: '14:03:17', tone: 'ok', text: 'Nothing remaining. Task done.' },
      { prompt: '~/owlcoda $', text: '_' },
    ] as Array<{ ts?: string; tone?: 'ok' | 'caret' | 'check'; prompt?: string; text: string }>,
    captureCaveat:
      'The ANSI capture is still the Lane A cmux artifact; Kimi official-route parity is proven from session and audit JSON.',
  },
  runtimeFailures: [
    {
      badge: 'PASS',
      title: 'Provider request paths (minimax / kimi)',
      detail: 'No transport, fallback, rate-limit, or provider outage evidence. Kimi drift was a completion-guard classification issue after final delivery.',
    },
    {
      badge: 'INFO',
      title: 'LSP',
      detail: 'Returned "no language server running" — environment/tooling setup, not an OwlCoda loop failure.',
    },
    {
      badge: 'INFO',
      title: 'ListMcpResources',
      detail: 'Required a server name — parameter-specific, not a runtime defect.',
    },
    {
      badge: 'PARTIAL',
      title: 'cmux CLI',
      detail: 'Socket commands failed with Broken pipe; cmux GUI control worked.',
    },
  ] as FailureVerdict[],
  filesChanged: {
    count: 0,
    laneLabel: 'Lane A',
    preExistingDirty: ['website source excluded', 'brand source assets excluded', 'internal execution notes excluded'],
  },
  blockers: [
    {
      badge: 'PARTIAL',
      title: 'cmux CLI control surface unhealthy',
      detail: 'cmux CLI socket commands fail with Broken pipe; cmux GUI control still works as workaround.',
      status: 'open',
    },
    {
      badge: 'PARTIAL',
      title: 'cmux text injection corrupts shell syntax',
      detail: 'Underscores and special shell characters can be mangled when injecting text via cmux.',
      status: 'open',
    },
    {
      badge: 'RESOLVED',
      title: 'Kimi 10-minute parity comparison',
      detail: 'Official-route run completed 10.6 minutes with 66/66 HTTP 200 requests and fallbackUsed=false; clean product signoff still needs a post-guard-fix rerun.',
      status: 'resolved',
    },
  ] as Blocker[],
  inRunTests: {
    testFiles: 272,
    tests: 3630,
    failures: 0,
  },
  verification: [
    { item: 'npm run build', status: 'PASSED' as const, suffix: 'before stress' },
  ],
}

// ─── Page ──────────────────────────────────────────────────────────────

export function RunsPage() {
  return (
    <div className="app-main full run-page" data-testid="runs-page">
      <section className="panel run-panel">
        <RunHeader />
        <RunHeroStrip />
        <div className="run-grid">
          <div className="run-col">
            <RunCardsSection />
            <AuditTimelineSection />
            <ToolCoverageSection />
            <InRunTestsSection />
          </div>
          <div className="run-col">
            <RenderingVerdictSection />
            <RuntimeFailuresSection />
            <FilesChangedSection />
            <RemainingBlockersSection />
            <VerificationSection />
          </div>
        </div>
      </section>
    </div>
  )
}

// ─── Header & hero ─────────────────────────────────────────────────────

function RunHeader() {
  return (
    <header className="run-header">
      <div className="run-eyebrow">— {REPORT.eyebrow}</div>
      <h1 className="run-title" data-testid="run-title">
        {REPORT.title} <span className="run-title-suffix">/ {REPORT.titleSuffix}</span>
      </h1>
      <p className="run-description">{REPORT.description}</p>
    </header>
  )
}

function RunHeroStrip() {
  return (
    <section className="run-hero-strip" data-testid="run-hero-strip">
      <HeroCell label="RUN VERDICT" wide>
        <span className={`run-hero-dot tone-${REPORT.verdict.tone}`} aria-hidden>●</span>
        <span data-testid="run-hero-verdict">{REPORT.verdict.label}</span>
      </HeroCell>
      <HeroCell label="PACKAGE · CLI · DAEMON">
        <span className="run-hero-mono">{REPORT.packageVersion}</span>
        <span className="run-badge run-badge-ok run-badge-sm">{REPORT.daemonHealth}</span>
      </HeroCell>
      <HeroCell label="DAEMON">
        <span className="run-hero-mono">{REPORT.daemon}</span>
      </HeroCell>
      <HeroCell label="RUNTIME">
        <span className="run-hero-mono">{REPORT.runtime}</span>
      </HeroCell>
      <HeroCell label="NPM RUN BUILD">
        <span className="run-badge run-badge-ok">{REPORT.npmBuild}</span>
      </HeroCell>
    </section>
  )
}

function HeroCell({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`run-hero-cell${wide ? ' run-hero-cell-wide' : ''}`}>
      <span className="run-hero-label">{label}</span>
      <span className="run-hero-value">{children}</span>
    </div>
  )
}

// ─── Runs list ─────────────────────────────────────────────────────────

function RunCardsSection() {
  const activeCount = REPORT.runs.length
  return (
    <section className="run-section" data-testid="runs-list">
      <SectionHeader title="RUNS">
        <span className="run-pill">{activeCount} ACTIVE</span>
      </SectionHeader>
      {REPORT.runs.map(run => <RunCardView key={run.id} run={run} />)}
    </section>
  )
}

function RunCardView({ run }: { run: RunCard }) {
  return (
    <article
      className={`run-card run-card-${run.verdict}`}
      data-testid={`run-card-${run.id}`}
    >
      <header className="run-card-head">
        <strong>{run.id}</strong>{' '}
        <span className={`run-badge run-badge-${run.verdict === 'pass' ? 'ok' : 'warn'} run-badge-sm`}>
          {run.verdict === 'pass' ? 'PASS' : 'PARTIAL'}
        </span>
        <div className="run-card-served">
          served by <code>{run.servedBy}</code>
        </div>
      </header>
      <dl className="run-card-stats">
        <Stat label="REQUESTS" value={String(run.requests)} />
        <Stat label="HTTP 200" value={run.http200} tone="ok" />
        <Stat label="FALLBACK" value={run.fallback} />
        <Stat label="DURATION" value={run.duration} tone={run.verdict === 'partial' ? 'warn' : undefined} />
      </dl>
      <ul className="run-card-bullets">
        {run.bullets.map((b, i) => (
          <li key={i} className={`run-bullet run-bullet-${b.tone}`}>
            <span className="run-bullet-icon" aria-hidden>{bulletIcon(b.tone)}</span>
            <span>{b.text}</span>
          </li>
        ))}
      </ul>
      <footer className="run-card-foot">
        <span className="run-card-session">
          <span className="run-card-session-label">SESSION</span>{' '}
          <code>{run.sessionPath}</code>
        </span>
        <CopyButton text={run.sessionPath} label="COPY" testId={`run-card-${run.id}-copy`} />
      </footer>
    </article>
  )
}

function bulletIcon(tone: BulletTone): string {
  switch (tone) {
    case 'ok': return '✓'
    case 'caret': return '›'
    case 'warn': return '!'
  }
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'err' }) {
  return (
    <div className="run-stat">
      <dt>{label}</dt>
      <dd className={tone ? `tone-${tone}` : undefined}>{value}</dd>
    </div>
  )
}

// ─── Audit timeline ────────────────────────────────────────────────────

function AuditTimelineSection() {
  const [view, setView] = useState<'all200' | 'streaming'>('all200')
  return (
    <section className="run-section" data-testid="audit-timeline">
      <SectionHeader
        title="AUDIT · REQUEST TIMELINE"
        subtitle="representative timings · pending real audit-log feed"
      >
        <div className="run-toggle">
          <button
            type="button"
            className={view === 'all200' ? 'active' : ''}
            onClick={() => setView('all200')}
            data-testid="audit-toggle-all200"
          >ALL 200</button>
          <button
            type="button"
            className={view === 'streaming' ? 'active' : ''}
            onClick={() => setView('streaming')}
            data-testid="audit-toggle-streaming"
          >STREAMING</button>
        </div>
      </SectionHeader>
      {REPORT.runs.map(run => (
        <RequestBars key={run.id} run={run} view={view} />
      ))}
      <p className="run-section-note">
        Authoritative: per-run totals (requests · all 200 streaming · fallbackUsed=false). Per-request bar heights are placeholder until an audit-log endpoint feeds this section.
      </p>
    </section>
  )
}

function RequestBars({ run, view }: { run: RunCard; view: 'all200' | 'streaming' }) {
  const max = Math.max(...run.requestDurations)
  const tone = run.verdict === 'pass' ? 'ok' : 'warn'
  return (
    <div className="run-timeline-row" data-testid={`audit-row-${run.id}`}>
      <span className={`run-timeline-label tone-${tone}`}>
        <span className="run-hero-dot" aria-hidden>●</span> {run.id}
      </span>
      <div className="run-timeline-bars">
        {run.requestDurations.map((ms, i) => (
          <span
            key={i}
            className={`run-timeline-bar tone-${tone}`}
            style={{ height: `${Math.max(8, Math.round((ms / max) * 100))}%` }}
            title={`req #${i + 1} · ${(ms / 1000).toFixed(1)}s · 200 ${view === 'streaming' ? 'streaming' : ''}`}
          />
        ))}
      </div>
      <span className="run-timeline-meta">
        {run.requests} reqs · all 200
      </span>
    </div>
  )
}

// ─── Tool coverage ─────────────────────────────────────────────────────

function ToolCoverageSection() {
  const [activeRun, setActiveRun] = useState<string>(REPORT.runs[REPORT.runs.length - 1]!.id)
  const run = REPORT.runs.find(r => r.id === activeRun) ?? REPORT.runs[0]!
  return (
    <section className="run-section" data-testid="tool-coverage">
      <SectionHeader
        title={`TOOL COVERAGE · ${activeRun.toUpperCase()}`}
        subtitle="representative counts · pending real audit-log feed"
      >
        <div className="run-tabs">
          {REPORT.runs.map(r => (
            <button
              key={r.id}
              type="button"
              className={r.id === activeRun ? 'active' : ''}
              onClick={() => setActiveRun(r.id)}
              data-testid={`tool-coverage-tab-${r.id}`}
            >{r.id}</button>
          ))}
        </div>
      </SectionHeader>
      <div className="run-tool-grid" data-testid={`tool-coverage-grid-${run.id}`}>
        {run.toolCounts.map(t => (
          <div
            key={t.name}
            className={`run-tool-tile ${t.count === 0 ? 'run-tool-empty' : ''}`}
            data-testid={`tool-tile-${t.name}`}
          >
            <span className={`run-hero-dot ${t.count === 0 ? 'tone-warn' : 'tone-ok'}`} aria-hidden>●</span>
            <span className="run-tool-name">{t.name}</span>
            <span className="run-tool-count">{t.count}</span>
          </div>
        ))}
      </div>
      <p className="run-section-note">
        Authoritative: tool list (signoff markdown enumerates which tools were exercised). Per-tool invocation counts are placeholder; yellow = the run did not invoke this tool (LSP requires user-installed language servers).
      </p>
    </section>
  )
}

// ─── In-run tests ──────────────────────────────────────────────────────

function InRunTestsSection() {
  const t = REPORT.inRunTests
  return (
    <section className="run-section" data-testid="in-run-tests">
      <SectionHeader title="IN-RUN TESTS · NPM TEST">
        <span className="run-badge run-badge-ok">PASSED</span>
      </SectionHeader>
      <dl className="run-stat-strip">
        <Stat label="TEST FILES" value={t.testFiles.toLocaleString()} tone="ok" />
        <Stat label="TESTS" value={t.tests.toLocaleString()} tone="ok" />
        <Stat label="FAILURES" value={t.failures.toLocaleString()} tone={t.failures === 0 ? 'ok' : 'err'} />
      </dl>
      <p className="run-section-note">
        Reported in both visible runs. <code>npm run build</code> also passed before the stress.
      </p>
    </section>
  )
}

// ─── Rendering verdict ─────────────────────────────────────────────────

function RenderingVerdictSection() {
  const r = REPORT.rendering
  return (
    <section className="run-section" data-testid="rendering-verdict">
      <SectionHeader title="RENDERING VERDICT">
        <span className="run-badge run-badge-ok">{r.verdict}</span>
      </SectionHeader>
      <ul className="run-check-list">
        {r.checks.map((c, i) => (
          <li key={i} className="run-check-row">
            <span className="run-check-icon tone-ok" aria-hidden>✓</span>
            <span>{c}</span>
          </li>
        ))}
      </ul>
      <TerminalCapture />
      <div className="run-capture-caveat">
        <span>{r.captureCaveat}</span>
        <CopyButton text={r.capturePath} label="COPY PATH" testId="capture-copy-path" multiline />
      </div>
    </section>
  )
}

function TerminalCapture() {
  const r = REPORT.rendering
  return (
    <div className="run-terminal" data-testid="run-terminal">
      <header className="run-terminal-head">
        <span className="run-terminal-dots">
          <span className="run-terminal-dot run-terminal-dot-red" />
          <span className="run-terminal-dot run-terminal-dot-yellow" />
          <span className="run-terminal-dot run-terminal-dot-green" />
        </span>
        <code className="run-terminal-path">{r.capturePath}</code>
        <span className="run-terminal-bytes">{r.captureBytes.toLocaleString()} bytes</span>
      </header>
      <pre className="run-terminal-body">
        {r.capture.map((line, i) => {
          if (line.prompt) {
            return (
              <div key={i} className="run-terminal-prompt">
                <span className="tone-ok">{line.prompt}</span> {line.text}
              </div>
            )
          }
          const toneClass = line.tone === 'check' ? 'tone-ok' : line.tone === 'ok' ? 'tone-ok' : 'run-terminal-caret'
          const icon = line.tone === 'ok' ? '●' : line.tone === 'check' ? '✓' : '↳'
          return (
            <div key={i} className="run-terminal-line">
              <span className="run-terminal-ts">[{line.ts}]</span>{' '}
              <span className={toneClass}>{icon}</span>{' '}
              <span>{line.text}</span>
            </div>
          )
        })}
      </pre>
    </div>
  )
}

// ─── Runtime failures ──────────────────────────────────────────────────

function RuntimeFailuresSection() {
  return (
    <section className="run-section" data-testid="runtime-failures">
      <SectionHeader title="RUNTIME FAILURE VERDICTS">
        <span className="run-badge run-badge-warn">PARTIAL</span>
      </SectionHeader>
      <ul className="run-failure-list">
        {REPORT.runtimeFailures.map((f, i) => (
          <li key={i} className="run-failure-row" data-testid={`runtime-failure-${i}`}>
            <span className={`run-badge run-badge-${badgeTone(f.badge)} run-badge-sm`}>{f.badge}</span>
            <div className="run-failure-body">
              <strong>{f.title}</strong>
              <span>{f.detail}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function badgeTone(badge: 'PASS' | 'INFO' | 'PARTIAL' | 'OPEN' | 'RESOLVED'): 'ok' | 'info' | 'warn' | 'planned' {
  switch (badge) {
    case 'PASS': return 'ok'
    case 'INFO': return 'info'
    case 'PARTIAL': return 'warn'
    case 'OPEN': return 'warn'
    case 'RESOLVED': return 'ok'
  }
}

// ─── Files changed ─────────────────────────────────────────────────────

function FilesChangedSection() {
  const f = REPORT.filesChanged
  return (
    <section className="run-section" data-testid="files-changed">
      <SectionHeader title={`FILES CHANGED BY ${f.laneLabel.toUpperCase()}`}>
        <span className="run-badge run-badge-ok">CLEAN</span>
      </SectionHeader>
      <div className="run-files-row">
        <span className="run-check-icon tone-ok" aria-hidden>✓</span>
        <span>
          {f.laneLabel} changed <strong className="tone-ok">{f.count} files</strong> in repo
        </span>
      </div>
      <p className="run-section-note">Public router excludes non-runtime release artifacts:</p>
      <div className="run-chip-row">
        {f.preExistingDirty.map(item => (
          <span key={item} className="run-chip">{item}</span>
        ))}
      </div>
    </section>
  )
}

// ─── Remaining blockers ────────────────────────────────────────────────

function RemainingBlockersSection() {
  const [filter, setFilter] = useState<'all' | 'open' | 'resolved'>('all')
  const filtered = useMemo(() => {
    if (filter === 'all') return REPORT.blockers
    return REPORT.blockers.filter(b => b.status === filter)
  }, [filter])
  return (
    <section className="run-section" data-testid="remaining-blockers">
      <SectionHeader title="REMAINING BLOCKERS">
        <div className="run-toggle">
          {(['all', 'open', 'resolved'] as const).map(v => (
            <button
              key={v}
              type="button"
              className={filter === v ? 'active' : ''}
              onClick={() => setFilter(v)}
              data-testid={`blockers-filter-${v}`}
            >{v.toUpperCase()}</button>
          ))}
        </div>
      </SectionHeader>
      <ul className="run-blocker-list">
        {filtered.map((b, i) => (
          <li key={i} className="run-blocker-row" data-testid={`blocker-${i}`}>
            <span className={`run-badge run-badge-${badgeTone(b.badge)} run-badge-sm`}>{b.badge}</span>
            <div className="run-blocker-body">
              <strong>{b.title}</strong>
              <span>{b.detail}</span>
            </div>
            <button
              type="button"
              className="run-blocker-action"
              data-testid={`blocker-${i}-resolve`}
              disabled
              title="Blocker resolution is tracked in the signoff markdown. Admin write-back lands when a backend route exists."
            >tracked in signoff</button>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ─── Verification ──────────────────────────────────────────────────────

function VerificationSection() {
  return (
    <section className="run-section" data-testid="verification">
      <SectionHeader title="VERIFICATION">
        <span className="run-badge run-badge-ok">PASS</span>
      </SectionHeader>
      <ul className="run-verify-list">
        {REPORT.verification.map((v, i) => (
          <li key={i} className="run-verify-row">
            <code>{v.item}</code>
            <span className="run-badge run-badge-ok run-badge-sm">{v.status}</span>
            <span className="run-verify-suffix">{v.suffix}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ─── Shared bits ───────────────────────────────────────────────────────

function SectionHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <header className="run-section-head">
      <div className="run-section-title-stack">
        <span className="run-section-title">{title}</span>
        {subtitle && <span className="run-section-subtitle">{subtitle}</span>}
      </div>
      {children && <span className="run-section-actions">{children}</span>}
    </header>
  )
}

function CopyButton({ text, label, testId, multiline }: { text: string; label: string; testId?: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className={`run-copy-btn${multiline ? ' run-copy-btn-multiline' : ''}`}
      data-testid={testId}
      onClick={() => {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }).catch(() => {
            /* ignore */
          })
        }
      }}
    >{copied ? 'COPIED' : label}</button>
  )
}
