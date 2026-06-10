import { createContext, useContext, useMemo, useState } from 'react'
import { useI18n } from '../i18n'

// ─── Report data ────────────────────────────────────────────────────────
//
// Public demo snapshot for the Runs dashboard. Per-request bars and coarse
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

const RUNS_TEXT = {
  en: {
    reportEyebrow: 'RUN OBSERVABILITY · DEMO',
    reportTitle: 'cloud-primary + local-runtime reliability demo',
    titleSuffix: 'Public demo',
    description:
      'Representative OwlCoda daemon · runtime run data. This view shows request totals, rendering checks, tool coverage, repo diff, and follow-up items. Values are demo data until a live run-report endpoint feeds this page.',
    verdictLabel: 'Demo run healthy · no runtime regressions',
    runVerdict: 'RUN VERDICT',
    packageCliDaemon: 'DEMO PACKAGE · DAEMON',
    daemon: 'DAEMON',
    runtime: 'RUNTIME',
    npmRunBuild: 'NPM RUN BUILD',
    runs: 'RUNS',
    active: 'ACTIVE',
    pass: 'PASS',
    partial: 'PARTIAL',
    info: 'INFO',
    open: 'OPEN',
    resolved: 'RESOLVED',
    clean: 'CLEAN',
    servedBy: 'served by',
    requests: 'REQUESTS',
    http200: 'HTTP 200',
    fallback: 'FALLBACK',
    duration: 'DURATION',
    session: 'SESSION',
    copy: 'COPY',
    copied: 'COPIED',
    auditTimeline: 'AUDIT · REQUEST TIMELINE',
    representativeTimings: 'representative timings · pending real audit-log feed',
    all200: 'ALL 200',
    streaming: 'STREAMING',
    requestTitle: 'req #{index} · {seconds}s · 200 {streaming}',
    reqsAll200: '{count} reqs · all 200',
    auditNote:
      'Authoritative: per-run totals (requests · all 200 streaming · fallbackUsed=false). Per-request bar heights are placeholder until an audit-log endpoint feeds this section.',
    toolCoverage: 'TOOL COVERAGE · {run}',
    representativeCounts: 'representative counts · pending real audit-log feed',
    toolCoverageNote:
      'Authoritative: tool list (the run report enumerates which tools were exercised). Per-tool invocation counts are placeholder; yellow = the run did not invoke this tool (LSP requires user-installed language servers).',
    inRunTests: 'IN-RUN TESTS · NPM TEST',
    passed: 'PASSED',
    testFiles: 'TEST FILES',
    tests: 'TESTS',
    failures: 'FAILURES',
    inRunTestsNote: 'Reported in both visible runs. npm run build also passed before the stress.',
    renderingVerdict: 'RENDERING VERDICT',
    copyPath: 'COPY PATH',
    runtimeFailureVerdicts: 'RUNTIME FAILURE VERDICTS',
    filesChangedBy: 'FILES CHANGED BY {lane}',
    filesChangedLine: '{lane} changed {count} files in repo',
    preExistingDirty: 'Worktree retains pre-existing dirty entries (not touched by this lane):',
    remainingBlockers: 'FOLLOW-UP ITEMS',
    all: 'ALL',
    trackedInReport: 'tracked in report',
    trackedInReportTitle: 'Follow-up status is displayed locally until Admin write-back lands behind a backend route.',
    verification: 'VERIFICATION',
    beforeStress: 'before stress',
    bullets: {
      'cloud-primary': [
        'Run reached the ready state after completing the requested task.',
        'All 12 requests returned HTTP 200 streaming, fallbackUsed=false',
        'Exercised bash · read · glob · grep · Agent · Task · Config · ToolSearch',
        'Focused verification passed: 42 test files, 640 tests',
      ],
      'local-runtime': [
        'Local runtime objective completed inside a sustained-work window.',
        'All 18 runtime requests returned HTTP 200 streaming, fallbackUsed=false',
        '4 checkpoints completed; focused suites passed 28/28; temp workspace cleanup completed',
        'Follow-up: wire this dashboard to the live audit-log endpoint',
      ],
    },
    renderingChecks: [
      'No terminal row-smear during active runs',
      'No overlap or stale prompt observed',
      'No composer corruption',
    ],
    captureCaveat:
      'The terminal capture is representative demo data until the live audit-log endpoint feeds this section.',
    runtimeFailures: [
      {
        title: 'Provider request paths',
        detail: 'No transport, fallback, rate-limit, or provider outage evidence in this demo dataset.',
      },
      {
        title: 'LSP',
        detail: 'Returned "no language server running" — environment/tooling setup, not an OwlCoda loop failure.',
      },
      {
        title: 'ListMcpResources',
        detail: 'Required a server name — parameter-specific, not a runtime defect.',
      },
      {
        title: 'Terminal control',
        detail: 'No terminal-control defect is represented in this demo dataset.',
      },
    ],
    blockers: [
      {
        title: 'Connect live audit-log feed',
        detail: 'Replace representative per-request bars with data from the runtime audit-log endpoint.',
      },
      {
        title: 'Persist run annotations',
        detail: 'Allow operators to store notes and close follow-up items from Admin.',
      },
      {
        title: 'Export run packet',
        detail: 'Package request totals, rendering checks, and tool coverage into a shareable report.',
      },
    ],
  },
  zh: {
    reportEyebrow: '运行观测 · Demo',
    reportTitle: 'cloud-primary + local-runtime 可靠性演示',
    titleSuffix: '公开演示',
    description:
      '代表性的 OwlCoda daemon/runtime 运行数据。该页面展示请求总量、渲染检查、工具覆盖、仓库 diff 与跟进项。实时 run-report endpoint 接入前，这些值是公开演示数据。',
    verdictLabel: '演示运行健康 · 无运行时回归',
    runVerdict: '运行结论',
    packageCliDaemon: '演示包版本 · Daemon',
    daemon: 'Daemon',
    runtime: 'Runtime',
    npmRunBuild: 'npm run build',
    runs: '运行记录',
    active: '活跃',
    pass: '通过',
    partial: '部分通过',
    info: '信息',
    open: '未关闭',
    resolved: '已解决',
    clean: '干净',
    servedBy: '服务模型',
    requests: '请求数',
    http200: 'HTTP 200',
    fallback: 'Fallback',
    duration: '耗时',
    session: '会话',
    copy: '复制',
    copied: '已复制',
    auditTimeline: '审计 · 请求时间线',
    representativeTimings: '代表性耗时 · 等待真实 audit-log 接入',
    all200: '全 200',
    streaming: '流式',
    requestTitle: '请求 #{index} · {seconds}s · 200 {streaming}',
    reqsAll200: '{count} 个请求 · 全部 200',
    auditNote:
      '权威数据：每轮总量（请求数 · 全部 200 streaming · fallbackUsed=false）。单请求柱状高度目前是占位，等待 audit-log endpoint 接入后替换。',
    toolCoverage: '工具覆盖 · {run}',
    representativeCounts: '代表性计数 · 等待真实 audit-log 接入',
    toolCoverageNote:
      '权威数据：工具清单（运行报告枚举了已使用工具）。单工具调用次数目前是占位；黄色表示该轮没有调用此工具（LSP 需要用户安装语言服务器）。',
    inRunTests: '运行内测试 · npm test',
    passed: '通过',
    testFiles: '测试文件',
    tests: '测试数',
    failures: '失败数',
    inRunTestsNote: '两条可见运行都报告了该结果。压力测试前 npm run build 也已通过。',
    renderingVerdict: '渲染结论',
    copyPath: '复制路径',
    runtimeFailureVerdicts: '运行时失败判定',
    filesChangedBy: '{lane} 修改文件',
    filesChangedLine: '{lane} 在仓库中修改了 {count} 个文件',
    preExistingDirty: '工作树保留了预先存在的 dirty 项（本轮未触碰）：',
    remainingBlockers: '跟进项',
    all: '全部',
    trackedInReport: '报告中跟踪',
    trackedInReportTitle: '跟进状态先在本地展示；Admin 写回要等后端 route 落地。',
    verification: '验证',
    beforeStress: '压力测试前',
    bullets: {
      'cloud-primary': [
        '运行在完成请求任务后回到 ready 状态。',
        '12 个请求全部 HTTP 200 streaming，fallbackUsed=false',
        '覆盖 bash · read · glob · grep · Agent · Task · Config · ToolSearch',
        '聚焦验证通过：42 个测试文件，640 个测试',
      ],
      'local-runtime': [
        '本地 runtime 目标在持续工作窗口内完成。',
        '18 个 runtime 请求全部 HTTP 200 streaming，fallbackUsed=false',
        '完成 4 个 checkpoint；聚焦套件 28/28 通过；临时工作区已清理',
        '跟进：把该页面接入实时 audit-log endpoint',
      ],
    },
    renderingChecks: [
      '活跃运行期间无终端行涂抹',
      '未观察到重叠或过期 prompt',
      '无输入框损坏',
    ],
    captureCaveat:
      '终端 capture 是公开演示数据；实时 audit-log endpoint 接入后会替换该区域。',
    runtimeFailures: [
      {
        title: 'Provider 请求路径',
        detail: '该演示数据中没有 transport、fallback、rate-limit 或 provider 故障证据。',
      },
      {
        title: 'LSP',
        detail: '返回 “no language server running”——这是环境 / 工具链配置，不是 OwlCoda loop 故障。',
      },
      {
        title: 'ListMcpResources',
        detail: '需要 server name——这是参数特定问题，不是运行时缺陷。',
      },
      {
        title: '终端控制',
        detail: '该演示数据不代表终端控制缺陷。',
      },
    ],
    blockers: [
      {
        title: '接入实时 audit-log feed',
        detail: '用 runtime audit-log endpoint 替换代表性的单请求柱状图。',
      },
      {
        title: '持久化运行备注',
        detail: '允许操作者在 Admin 中保存备注并关闭跟进项。',
      },
      {
        title: '导出运行包',
        detail: '把请求总量、渲染检查和工具覆盖打包成可分享报告。',
      },
    ],
  },
} as const

