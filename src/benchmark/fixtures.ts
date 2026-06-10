import type { BenchmarkCaseFixture } from './types.js'

// ---------------------------------------------------------------------------
// Fixture content constants for deck-12p mockResponseSequence
// These are intentionally compact placeholder outputs — just enough
// for the live runner to verify artifact presence and final status.
// ---------------------------------------------------------------------------

const DECK_12P_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Industrial AI Agent Pilot Retrospective</title></head>
<body>
<section id="s1"><h1>Overview</h1><p>12-page retrospective deck on industrial AI agent pilot.</p></section>
<section id="s2"><h2>Pilot Scope</h2><p>Six-week pilot across three factory lines.</p></section>
<section id="s3"><h2>Objectives</h2><p>Reduce downtime, improve throughput, cut defect rate.</p></section>
<section id="s4"><h2>Team</h2><p>AI engineers, domain experts, plant operators.</p></section>
<section id="s5"><h2>Architecture</h2><p>Event-driven pipeline with edge inference nodes.</p></section>
<section id="s6"><h2>Timeline</h2><p>Week 1-2 data; week 3-4 training; week 5-6 deploy.</p></section>
<section id="s7"><h2>Results: Downtime</h2><p>-23% unplanned downtime vs baseline.</p></section>
<section id="s8"><h2>Results: Throughput</h2><p>+8% units per shift.</p></section>
<section id="s9"><h2>Results: Defects</h2><p>-15% defect rate in target line.</p></section>
<section id="s10"><h2>Challenges</h2><p>Data quality gaps, operator trust, integration latency.</p></section>
<section id="s11"><h2>Lessons Learned</h2><p>Instrument before optimising; keep humans in the loop.</p></section>
<section id="s12"><h2>Next Steps</h2><p>Scale to all lines; add continuous retraining pipeline.</p></section>
</body>
</html>`

const DECK_12P_BUILD_NOTES = `# Build Notes — deck-12p

## Sections
12 sections (s1–s12) matching requested page count.

## Approach
Compact placeholder HTML; sections cover full retrospective arc from scope to next steps.

## Artifacts
- deck.html: ~1.4 KB HTML
- build-notes.md: this file
`

// ---------------------------------------------------------------------------
// Fixture content constants for deck-46p mockResponseSequence
// ---------------------------------------------------------------------------

const DECK_46P_SECTION_TITLES = [
  'Executive framing',
  'Why industrial agents now',
  'Board-level outcomes',
  'Operating model overview',
  'Plant data foundation',
  'Edge-to-cloud topology',
  'Agent role catalog',
  'Human supervision model',
  'Reliability baseline',
  'Quality inspection loop',
  'Maintenance triage loop',
  'Scheduling support loop',
  'Energy optimization loop',
  'Safety observation loop',
  'Knowledge capture loop',
  'Procurement signal loop',
  'Operator adoption path',
  'P18 - Governance Control Room',
  'Control policy layers',
  'Model connection layer',
  'Tool permission model',
  'Trace and evidence ledger',
  'Incident escalation flow',
  'Data quality scorecard',
  'KPI measurement design',
  'Pilot wave one',
  'Pilot wave two',
  'Factory rollout ladder',
  'Integration with MES',
  'Integration with ERP',
  'Integration with CMMS',
  'Cybersecurity posture',
  'Model lifecycle management',
  'Cost envelope',
  'P35 - Verification Ladder',
  'Acceptance gates',
  'Change management plan',
  'Training and enablement',
  'Support operating rhythm',
  'Vendor boundary map',
  'Risk register',
  'Financial case',
  'Ninety day roadmap',
  'One year roadmap',
  'Decision requests',
  'Closing narrative',
] as const

const DECK_46P_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Industrial AI Agent Operating System</title></head>
<body>
${DECK_46P_SECTION_TITLES.map((title, index) => {
  const page = index + 1
  return `<section id="p${page}">
<h2>P${page} ${title}</h2>
<p>This page describes the operating implication of ${title.toLowerCase()} for a multi-site industrial AI agent program. It names the decision owner, the production signal that proves progress, and the artifact that should survive handoff into implementation.</p>
<p>The page is intentionally content-bearing rather than a heading placeholder: it gives the release smoke runner a realistic long-deck shape with enough body text to exercise artifact verification, section counting, and structured progress before the first write.</p>
</section>`
}).join('\n')}
</body>
</html>`

const DECK_46P_BUILD_NOTES = `# Build Notes — deck-46p

## Sections
46 HTML sections are generated from the long-deck topic list.

## Structured Progress Shape
- TaskCreate records deck.html and build-notes.md as explicit deliverables.
- TaskUpdate advances planning forms across outline, evidence, layout, and verification phases before the first write.
- ArtifactVerify runs the html_deck verification pack against the written deck.
- TaskVerify writes deterministic verification results back to the task step before completion.

## Verification
- Expected section count: 46
- Required markers: P18 - Governance Control Room; P35 - Verification Ladder
- Minimum file size and section body checks guard against a short placeholder deck.
`

// ---------------------------------------------------------------------------
// Fixture content for deck-46p-realistic — minimal but realistic trajectory
// that simulates the A1/A2/A3 failure mode from the 0.14.22 prod eval.
// ---------------------------------------------------------------------------

const DECK_46P_REALISTIC_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>工业 AI Agent 系统</title></head>
<body>
<section id="s1"><h1>工业 AI Agent：从单点模型到企业级智能体系统</h1></section>
<section id="s2"><h2>目录</h2><p>全书 46 页，覆盖技术架构、案例、治理三大主题。</p></section>
</body>
</html>`

const DECK_46P_REALISTIC_BUILD_NOTES = `# Build Notes — deck-46p-realistic

