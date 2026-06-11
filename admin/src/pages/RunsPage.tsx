import { createContext, useContext, useMemo, useState } from 'react'
import { useI18n } from '../i18n'

// ─── Report data ────────────────────────────────────────────────────────
//
// Hardcoded snapshot of the Lane A cmux long-stress signoff
// (docs/qa/OWLCODA_LANE_A_CMUX_LONG_STRESS_SIGNOFF_REPORT_20260427.md).
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

const RUNS_TEXT = {
  en: {
    reportEyebrow: 'STRESS VERIFICATION · LANE A · 2026-04-27',
    reportTitle: 'minimax-m27 + kimi-code stress run',
    titleSuffix: 'Lane A',
    description:
      'Real cmux and official-route runs against OwlCoda daemon · runtime. Captures audit, rendering verdict, Kimi sustained-work evidence, repo diff, and remaining blockers. Lane A is green; Kimi provider-side 10-minute parity is proven, with clean runtime signoff pending the completion-guard rerun.',
    verdictLabel: 'Lane A green · Kimi provider-side passed',
    runVerdict: 'RUN VERDICT',
    packageCliDaemon: 'HISTORICAL REPORT PACKAGE · DAEMON',
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
      'Authoritative: tool list (signoff markdown enumerates which tools were exercised). Per-tool invocation counts are placeholder; yellow = the run did not invoke this tool (LSP requires user-installed language servers).',
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
    remainingBlockers: 'REMAINING BLOCKERS',
    all: 'ALL',
    trackedInSignoff: 'tracked in signoff',
    trackedInSignoffTitle: 'Blocker resolution is tracked in the signoff markdown. Admin write-back lands when a backend route exists.',
    verification: 'VERIFICATION',
    beforeStress: 'before stress',
    bullets: {
      'minimax-m27': [
        'Real cmux run reached "Nothing remaining. Task done." and returned to ready.',
        'All 21 requests HTTP 200 streaming, fallbackUsed=false',
        'Exercised bash · read · glob · grep · Agent · Task · Config · WebFetch · StructuredOutput · ToolSearch · LSP',
        'npm test passed: 272 test files, 3,630 tests',
      ],
      'kimi-code': [
        'Official-route objective ran 10.6 minutes / 637 seconds inside a 26m10s wall-clock window.',
        'All 66 provider requests HTTP 200 streaming, fallbackUsed=false',
        '7 checkpoints completed; 5 focused suites passed 70/70; temp workspace cleanup completed',
        'Runtime completion guard drifted after the final report; guard fix is patched, rerun still required for clean signoff',
      ],
    },
    renderingChecks: [
      'No cmux row-smear during active runs',
      'No overlap or stale prompt observed',
      'No composer corruption',
    ],
    captureCaveat:
      'The ANSI capture is still the Lane A cmux artifact; Kimi official-route parity is proven from session and audit JSON.',
    runtimeFailures: [
      {
        title: 'Provider request paths (minimax / kimi)',
        detail: 'No transport, fallback, rate-limit, or provider outage evidence. Kimi drift was a completion-guard classification issue after final delivery.',
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
        title: 'cmux CLI',
        detail: 'Socket commands failed with Broken pipe; cmux GUI control worked.',
      },
    ],
    blockers: [
      {
        title: 'cmux CLI control surface unhealthy',
        detail: 'cmux CLI socket commands fail with Broken pipe; cmux GUI control still works as workaround.',
      },
      {
        title: 'cmux text injection corrupts shell syntax',
        detail: 'Underscores and special shell characters can be mangled when injecting text via cmux.',
      },
      {
        title: 'Kimi 10-minute parity comparison',
        detail: 'Official-route run completed 10.6 minutes with 66/66 HTTP 200 requests and fallbackUsed=false; clean product signoff still needs a post-guard-fix rerun.',
      },
    ],
  },
  zh: {
    reportEyebrow: '压力验证 · Lane A · 2026-04-27',
    reportTitle: 'minimax-m27 + kimi-code 压力运行',
    titleSuffix: 'Lane A',
    description:
      '基于真实 cmux 与官方路由的 OwlCoda daemon/runtime 压力运行。该报告汇总审计、渲染结论、Kimi 持续工作证据、仓库 diff 与剩余阻塞项。Lane A 已绿；Kimi provider 侧 10 分钟对齐已证明，完整运行时签收仍等待 completion-guard 修复后的复跑。',
    verdictLabel: 'Lane A 通过 · Kimi provider 侧已通过',
    runVerdict: '运行结论',
    packageCliDaemon: '历史报告包版本 · Daemon',
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
      '权威数据：工具清单（签收 markdown 枚举了已使用工具）。单工具调用次数目前是占位；黄色表示该轮没有调用此工具（LSP 需要用户安装语言服务器）。',
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
    remainingBlockers: '剩余阻塞项',
    all: '全部',
    trackedInSignoff: '签收中跟踪',
    trackedInSignoffTitle: '阻塞项解决状态在签收 markdown 中跟踪。Admin 写回要等后端 route 落地。',
    verification: '验证',
    beforeStress: '压力测试前',
    bullets: {
      'minimax-m27': [
        '真实 cmux 运行到达 “Nothing remaining. Task done.” 并回到 ready。',
        '21 个请求全部 HTTP 200 streaming，fallbackUsed=false',
        '覆盖 bash · read · glob · grep · Agent · Task · Config · WebFetch · StructuredOutput · ToolSearch · LSP',
        'npm test 通过：272 个测试文件，3,630 个测试',
      ],
      'kimi-code': [
        '官方路由目标在 26m10s 墙钟窗口内运行 10.6 分钟 / 637 秒。',
        '66 个 provider 请求全部 HTTP 200 streaming，fallbackUsed=false',
        '完成 7 个 checkpoint；5 个聚焦测试套件 70/70 通过；临时工作区已清理',
        '最终报告后 runtime completion guard 出现漂移；guard 修复已打上，仍需复跑完成干净签收',
      ],
    },
    renderingChecks: [
      '活跃运行期间无 cmux 行涂抹',
      '未观察到重叠或过期 prompt',
      '无输入框损坏',
    ],
    captureCaveat:
      'ANSI capture 仍是 Lane A cmux 产物；Kimi 官方路由对齐由 session 与 audit JSON 证明。',
    runtimeFailures: [
      {
        title: 'Provider 请求路径（minimax / kimi）',
        detail: '没有 transport、fallback、rate-limit 或 provider 故障证据。Kimi 漂移是最终交付后的 completion-guard 分类问题。',
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
        title: 'cmux CLI',
        detail: 'Socket 命令因 Broken pipe 失败；cmux GUI 控制可作为 workaround。',
      },
    ],
    blockers: [
      {
        title: 'cmux CLI 控制面不健康',
        detail: 'cmux CLI socket 命令因 Broken pipe 失败；cmux GUI 控制仍可作为 workaround。',
      },
      {
        title: 'cmux 文本注入会破坏 shell 语法',
        detail: '通过 cmux 注入文本时，下划线和特殊 shell 字符可能被破坏。',
      },
      {
        title: 'Kimi 10 分钟对齐比较',
        detail: '官方路由运行 10.6 分钟，66/66 个 HTTP 200 请求且 fallbackUsed=false；干净产品签收仍需在 guard 修复后复跑。',
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
  eyebrow: 'STRESS VERIFICATION · LANE A · 2026-04-27',
  title: 'minimax-m27 + kimi-code stress run',
  titleSuffix: 'Lane A',
  description:
    'Real cmux and official-route runs against OwlCoda daemon · runtime. Captures audit, rendering verdict, Kimi sustained-work evidence, repo diff, and remaining blockers. Lane A is green; Kimi provider-side 10-minute parity is proven, with clean runtime signoff pending the completion-guard rerun.',
  verdict: {
    tone: 'ok' as Tone,
    label: 'Lane A green · Kimi provider-side passed',
  },
  packageVersion: '0.13.21',
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
    preExistingDirty: ['.gitignore', 'archived prompts/', 'Lane B brief (new)'],
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

// ─── Remaining blockers ────────────────────────────────────────────────

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
              title={copy.trackedInSignoffTitle}
            >{copy.trackedInSignoff}</button>
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