type RunCopy = (typeof RUNS_TEXT)[keyof typeof RUNS_TEXT]
const RunCopyContext = createContext<RunCopy>(RUNS_TEXT.en)

function useRunCopy(): RunCopy {
  return useContext(RunCopyContext)
}

function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''))
}

const REPORT = {
  eyebrow: 'RUN OBSERVABILITY · DEMO',
  title: 'cloud-primary + local-runtime reliability demo',
  titleSuffix: 'Public demo',
  description:
    'Representative OwlCoda daemon · runtime run data. This view shows request totals, rendering checks, tool coverage, repo diff, and follow-up items. Values are demo data until a live run-report endpoint feeds this page.',
  verdict: {
    tone: 'ok' as Tone,
    label: 'Demo run healthy · no runtime regressions',
  },
  packageVersion: '0.15.0',
  daemonHealth: 'HEALTHY' as const,
  daemon: '127.0.0.1:9999',
  runtime: '127.0.0.1:8009',
  npmBuild: 'PASSED' as const,
  runs: [
    {
      id: 'cloud-primary',
      verdict: 'pass',
      servedBy: 'cloud demo backend',
      requests: 12,
      http200: '12/12',
      fallback: 'false',
      duration: '~6 min',
      bullets: [
        { tone: 'caret', text: 'Run reached the ready state after completing the requested task.' },
        { tone: 'ok', text: 'All 12 requests returned HTTP 200 streaming, fallbackUsed=false' },
        { tone: 'ok', text: 'Exercised bash · read · glob · grep · Agent · Task · Config · ToolSearch' },
        { tone: 'ok', text: 'Focused verification passed: 42 test files, 640 tests' },
      ],
      sessionPath: '~/.owlcoda/sessions/demo-cloud-primary.json',
      requestDurations: [
        18000, 22000, 16000, 28000, 24000, 32000, 20000, 30000, 26000, 34000, 22000, 28000,
      ],
      toolCounts: [
        { name: 'bash', count: 7 },
        { name: 'read', count: 9 },
        { name: 'glob', count: 3 },
        { name: 'grep', count: 4 },
        { name: 'Agent', count: 2 },
        { name: 'Task', count: 3 },
        { name: 'Config', count: 1 },
        { name: 'WebFetch', count: 0 },
        { name: 'Structure…', count: 1 },
        { name: 'ToolSearch', count: 2 },
        { name: 'LSP', count: 0 },
      ],
    },
    {
      id: 'local-runtime',
      verdict: 'partial',
      servedBy: 'local runtime adapter',
      requests: 18,
      http200: '18/18',
      fallback: 'false',
      duration: '8.4 min',
      bullets: [
        { tone: 'caret', text: 'Local runtime objective completed inside a sustained-work window.' },
        { tone: 'ok', text: 'All 18 runtime requests returned HTTP 200 streaming, fallbackUsed=false' },
        { tone: 'ok', text: '4 checkpoints completed; focused suites passed 28/28; temp workspace cleanup completed' },
        { tone: 'warn', text: 'Follow-up: wire this dashboard to the live audit-log endpoint' },
      ],
      sessionPath: '~/.owlcoda/sessions/demo-local-runtime.json',
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
      'No terminal row-smear during active runs',
      'No overlap or stale prompt observed',
      'No composer corruption',
    ],
    capturePath: '/tmp/owlcoda-demo/run.ansi',
    captureBytes: 128024,
    capture: [
      { prompt: '~/owlcoda $', text: 'owlcoda --model cloud-primary' },
      { ts: '14:02:11', tone: 'ok', text: 'daemon healthy 127.0.0.1:9999' },
      { ts: '14:02:11', tone: 'ok', text: 'runtime 127.0.0.1:8009 · cloud demo backend' },
      { ts: '14:02:14', tone: 'caret', text: 'Task demo · plan loaded' },
      { ts: '14:02:18', tone: 'caret', text: 'bash npm test --reporter=basic' },
      { ts: '14:02:55', tone: 'check', text: '42 files · 640 tests pass' },
      { ts: '14:03:02', tone: 'caret', text: 'ToolSearch "rate limit" → 4 hits' },
      { ts: '14:03:11', tone: 'caret', text: 'Agent dispatch StructuredOutput' },
      { ts: '14:03:17', tone: 'ok', text: 'Nothing remaining. Task done.' },
      { prompt: '~/owlcoda $', text: '_' },
    ] as Array<{ ts?: string; tone?: 'ok' | 'caret' | 'check'; prompt?: string; text: string }>,
    captureCaveat:
      'The terminal capture is representative demo data until the live audit-log endpoint feeds this section.',
  },
  runtimeFailures: [
    {
      badge: 'PASS',
      title: 'Provider request paths',
      detail: 'No transport, fallback, rate-limit, or provider outage evidence in this demo dataset.',
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
      title: 'Terminal control',
      detail: 'No terminal-control defect is represented in this demo dataset.',
    },
  ] as FailureVerdict[],
  filesChanged: {
    count: 0,
    laneLabel: 'Demo run',
    preExistingDirty: ['local notes/', 'scratch artifacts/', 'operator draft (new)'],
  },
  blockers: [
    {
      badge: 'PARTIAL',
      title: 'Connect live audit-log feed',
      detail: 'Replace representative per-request bars with data from the runtime audit-log endpoint.',
      status: 'open',
    },
    {
      badge: 'PARTIAL',
      title: 'Persist run annotations',
      detail: 'Allow operators to store notes and close follow-up items from Admin.',
      status: 'open',
    },
    {
      badge: 'RESOLVED',
      title: 'Export run packet',
      detail: 'Package request totals, rendering checks, and tool coverage into a shareable report.',
      status: 'resolved',
    },
  ] as Blocker[],
  inRunTests: {
    testFiles: 42,
    tests: 640,
    failures: 0,
  },
  verification: [
    { item: 'npm run build', status: 'PASSED' as const, suffix: 'before stress' },
  ],
}