## Description
Realistic trajectory fixture for Patch 1 regression.
Simulates model reading a template then writing via heredoc bash.

## Artifacts
- test.html: minimal deck HTML
- build-notes.md: this file
`

const CODE_FIX_PATCH = `diff --git a/src/score.ts b/src/score.ts
index 7b1c2aa..0c4f1de 100644
--- a/src/score.ts
+++ b/src/score.ts
@@ -1,5 +1,7 @@
 export function normalizeScore(input: number): number {
-  return Math.min(100, input)
+  if (!Number.isFinite(input)) return 0
+  return Math.min(100, Math.max(0, input))
 }
`

const CODE_FIX_TEST_RESULT = `Command: npx vitest run tests/unit/score.test.ts --reporter=dot

PASS tests/unit/score.test.ts
  normalizeScore clamps negative values to zero
  normalizeScore caps values above 100
  normalizeScore converts non-finite values to zero

Test Files  1 passed (1)
Tests       3 passed (3)
`

const RESEARCH_NOTE_MARKDOWN = `# Source-backed Research Note

## Question
How should a small industrial AI pilot decide whether to invest in more data collection before model tuning?

## Findings
The strongest near-term investment is better instrumentation, not a larger model. Production teams need stable event definitions, operator annotations, and a shared defect ledger before optimization claims can be trusted [source: manufacturing data readiness memo].

The pilot should separate three layers of evidence: raw sensor coverage, reviewed event labels, and intervention outcomes. That structure lets reviewers distinguish missing evidence from a model miss [source: quality systems handbook].

## Recommendation
Approve a two-week data readiness sprint. The sprint should produce a source map, a gap log, and a reviewed sample of incidents before any model benchmark is treated as release evidence.

## Sources
- manufacturing data readiness memo
- quality systems handbook
`

const DATA_REPORT_MARKDOWN = `# Data Report

## Summary
The sample dataset shows higher throughput in east and west regions after workflow changes, while the north region remains below target. The table artifact records the baseline, actual result, and percentage delta used for this conclusion.

## Findings
- East improved from 100 to 112 units, a 12 percent lift.
- West improved from 92 to 101 units, a 9.8 percent lift.
- North moved from 88 to 87 units, a 1.1 percent decline.