// ─── Page ──────────────────────────────────────────────────────────────

export function RunsPage() {
  const { lang } = useI18n()
  const copy = RUNS_TEXT[lang]
  return (
    <RunCopyContext.Provider value={copy}>
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
    </RunCopyContext.Provider>
  )
}

// ─── Header & hero ─────────────────────────────────────────────────────

function RunHeader() {
  const copy = useRunCopy()
  return (
    <header className="run-header">
      <div className="run-eyebrow">— {copy.reportEyebrow}</div>
      <h1 className="run-title" data-testid="run-title">
        {copy.reportTitle} <span className="run-title-suffix">/ {copy.titleSuffix}</span>
      </h1>
      <p className="run-description">{copy.description}</p>
    </header>
  )
}

function RunHeroStrip() {
  const copy = useRunCopy()
  return (
    <section className="run-hero-strip" data-testid="run-hero-strip">
      <HeroCell label={copy.runVerdict} wide>
        <span className={`run-hero-dot tone-${REPORT.verdict.tone}`} aria-hidden>●</span>
        <span data-testid="run-hero-verdict">{copy.verdictLabel}</span>
      </HeroCell>
      <HeroCell label={copy.packageCliDaemon}>
        <span className="run-hero-mono">{REPORT.packageVersion}</span>
        <span className="run-badge run-badge-ok run-badge-sm">{REPORT.daemonHealth}</span>
      </HeroCell>
      <HeroCell label={copy.daemon}>
        <span className="run-hero-mono">{REPORT.daemon}</span>
      </HeroCell>
      <HeroCell label={copy.runtime}>
        <span className="run-hero-mono">{REPORT.runtime}</span>
      </HeroCell>
      <HeroCell label={copy.npmRunBuild}>
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
  const copy = useRunCopy()
  const activeCount = REPORT.runs.length
  return (
    <section className="run-section" data-testid="runs-list">
      <SectionHeader title={copy.runs}>
        <span className="run-pill">{activeCount} {copy.active}</span>
      </SectionHeader>
      {REPORT.runs.map(run => <RunCardView key={run.id} run={run} />)}
    </section>
  )
}

function RunCardView({ run }: { run: RunCard }) {
  const copy = useRunCopy()
  const bullets = copy.bullets[run.id as keyof typeof copy.bullets] ?? run.bullets.map(b => b.text)
  return (
    <article
      className={`run-card run-card-${run.verdict}`}
      data-testid={`run-card-${run.id}`}
    >
      <header className="run-card-head">
        <strong>{run.id}</strong>{' '}
        <span className={`run-badge run-badge-${run.verdict === 'pass' ? 'ok' : 'warn'} run-badge-sm`}>
          {run.verdict === 'pass' ? copy.pass : copy.partial}
        </span>
        <div className="run-card-served">
          {copy.servedBy} <code>{run.servedBy}</code>
        </div>
      </header>
      <dl className="run-card-stats">
        <Stat label={copy.requests} value={String(run.requests)} />
        <Stat label={copy.http200} value={run.http200} tone="ok" />
        <Stat label={copy.fallback} value={run.fallback} />
        <Stat label={copy.duration} value={run.duration} tone={run.verdict === 'partial' ? 'warn' : undefined} />
      </dl>
      <ul className="run-card-bullets">
        {run.bullets.map((b, i) => (
          <li key={i} className={`run-bullet run-bullet-${b.tone}`}>
            <span className="run-bullet-icon" aria-hidden>{bulletIcon(b.tone)}</span>
            <span>{bullets[i] ?? b.text}</span>
          </li>
        ))}
      </ul>
      <footer className="run-card-foot">
        <span className="run-card-session">
          <span className="run-card-session-label">{copy.session}</span>{' '}
          <code>{run.sessionPath}</code>
        </span>
        <CopyButton text={run.sessionPath} label={copy.copy} testId={`run-card-${run.id}-copy`} />
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
  const copy = useRunCopy()
  const [view, setView] = useState<'all200' | 'streaming'>('all200')
  return (
    <section className="run-section" data-testid="audit-timeline">
      <SectionHeader
        title={copy.auditTimeline}
        subtitle={copy.representativeTimings}
      >
        <div className="run-toggle">
          <button
            type="button"
            className={view === 'all200' ? 'active' : ''}
            onClick={() => setView('all200')}
            data-testid="audit-toggle-all200"
          >{copy.all200}</button>
          <button
            type="button"
            className={view === 'streaming' ? 'active' : ''}
            onClick={() => setView('streaming')}
            data-testid="audit-toggle-streaming"
          >{copy.streaming}</button>
        </div>
      </SectionHeader>
      {REPORT.runs.map(run => (
        <RequestBars key={run.id} run={run} view={view} />
      ))}
      <p className="run-section-note">
        {copy.auditNote}
      </p>
    </section>
  )
}

function RequestBars({ run, view }: { run: RunCard; view: 'all200' | 'streaming' }) {
  const copy = useRunCopy()
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
            title={fmt(copy.requestTitle, { index: i + 1, seconds: (ms / 1000).toFixed(1), streaming: view === 'streaming' ? copy.streaming.toLowerCase() : '' })}
          />
        ))}
      </div>
      <span className="run-timeline-meta">
        {fmt(copy.reqsAll200, { count: run.requests })}
      </span>
    </div>
  )
}