## Follow-up
Investigate the north region before expanding the change. The summary.csv artifact is the durable table for downstream charting and review.
`

const DATA_REPORT_CSV = `region,baseline,actual,delta_pct
east,100,112,12.0
west,92,101,9.8
north,88,87,-1.1
`

const BASE_EVAL_AUDIT_FIELDS = [
  'artifact_list',
  'final_status',
  'task_no_progress',
  'tool_sequence',
  'verification_results',
] as const

const DECK_EVAL_AUDIT_FIELDS = [
  ...BASE_EVAL_AUDIT_FIELDS,
  'section_count',
  'timeout_sentinel',
] as const

export const BENCHMARK_CASE_FIXTURES: BenchmarkCaseFixture[] = [
  {
    caseId: 'deck-46p',
    title: 'Industrial AI 46 page HTML deck',
    taskFamily: 'deck',
    deliverableMode: 'file_artifact_delivery',
    prompt: 'Create a long-form HTML deck about industrial AI agents with build notes. For release smoke, produce at least 30 content-bearing sections; exact full-length quality evaluation is handled by the separate heavy gate. Write the artifacts to these exact paths: __WORKSPACE__/deck.html and __WORKSPACE__/build-notes.md.',
    expectedOutputs: ['deck.html', 'build-notes.md'],
    evalPolicy: {
      expectedArtifactPaths: ['__WORKSPACE__/deck.html', '__WORKSPACE__/build-notes.md'],
      auditFields: [...DECK_EVAL_AUDIT_FIELDS],
      timeoutMs: 15 * 60 * 1000,
      keepalive: 'progress_sentinel',
      comparisonHarness: 'scripted_mock',
      sectionPolicy: { smokeMinSections: 30, heavyExactSections: 46, exactSectionsGate: 'heavy_eval' },
    },
    dryRun: {
      selectedSkill: 'guizang-ppt-skill',
      timeToFirstWriteMs: 1350,
      readCallsBeforeFirstWrite: 0,
      artifacts: [
        { path: 'deck-46p/deck.html', kind: 'html_deck', exists: true, bytes: DECK_46P_HTML.length, source: 'dry_run' },
        { path: 'deck-46p/build-notes.md', kind: 'build_notes', exists: true, bytes: DECK_46P_BUILD_NOTES.length, source: 'dry_run' },
      ],
      verification: [
        {
          id: 'deck-46p.section_count',
          kind: 'html_deck.section_count',
          status: 'passed',
          passed: true,
          expected: 46,
          actual: 46,
          message: '46 sections recorded for the target deck.',
        },
        {
          id: 'deck-46p.title_placeholder',
          kind: 'html_deck.title_placeholder',
          status: 'passed',
          passed: true,
          expected: false,
          actual: false,
          message: 'No title placeholder recorded in dry-run output.',
        },
        {
          id: 'deck-46p.build_notes_exists',
          kind: 'html_deck.build_notes_exists',
          status: 'passed',
          passed: true,
          expected: true,
          actual: true,
          message: 'Build notes artifact is present.',
        },
        {
          id: 'deck-46p.required_markers',
          kind: 'html_deck.required_marker',
          status: 'passed',
          passed: true,
          expected: true,
          actual: true,
          message: 'P18 and P35 special page markers are present.',
        },
      ],
      taskNoProgress: { hard: 0, suppressed: 0 },
      finalStatus: 'passed',
      mockResponseSequence: [
        {
          text: 'I will create the long-deck task plan before writing files.',
          toolUse: [
            {
              toolName: 'TaskCreate',
              input: {
                subject: 'Build 46-page industrial AI deck',
                description: 'Create deck.html and build-notes.md in the run workspace, then verify the long deck shape.',
                deliverables: [
                  { path: '__WORKSPACE__/deck.html', kind: 'file', origin: 'explicit' },
                  { path: '__WORKSPACE__/build-notes.md', kind: 'file', origin: 'explicit' },
                ],
                steps: [
                  {
                    id: 'step-1',
                    title: 'Write and verify 46-page deck artifacts',
                    description: 'Produce the long HTML deck and build notes, then run artifact and task verification.',
                    expectedArtifacts: [
                      { path: '__WORKSPACE__/deck.html', kind: 'file', origin: 'explicit' },
                      { path: '__WORKSPACE__/build-notes.md', kind: 'file', origin: 'explicit' },
                    ],
                    verification: [
                      {
                        id: 'deck-46p',
                        kind: 'verification_pack',
                        packId: 'html_deck',
                        deckPath: '__WORKSPACE__/deck.html',
                        buildNotesPath: '__WORKSPACE__/build-notes.md',
                        expectedSections: 46,
                        requiredMarkers: [
                          'P18 - Governance Control Room',
                          'P35 - Verification Ladder',
                        ],
                        minFileSizeBytes: 10000,
                        minSectionBytes: 200,
                      },
                    ],
                  },
                ],
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 30, output_tokens: 18 },
        },
        {
          text: 'Starting the long-deck build step.',
          toolUse: [{ toolName: 'TaskUpdate', input: { taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 31, output_tokens: 7 },
        },
        {
          text: 'Structuring the 46-page outline.',
          toolUse: [{ toolName: 'TaskUpdate', input: { taskId: 'task-1', activeForm: 'outline-46-pages' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 32, output_tokens: 7 },
        },
        {
          text: 'Mapping the executive narrative.',
          toolUse: [{ toolName: 'TaskUpdate', input: { taskId: 'task-1', activeForm: 'narrative-spine' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 33, output_tokens: 7 },
        },
        {
          text: 'Mapping the operations cases.',
          toolUse: [{ toolName: 'TaskUpdate', input: { taskId: 'task-1', activeForm: 'case-evidence-map' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 34, output_tokens: 7 },
        },
        {
          text: 'Mapping governance and verification pages.',
          toolUse: [{ toolName: 'TaskUpdate', input: { taskId: 'task-1', activeForm: 'governance-verification-map' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 35, output_tokens: 7 },
        },
        {
          text: 'Preparing slide system and section density.',
          toolUse: [{ toolName: 'TaskUpdate', input: { taskId: 'task-1', activeForm: 'slide-system' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 36, output_tokens: 7 },
        },
        {
          text: 'Preparing artifact verification inputs.',
          toolUse: [{ toolName: 'TaskUpdate', input: { taskId: 'task-1', activeForm: 'verification-pack-inputs' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 37, output_tokens: 7 },
        },
        {
          text: 'Ready to write the long deck artifacts.',
          toolUse: [{ toolName: 'TaskUpdate', input: { taskId: 'task-1', activeForm: 'ready-to-write-long-deck' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 38, output_tokens: 7 },
        },
        {
          text: 'Writing the 46-page HTML deck.',
          toolUse: [
            {
              toolName: 'write',
              input: {
                path: '__WORKSPACE__/deck.html',
                content: DECK_46P_HTML,
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 39, output_tokens: 12 },
        },
        {
          text: 'Writing build notes for the long deck.',
          toolUse: [
            {
              toolName: 'write',
              input: {
                path: '__WORKSPACE__/build-notes.md',
                content: DECK_46P_BUILD_NOTES,
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 40, output_tokens: 10 },
        },
        {
          text: 'Running artifact verification for the 46-page deck.',
          toolUse: [
            {
              toolName: 'ArtifactVerify',
              input: {
                packId: 'html_deck',
                deckPath: '__WORKSPACE__/deck.html',
                buildNotesPath: '__WORKSPACE__/build-notes.md',
                expectedSections: 46,
                requiredMarkers: [
                  'P18 - Governance Control Room',
                  'P35 - Verification Ladder',
                ],
                minFileSizeBytes: 10000,
                minSectionBytes: 200,
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 41, output_tokens: 10 },
        },
        {
          text: 'Writing task verification results back to the active step.',
          toolUse: [{ toolName: 'TaskVerify', input: { taskId: 'task-1', stepId: 'step-1' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 42, output_tokens: 10 },
        },
        {
          text: 'Marking the 46-page deck step complete after verification.',
          toolUse: [
            {
              toolName: 'TaskUpdate',
              input: {
                taskId: 'task-1',
                stepId: 'step-1',
                stepStatus: 'completed',
                touchedPaths: ['__WORKSPACE__/deck.html', '__WORKSPACE__/build-notes.md'],
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 43, output_tokens: 10 },
        },
        {
          text: 'Done. deck.html has 46 sections and build-notes.md records the verification path.',
          toolUse: [],
          stopReason: 'end_turn',
          usage: { input_tokens: 44, output_tokens: 18 },
        },
      ],
    },
  },
  {
    caseId: 'deck-12p',
    title: 'Industrial AI 12 page HTML deck',
    taskFamily: 'deck',
    deliverableMode: 'file_artifact_delivery',
    prompt: 'Create a 12 page HTML deck about an industrial AI agent pilot retrospective. Write the artifacts to these exact paths: __WORKSPACE__/deck.html and __WORKSPACE__/build-notes.md.',
    expectedOutputs: ['deck.html', 'build-notes.md'],
    evalPolicy: {
      expectedArtifactPaths: ['__WORKSPACE__/deck.html', '__WORKSPACE__/build-notes.md'],
      auditFields: [...DECK_EVAL_AUDIT_FIELDS],
      timeoutMs: 15 * 60 * 1000,
      keepalive: 'progress_sentinel',
      comparisonHarness: 'scripted_mock',
    },
    dryRun: {
      selectedSkill: 'guizang-ppt-skill',
      timeToFirstWriteMs: 720,
      readCallsBeforeFirstWrite: 2,
      artifacts: [
        { path: 'deck-12p/deck.html', kind: 'html_deck', exists: true, bytes: 42000, source: 'dry_run' },
        { path: 'deck-12p/build-notes.md', kind: 'build_notes', exists: true, bytes: 1600, source: 'dry_run' },
      ],
      verification: [
        {
          id: 'deck-12p.deck_exists',
          kind: 'task_verify.file_exists',
          status: 'passed',
          passed: true,
          expected: true,
          actual: true,
          message: 'TaskVerify confirms deck.html exists.',
        },
        {
          id: 'deck-12p.notes_exists',
          kind: 'task_verify.file_exists',
          status: 'passed',
          passed: true,
          expected: true,
          actual: true,
          message: 'TaskVerify confirms build-notes.md exists.',
        },
      ],
      taskNoProgress: { hard: 0, suppressed: 0 },
      finalStatus: 'passed',
      mockResponseSequence: [
        {
          text: 'I will create a structured task plan before writing the deck.',
          toolUse: [
            {
              toolName: 'TaskCreate',
              input: {
                subject: 'Build 12-page industrial AI deck',
                description: 'Create deck.html and build-notes.md in the run workspace.',
                deliverables: [
                  { path: '__WORKSPACE__/deck.html', kind: 'file', origin: 'explicit' },
                  { path: '__WORKSPACE__/build-notes.md', kind: 'file', origin: 'explicit' },
                ],
                steps: [
                  {
                    id: 'step-1',
                    title: 'Write and verify deck artifacts',
                    description: 'Produce the HTML deck and build notes, then verify both files exist.',
                    expectedArtifacts: [
                      { path: '__WORKSPACE__/deck.html', kind: 'file', origin: 'explicit' },
                      { path: '__WORKSPACE__/build-notes.md', kind: 'file', origin: 'explicit' },
                    ],
                    verification: [
                      { id: 'deck-12p.deck_exists', kind: 'file_exists', path: '__WORKSPACE__/deck.html' },
                      { id: 'deck-12p.notes_exists', kind: 'file_exists', path: '__WORKSPACE__/build-notes.md' },
                    ],
                  },
                ],
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 8 },
        },
        {
          text: 'Starting the structured step.',
          toolUse: [{ toolName: 'TaskUpdate', input: { taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 11, output_tokens: 6 },
        },
        {
          text: 'Planning section outline.',
          toolUse: [{ toolName: 'TaskUpdate', input: { taskId: 'task-1', activeForm: 'outline' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 12, output_tokens: 6 },
        },
        {
          text: 'Planning artifact layout.',
          toolUse: [{ toolName: 'TaskUpdate', input: { taskId: 'task-1', activeForm: 'layout' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 13, output_tokens: 6 },
        },
        {
          text: 'Planning verification checks.',
          toolUse: [{ toolName: 'TaskUpdate', input: { taskId: 'task-1', activeForm: 'verification-plan' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 14, output_tokens: 6 },
        },
        {
          text: 'Preparing final write.',
          toolUse: [{ toolName: 'TaskUpdate', input: { taskId: 'task-1', activeForm: 'ready-to-write' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 15, output_tokens: 6 },
        },
        {
          text: 'Keeping the structured task active before the first artifact write.',
          toolUse: [{ toolName: 'TaskUpdate', input: { taskId: 'task-1', activeForm: 'pre-write-check' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 16, output_tokens: 6 },
        },
        {
          text: 'One more structured-progress turn before writing.',
          toolUse: [{ toolName: 'TaskUpdate', input: { taskId: 'task-1', activeForm: 'write-now' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 17, output_tokens: 6 },
        },
        {
          text: 'Good. Now writing the 12-page HTML deck.',
          toolUse: [
            {
              toolName: 'write',
              input: {
                path: '__WORKSPACE__/deck.html',
                content: DECK_12P_HTML,
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 18, output_tokens: 10 },
        },
        {
          text: '',
          toolUse: [
            {
              toolName: 'write',
              input: {
                path: '__WORKSPACE__/build-notes.md',
                content: DECK_12P_BUILD_NOTES,
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 19, output_tokens: 8 },
        },
        {
          text: 'Verifying both artifacts.',
          toolUse: [{ toolName: 'TaskVerify', input: { taskId: 'task-1', stepId: 'step-1' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 20, output_tokens: 8 },
        },
        {
          text: 'Marking the step complete after verification.',
          toolUse: [
            {
              toolName: 'TaskUpdate',
              input: {
                taskId: 'task-1',
                stepId: 'step-1',
                stepStatus: 'completed',
                touchedPaths: ['__WORKSPACE__/deck.html', '__WORKSPACE__/build-notes.md'],
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 21, output_tokens: 8 },
        },
        {
          text: 'Done. deck.html (12 sections, ~42KB) and build-notes.md are written.',
          toolUse: [],
          stopReason: 'end_turn',
          usage: { input_tokens: 22, output_tokens: 20 },
        },
      ],
    },
  },
  {
    caseId: 'code-fix-tests',
    title: 'Small code fix with tests',
    taskFamily: 'code',
    deliverableMode: 'code_change',
    prompt: 'Fix a small bug and run the focused test. Write the patch and test evidence to these exact paths: __WORKSPACE__/code-fix-tests/patch.diff and __WORKSPACE__/code-fix-tests/test-result.txt.',
    expectedOutputs: ['patch.diff', 'test-result.txt'],
    evalPolicy: {
      expectedArtifactPaths: ['__WORKSPACE__/code-fix-tests/patch.diff', '__WORKSPACE__/code-fix-tests/test-result.txt'],
      auditFields: [...BASE_EVAL_AUDIT_FIELDS, 'timeout_sentinel'],
      timeoutMs: 15 * 60 * 1000,
      keepalive: 'progress_sentinel',
      comparisonHarness: 'scripted_mock',
    },
    dryRun: {
      selectedSkill: null,
      timeToFirstWriteMs: 540,
      readCallsBeforeFirstWrite: 3,
      artifacts: [
        { path: 'code-fix-tests/patch.diff', kind: 'patch', exists: true, bytes: 2400, source: 'dry_run' },
        { path: 'code-fix-tests/test-result.txt', kind: 'test_result', exists: true, bytes: 280, source: 'dry_run' },
      ],
      verification: [
        {
          id: 'code-fix-tests.focused_test',
          kind: 'code_change.test_command',
          status: 'passed',
          passed: true,
          expected: true,
          actual: true,
          message: 'Focused test command recorded as passing.',
        },
      ],
      taskNoProgress: { hard: 0, suppressed: 0 },
      finalStatus: 'passed',
      mockResponseSequence: [
        {
          text: 'I will create a tracked code-fix task before writing patch and test artifacts.',
          toolUse: [
            {
              toolName: 'TaskCreate',
              input: {
                subject: 'Fix normalizeScore and record focused test',
                description: 'Write a patch artifact and focused test result, then verify the recorded test pass.',
                deliverables: [
                  { path: '__WORKSPACE__/code-fix-tests/patch.diff', kind: 'file', origin: 'explicit' },
                  { path: '__WORKSPACE__/code-fix-tests/test-result.txt', kind: 'file', origin: 'explicit' },
                ],
                steps: [
                  {
                    id: 'step-1',
                    title: 'Write code patch and focused test evidence',
                    description: 'Produce patch.diff and test-result.txt for the small code fix.',
                    expectedArtifacts: [
                      { path: '__WORKSPACE__/code-fix-tests/patch.diff', kind: 'file', origin: 'explicit' },
                      { path: '__WORKSPACE__/code-fix-tests/test-result.txt', kind: 'file', origin: 'explicit' },
                    ],
                    verification: [
                      {
                        id: 'code-fix-tests.focused_test',
                        kind: 'file_contains',
                        path: '__WORKSPACE__/code-fix-tests/test-result.txt',
                        pattern: 'PASS tests/unit/score\\.test\\.ts',
                      },
                    ],
                  },
                ],
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 8 },
        },
        {
          text: 'Starting the code-fix evidence step.',
          toolUse: [{ toolName: 'TaskUpdate', input: { taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 11, output_tokens: 6 },
        },
        {
          text: 'Checking the target source shape before writing patch evidence.',
          toolUse: [{ toolName: 'read', input: { path: '__WORKSPACE__/src/score.ts' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 12, output_tokens: 6 },
        },
        {
          text: 'Writing patch.diff for the normalizeScore fix.',
          toolUse: [
            {
              toolName: 'write',
              input: {
                path: '__WORKSPACE__/code-fix-tests/patch.diff',
                content: CODE_FIX_PATCH,
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 13, output_tokens: 8 },
        },
        {
          text: 'Writing the focused test result artifact.',
          toolUse: [
            {
              toolName: 'write',
              input: {
                path: '__WORKSPACE__/code-fix-tests/test-result.txt',
                content: CODE_FIX_TEST_RESULT,
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 14, output_tokens: 8 },
        },
        {
          text: 'Verifying the focused test artifact contains the passing command result.',
          toolUse: [{ toolName: 'TaskVerify', input: { taskId: 'task-1', stepId: 'step-1' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 15, output_tokens: 8 },
        },
        {
          text: 'Marking the code-fix step complete after verification.',
          toolUse: [
            {
              toolName: 'TaskUpdate',
              input: {
                taskId: 'task-1',
                stepId: 'step-1',
                stepStatus: 'completed',
                touchedPaths: [
                  '__WORKSPACE__/code-fix-tests/patch.diff',
                  '__WORKSPACE__/code-fix-tests/test-result.txt',
                ],
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 16, output_tokens: 8 },
        },
        {
          text: 'Done. patch.diff and test-result.txt are written and verified.',
          toolUse: [],
          stopReason: 'end_turn',
          usage: { input_tokens: 17, output_tokens: 14 },
        },
      ],
    },
  },
  {
    caseId: 'readonly-review',
    title: 'Read-only multi-file review',
    taskFamily: 'read_only_review',
    deliverableMode: 'read_only_review',
    prompt: 'Review selected files without modifying or creating artifacts.',
    expectedOutputs: ['chat report'],
    evalPolicy: {
      expectedArtifactPaths: [],
      auditFields: [...BASE_EVAL_AUDIT_FIELDS, 'timeout_sentinel'],
      timeoutMs: 15 * 60 * 1000,
      keepalive: 'progress_sentinel',
      comparisonHarness: 'scripted_mock',
    },
    dryRun: {
      selectedSkill: null,
      timeToFirstWriteMs: 0,
      readCallsBeforeFirstWrite: 5,
      artifacts: [],
      verification: [
        {
          id: 'readonly-review.no_artifacts',
          kind: 'read_only_review.no_artifacts',
          status: 'passed',
          passed: true,
          expected: 0,
          actual: 0,
          message: 'No file artifacts are expected for read-only review.',
        },
      ],
      taskNoProgress: { hard: 0, suppressed: 0 },
      finalStatus: 'passed',
      mockResponseSequence: [
        {
          text: '',
          toolUse: [{ toolName: 'read', input: { path: '__WORKSPACE__/package.json' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 8 },
        },
        {
          text: '',
          toolUse: [{ toolName: 'read', input: { path: '__WORKSPACE__/src/benchmark/types.ts' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 12, output_tokens: 8 },
        },
        {
          text: '',
          toolUse: [{ toolName: 'read', input: { path: '__WORKSPACE__/src/benchmark/harness.ts' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 14, output_tokens: 8 },
        },
        {
          text: 'Here is my review: The benchmark harness looks well-structured. The dry-run fixtures cover six cases across deck, code, read-only, research, and data-report families. The schema validation is thorough. No modifications needed.',
          toolUse: [],
          stopReason: 'end_turn',
          usage: { input_tokens: 16, output_tokens: 40 },
        },
      ],
    },
  },
  {
    caseId: 'research-note',
    title: 'Research note with sources',
    taskFamily: 'research',
    deliverableMode: 'text_deliverable',
    prompt: 'Write a research note with source-backed claims. Write the artifact to this exact path: __WORKSPACE__/research-note/research-note.md.',
    expectedOutputs: ['research-note.md'],
    evalPolicy: {
      expectedArtifactPaths: ['__WORKSPACE__/research-note/research-note.md'],
      auditFields: [...BASE_EVAL_AUDIT_FIELDS, 'timeout_sentinel'],
      timeoutMs: 15 * 60 * 1000,
      keepalive: 'progress_sentinel',
      comparisonHarness: 'scripted_mock',
    },
    dryRun: {
      selectedSkill: null,
      timeToFirstWriteMs: 910,
      readCallsBeforeFirstWrite: 6,
      artifacts: [
        { path: 'research-note/research-note.md', kind: 'markdown_report', exists: true, bytes: 8400, source: 'dry_run' },
      ],
      verification: [
        {
          id: 'research-note.sources',
          kind: 'markdown_report.citations',
          status: 'passed',
          passed: true,
          expected: true,
          actual: true,
          message: 'Dry-run note includes citation-bearing verification.',
        },
      ],
      taskNoProgress: { hard: 0, suppressed: 0 },
      finalStatus: 'passed',
      mockResponseSequence: [
        {
          text: 'I will track the research-note deliverable before writing it.',
          toolUse: [
            {
              toolName: 'TaskCreate',
              input: {
                subject: 'Write source-backed research note',
                description: 'Produce research-note.md and verify that it records source-backed claims.',
                deliverables: [
                  { path: '__WORKSPACE__/research-note/research-note.md', kind: 'file', origin: 'explicit' },
                ],
                steps: [
                  {
                    id: 'step-1',
                    title: 'Write and verify research note',
                    description: 'Draft the note with a sources section and citation markers.',
                    expectedArtifacts: [
                      { path: '__WORKSPACE__/research-note/research-note.md', kind: 'file', origin: 'explicit' },
                    ],
                    verification: [
                      {
                        id: 'research-note.sources',
                        kind: 'file_contains',
                        path: '__WORKSPACE__/research-note/research-note.md',
                        pattern: '\\[source:',
                      },
                    ],
                  },
                ],
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 8 },
        },
        {
          text: 'Starting the note-writing step.',
          toolUse: [{ toolName: 'TaskUpdate', input: { taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 11, output_tokens: 6 },
        },
        {
          text: 'Checking the local source stub before drafting.',
          toolUse: [{ toolName: 'read', input: { path: '__WORKSPACE__/sources/manufacturing-data-readiness.md' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 12, output_tokens: 6 },
        },
        {
          text: 'Writing the research note artifact.',
          toolUse: [
            {
              toolName: 'write',
              input: {
                path: '__WORKSPACE__/research-note/research-note.md',
                content: RESEARCH_NOTE_MARKDOWN,
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 13, output_tokens: 8 },
        },
        {
          text: 'Verifying the research note has citation-bearing source markers.',
          toolUse: [{ toolName: 'TaskVerify', input: { taskId: 'task-1', stepId: 'step-1' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 14, output_tokens: 8 },
        },
        {
          text: 'Marking the research note step complete.',
          toolUse: [
            {
              toolName: 'TaskUpdate',
              input: {
                taskId: 'task-1',
                stepId: 'step-1',
                stepStatus: 'completed',
                touchedPaths: ['__WORKSPACE__/research-note/research-note.md'],
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 15, output_tokens: 8 },
        },
        {
          text: 'Done. research-note.md is written with source-backed claims.',
          toolUse: [],
          stopReason: 'end_turn',
          usage: { input_tokens: 16, output_tokens: 12 },
        },
      ],
    },
  },
  {
    caseId: 'data-report',
    title: 'Data analysis report',
    taskFamily: 'data_report',
    deliverableMode: 'file_artifact_delivery',
    prompt: 'Analyze a dataset and produce a report with tables and charts. Write the artifacts to these exact paths: __WORKSPACE__/data-report/report.md and __WORKSPACE__/data-report/summary.csv.',
    expectedOutputs: ['report.md', 'summary.csv'],
    evalPolicy: {
      expectedArtifactPaths: ['__WORKSPACE__/data-report/report.md', '__WORKSPACE__/data-report/summary.csv'],
      auditFields: [...BASE_EVAL_AUDIT_FIELDS, 'timeout_sentinel'],
      timeoutMs: 15 * 60 * 1000,
      keepalive: 'progress_sentinel',
      comparisonHarness: 'scripted_mock',
    },
    dryRun: {
      selectedSkill: null,
      timeToFirstWriteMs: 830,
      readCallsBeforeFirstWrite: 4,
      artifacts: [
        { path: 'data-report/report.md', kind: 'data_report', exists: true, bytes: 6200, source: 'dry_run' },
        { path: 'data-report/summary.csv', kind: 'data_table', exists: true, bytes: 1200, source: 'dry_run' },
      ],
      verification: [
        {
          id: 'data-report.table',
          kind: 'data_report.table_exists',
          status: 'passed',
          passed: true,
          expected: true,
          actual: true,
          message: 'Dry-run report includes a table artifact.',
        },
      ],
      taskNoProgress: { hard: 0, suppressed: 0 },
      finalStatus: 'passed',
      mockResponseSequence: [
        {
          text: 'I will create a data-report task plan before writing the report and table.',
          toolUse: [
            {
              toolName: 'TaskCreate',
              input: {
                subject: 'Analyze sample dataset and publish report',
                description: 'Write report.md and summary.csv, then verify the table artifact exists.',
                deliverables: [
                  { path: '__WORKSPACE__/data-report/report.md', kind: 'file', origin: 'explicit' },
                  { path: '__WORKSPACE__/data-report/summary.csv', kind: 'file', origin: 'explicit' },
                ],
                steps: [
                  {
                    id: 'step-1',
                    title: 'Write and verify data report artifacts',
                    description: 'Produce the markdown report and CSV summary table.',
                    expectedArtifacts: [
                      { path: '__WORKSPACE__/data-report/report.md', kind: 'file', origin: 'explicit' },
                      { path: '__WORKSPACE__/data-report/summary.csv', kind: 'file', origin: 'explicit' },
                    ],
                    verification: [
                      {
                        id: 'data-report.table',
                        kind: 'artifact_count',
                        root: '__WORKSPACE__/data-report',
                        glob: '*.csv',
                        min: 1,
                      },
                    ],
                  },
                ],
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 8 },
        },
        {
          text: 'Starting the data report step.',
          toolUse: [{ toolName: 'TaskUpdate', input: { taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 11, output_tokens: 6 },
        },
        {
          text: 'Checking the input dataset path before writing outputs.',
          toolUse: [{ toolName: 'read', input: { path: '__WORKSPACE__/input/sample.csv' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 12, output_tokens: 6 },
        },
        {
          text: 'Writing the markdown analysis report.',
          toolUse: [
            {
              toolName: 'write',
              input: {
                path: '__WORKSPACE__/data-report/report.md',
                content: DATA_REPORT_MARKDOWN,
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 13, output_tokens: 8 },
        },
        {
          text: 'Writing the summary CSV table artifact.',
          toolUse: [
            {
              toolName: 'write',
              input: {
                path: '__WORKSPACE__/data-report/summary.csv',
                content: DATA_REPORT_CSV,
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 14, output_tokens: 8 },
        },
        {
          text: 'Verifying that the CSV table artifact exists.',
          toolUse: [{ toolName: 'TaskVerify', input: { taskId: 'task-1', stepId: 'step-1' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 15, output_tokens: 8 },
        },
        {
          text: 'Marking the data report step complete.',
          toolUse: [
            {
              toolName: 'TaskUpdate',
              input: {
                taskId: 'task-1',
                stepId: 'step-1',
                stepStatus: 'completed',
                touchedPaths: [
                  '__WORKSPACE__/data-report/report.md',
                  '__WORKSPACE__/data-report/summary.csv',
                ],
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 16, output_tokens: 8 },
        },
        {
          text: 'Done. report.md and summary.csv are written and verified.',
          toolUse: [],
          stopReason: 'end_turn',
          usage: { input_tokens: 17, output_tokens: 12 },
        },
      ],
    },
  },
  {
    caseId: 'deck-46p-realistic',
    title: 'Deck 46p realistic trajectory (Patch 1 regression)',
    taskFamily: 'deck',
    deliverableMode: 'file_artifact_delivery',
    prompt: 'Create a long-form industrial AI HTML deck with build notes. For release smoke, produce at least 30 content-bearing sections; exact full-length quality evaluation is handled by the separate heavy gate. Write the artifacts to these exact paths: __WORKSPACE__/deck.html and __WORKSPACE__/build-notes.md.',
    expectedOutputs: ['deck.html', 'build-notes.md'],
    evalPolicy: {
      expectedArtifactPaths: ['__WORKSPACE__/deck.html', '__WORKSPACE__/build-notes.md'],
      auditFields: [...DECK_EVAL_AUDIT_FIELDS],
      timeoutMs: 15 * 60 * 1000,
      keepalive: 'progress_sentinel',
      comparisonHarness: 'scripted_mock',
      sectionPolicy: { smokeMinSections: 30, heavyExactSections: 46, exactSectionsGate: 'heavy_eval' },
    },
    dryRun: {
      selectedSkill: null,
      timeToFirstWriteMs: 0,
      readCallsBeforeFirstWrite: 1,
      artifacts: [
        { path: 'deck.html', kind: 'html_deck', exists: true, bytes: DECK_46P_REALISTIC_HTML.length, source: 'write' },
        { path: 'build-notes.md', kind: 'build_notes', exists: true, bytes: DECK_46P_REALISTIC_BUILD_NOTES.length, source: 'write' },
      ],
      verification: [
        {
          id: 'deck-46p-realistic.no_hard_stop',
          kind: 'gate.no_task_no_progress_hard',
          status: 'passed',
          passed: true,
          expected: 0,
          actual: 0,
          message: 'No task_no_progress_hard event fired.',
        },
      ],
      taskNoProgress: { hard: 0, suppressed: 0 },
      finalStatus: 'passed',
      mockResponseSequence: [
        // Turn 1: model reads a template (simulates code-shaped file read — the A1/A3 failure trigger)
        {
          text: '正在分析任务，先 Read 模板',
          toolUse: [
            {
              toolName: 'read',
              input: { path: '__WORKSPACE__/some-template.html' },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 8 },
        },
        // Turn 2: model writes deck via write tool
        {
          text: 'Writing deck HTML.',
          toolUse: [
            {
              toolName: 'write',
              input: {
                path: '__WORKSPACE__/deck.html',
                content: DECK_46P_REALISTIC_HTML,
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 12, output_tokens: 8 },
        },
        // Turn 3: write build notes
        {
          text: '',
          toolUse: [
            {
              toolName: 'write',
              input: {
                path: '__WORKSPACE__/build-notes.md',
                content: DECK_46P_REALISTIC_BUILD_NOTES,
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 13, output_tokens: 6 },
        },
        // Turn 4: completion — model declares done
        {
          text: '完成。已生成 deck.html 和 build-notes.md。',
          toolUse: [],
          stopReason: 'end_turn',
          usage: { input_tokens: 14, output_tokens: 12 },
        },
      ],
    },
  },
  // ---------------------------------------------------------------------------
  // smoke-provenance-article — Article-class hallucination caught by the
  // write-target-provenance gate. User says "do not write"; model attempts a
  // write to an invented path; gate blocks; model recovers with end_turn.
  // Pins the regression fixed by docs/superpowers/specs/2026-05-26-write-
  // target-provenance-design.md.
  // ---------------------------------------------------------------------------
  {
    caseId: 'smoke-provenance-article',
    title: 'Provenance gate blocks invented write path',
    taskFamily: 'read_only_review',
    deliverableMode: 'read_only_review',
    prompt: '请只用文字回答以下问题，不要创建或修改任何文件：当前仓库根目录下有哪些常见入口？',
    expectedOutputs: ['chat report'],
    evalPolicy: {
      expectedArtifactPaths: [],
      auditFields: [...BASE_EVAL_AUDIT_FIELDS, 'timeout_sentinel'],
      timeoutMs: 15 * 60 * 1000,
      keepalive: 'progress_sentinel',
      comparisonHarness: 'scripted_mock',
      envOverrides: { OWLCODA_GATE_PROVENANCE: '1' },
    },
    dryRun: {
      selectedSkill: null,
      timeToFirstWriteMs: 0,
      readCallsBeforeFirstWrite: 0,
      artifacts: [],
      verification: [
        {
          id: 'smoke-provenance-article.no_artifacts',
          kind: 'read_only_review.no_artifacts',
          status: 'passed',
          passed: true,
          expected: 0,
          actual: 0,
          message: 'Write to invented path is blocked; no artifacts land.',
        },
      ],
      taskNoProgress: { hard: 0, suppressed: 0 },
      finalStatus: 'passed',
      mockResponseSequence: [
        // Turn 1: model hallucinates a write target despite the user's instruction.
        {
          text: '',
          toolUse: [
            {
              toolName: 'write',
              input: {
                path: '__WORKSPACE__/src/invented.ts',
                content: 'export const placeholder = true\n',
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 12, output_tokens: 18 },
        },
        // Turn 2: gate returned isError=true; model accepts and closes.
        {
          text: '抱歉，按要求不写入文件。仓库常见入口包括 src/native、src/benchmark 与 scripts/ 三处。',
          toolUse: [],
          stopReason: 'end_turn',
          usage: { input_tokens: 20, output_tokens: 30 },
        },
      ],
    },
  },
  // ---------------------------------------------------------------------------
  // smoke-provenance-known-file — User declares an exact target path; gate
  // admits via user_declared_target evidence; write executes and artifact
  // lands. Companion positive case to smoke-provenance-article.
  // ---------------------------------------------------------------------------
  {
    caseId: 'smoke-provenance-known-file',
    title: 'Provenance gate admits user-declared write target',
    taskFamily: 'code',
    deliverableMode: 'code_change',
    prompt: '请把一行内容 `export const SMOKE = true` 写到 __WORKSPACE__/notes.md。',
    expectedOutputs: ['notes.md'],
    evalPolicy: {
      expectedArtifactPaths: ['__WORKSPACE__/notes.md'],
      auditFields: [...BASE_EVAL_AUDIT_FIELDS, 'timeout_sentinel'],
      timeoutMs: 15 * 60 * 1000,
      keepalive: 'progress_sentinel',
      comparisonHarness: 'scripted_mock',
      envOverrides: { OWLCODA_GATE_PROVENANCE: '1' },
    },
    dryRun: {
      selectedSkill: null,
      timeToFirstWriteMs: 0,
      readCallsBeforeFirstWrite: 0,
      artifacts: [
        { path: 'notes.md', kind: 'markdown_report', exists: true, source: 'write' },
      ],
      verification: [
        {
          id: 'smoke-provenance-known-file.declared_admit',
          kind: 'provenance_gate.user_declared_target_admit',
          status: 'passed',
          passed: true,
          expected: true,
          actual: true,
          message: 'User-declared path admits via user_declared_target; write lands.',
        },
      ],
      taskNoProgress: { hard: 0, suppressed: 0 },
      finalStatus: 'passed',
      mockResponseSequence: [
        // Turn 1: model writes to the user-declared path.
        {
          text: '',
          toolUse: [
            {
              toolName: 'write',
              input: {
                path: '__WORKSPACE__/notes.md',
                content: 'export const SMOKE = true\n',
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 14, output_tokens: 16 },
        },
        // Turn 2: model closes.
        {
          text: '完成。notes.md 已写入。',
          toolUse: [],
          stopReason: 'end_turn',
          usage: { input_tokens: 16, output_tokens: 10 },
        },
      ],
    },
  },
]