// ─── Tool coverage ─────────────────────────────────────────────────────

function ToolCoverageSection() {
  const copy = useRunCopy()
  const [activeRun, setActiveRun] = useState<string>(REPORT.runs[REPORT.runs.length - 1]!.id)
  const run = REPORT.runs.find(r => r.id === activeRun) ?? REPORT.runs[0]!
  return (
    <section className="run-section" data-testid="tool-coverage">
      <SectionHeader
        title={fmt(copy.toolCoverage, { run: activeRun.toUpperCase() })}
        subtitle={copy.representativeCounts}
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
        {copy.toolCoverageNote}
      </p>
    </section>
  )
}

// ─── In-run tests ──────────────────────────────────────────────────────

function InRunTestsSection() {
  const copy = useRunCopy()
  const t = REPORT.inRunTests
  return (
    <section className="run-section" data-testid="in-run-tests">
      <SectionHeader title={copy.inRunTests}>
        <span className="run-badge run-badge-ok">{copy.passed}</span>
      </SectionHeader>
      <dl className="run-stat-strip">
        <Stat label={copy.testFiles} value={t.testFiles.toLocaleString()} tone="ok" />
        <Stat label={copy.tests} value={t.tests.toLocaleString()} tone="ok" />
        <Stat label={copy.failures} value={t.failures.toLocaleString()} tone={t.failures === 0 ? 'ok' : 'err'} />
      </dl>
      <p className="run-section-note">
        {copy.inRunTestsNote}
      </p>
    </section>
  )
}

// ─── Rendering verdict ─────────────────────────────────────────────────

function RenderingVerdictSection() {
  const copy = useRunCopy()
  const r = REPORT.rendering
  return (
    <section className="run-section" data-testid="rendering-verdict">
      <SectionHeader title={copy.renderingVerdict}>
        <span className="run-badge run-badge-ok">{r.verdict}</span>
      </SectionHeader>
      <ul className="run-check-list">
        {r.checks.map((c, i) => (
          <li key={i} className="run-check-row">
            <span className="run-check-icon tone-ok" aria-hidden>✓</span>
            <span>{copy.renderingChecks[i] ?? c}</span>
          </li>
        ))}
      </ul>
      <TerminalCapture />
      <div className="run-capture-caveat">
        <span>{copy.captureCaveat}</span>
        <CopyButton text={r.capturePath} label={copy.copyPath} testId="capture-copy-path" multiline />
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
  const copy = useRunCopy()
  return (
    <section className="run-section" data-testid="runtime-failures">
      <SectionHeader title={copy.runtimeFailureVerdicts}>
        <span className="run-badge run-badge-warn">{copy.partial}</span>
      </SectionHeader>
      <ul className="run-failure-list">
        {REPORT.runtimeFailures.map((f, i) => (
          <li key={i} className="run-failure-row" data-testid={`runtime-failure-${i}`}>
            <span className={`run-badge run-badge-${badgeTone(f.badge)} run-badge-sm`}>{badgeLabel(f.badge, copy)}</span>
            <div className="run-failure-body">
              <strong>{copy.runtimeFailures[i]?.title ?? f.title}</strong>
              <span>{copy.runtimeFailures[i]?.detail ?? f.detail}</span>
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

function badgeLabel(badge: 'PASS' | 'INFO' | 'PARTIAL' | 'OPEN' | 'RESOLVED', copy: RunCopy): string {
  switch (badge) {
    case 'PASS': return copy.pass
    case 'INFO': return copy.info
    case 'PARTIAL': return copy.partial
    case 'OPEN': return copy.open
    case 'RESOLVED': return copy.resolved
  }
}

// ─── Files changed ─────────────────────────────────────────────────────

function FilesChangedSection() {
  const copy = useRunCopy()
  const f = REPORT.filesChanged
  return (
    <section className="run-section" data-testid="files-changed">
      <SectionHeader title={fmt(copy.filesChangedBy, { lane: f.laneLabel.toUpperCase() })}>
        <span className="run-badge run-badge-ok">{copy.clean}</span>
      </SectionHeader>
      <div className="run-files-row">
        <span className="run-check-icon tone-ok" aria-hidden>✓</span>
        <span>
          {fmt(copy.filesChangedLine, { lane: f.laneLabel, count: f.count })}
        </span>
      </div>
      <p className="run-section-note">{copy.preExistingDirty}</p>
      <div className="run-chip-row">
        {f.preExistingDirty.map(item => (
          <span key={item} className="run-chip">{item}</span>
        ))}
      </div>
    </section>
  )
}

// ─── Follow-up items ───────────────────────────────────────────────────

function RemainingBlockersSection() {
  const copy = useRunCopy()
  const [filter, setFilter] = useState<'all' | 'open' | 'resolved'>('all')
  const filtered = useMemo(() => {
    const indexed = REPORT.blockers.map((blocker, index) => ({ blocker, index }))
    if (filter === 'all') return indexed
    return indexed.filter(item => item.blocker.status === filter)
  }, [filter])
  return (
    <section className="run-section" data-testid="remaining-blockers">
      <SectionHeader title={copy.remainingBlockers}>
        <div className="run-toggle">
          {(['all', 'open', 'resolved'] as const).map(v => (
            <button
              key={v}
              type="button"
              className={filter === v ? 'active' : ''}
              onClick={() => setFilter(v)}
              data-testid={`blockers-filter-${v}`}
            >{v === 'all' ? copy.all : v === 'open' ? copy.open : copy.resolved}</button>
          ))}
        </div>
      </SectionHeader>
      <ul className="run-blocker-list">
        {filtered.map(({ blocker: b, index }) => (
          <li key={index} className="run-blocker-row" data-testid={`blocker-${index}`}>
            <span className={`run-badge run-badge-${badgeTone(b.badge)} run-badge-sm`}>{badgeLabel(b.badge, copy)}</span>
            <div className="run-blocker-body">
              <strong>{copy.blockers[index]?.title ?? b.title}</strong>
              <span>{copy.blockers[index]?.detail ?? b.detail}</span>
            </div>
            <button
              type="button"
              className="run-blocker-action"
              data-testid={`blocker-${index}-resolve`}
              disabled
              title={copy.trackedInReportTitle}
            >{copy.trackedInReport}</button>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ─── Verification ──────────────────────────────────────────────────────

function VerificationSection() {
  const copy = useRunCopy()
  return (
    <section className="run-section" data-testid="verification">
      <SectionHeader title={copy.verification}>
        <span className="run-badge run-badge-ok">{copy.pass}</span>
      </SectionHeader>
      <ul className="run-verify-list">
        {REPORT.verification.map((v, i) => (
          <li key={i} className="run-verify-row">
            <code>{v.item}</code>
            <span className="run-badge run-badge-ok run-badge-sm">{v.status === 'PASSED' ? copy.passed : v.status}</span>
            <span className="run-verify-suffix">{v.suffix === 'before stress' ? copy.beforeStress : v.suffix}</span>
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
  const copy = useRunCopy()
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
    >{copied ? copy.copied : label}</button>
  )
}
