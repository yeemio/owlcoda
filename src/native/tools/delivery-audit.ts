/**
 * OwlCoda Native DeliveryAudit Tool
 *
 * Background — issue #6, second piece (private):
 *   Final summaries claimed completion ("已完成 / shipped / tests pass / 8
 *   场景全覆盖") but the working tree was inconsistent: untracked
 *   deliverables, unrelated residue mixed in, build artifacts not
 *   filtered, claimed files missing, version not bumped, etc.
 *
 *   This tool gives the model a structured "is what I just said
 *   actually true on disk?" reconciliation. Conversation.ts also
 *   auto-detects completion verbs and injects a `[Runtime delivery
 *   check]` notice nudging the model to call this tool before
 *   declaring done. The two together implement the
 *   "claim ↔ evidence consistency check" gate.
 *
 * What this tool DOES:
 *   - Reports git status broken into:
 *       touched-this-turn  (from taskState.contract.touchedPaths)
 *       new-untracked-deliverables (untracked + this turn touched)
 *       unrelated-residue  (tracked-modified or untracked but not touched)
 *       build-artifacts    (matched against ignored / dist-style patterns)
 *   - Cross-checks each `claims[i]` against simple heuristics:
 *       file-exists claims → fs.existsSync of named path
 *       version-shipped claims → package.json `version` field
 *       tests-pass claims → unverifiable from disk; surface as such
 *   - Surfaces a recommended next-step list (stage X, commit Y,
 *     investigate residue Z).
 *
 * What this tool does NOT do:
 *   - Run tests. The model can run them via TaskCreate / bash if
 *     they want fresh evidence. We don't shell out from the audit
 *     itself because (a) it'd be slow, (b) test runs aren't pure
 *     and (c) the audit is supposed to be readable telemetry, not
 *     a test runner.
 *   - Read test source for assertion-strength checks. That's
 *     0.13.45's lite-lint job.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { NativeToolDef, ToolResult } from './types.js'
import { lintTestStrength, type VacuousAssertionFinding } from './test-strength-lint.js'

export interface DeliveryAuditInput {
  /**
   * Optional list of completion claims to verify. Each claim is a
   * free-text sentence (e.g., "added src/native/tools/foo.ts",
   * "shipped 0.13.44", "tests pass"). Heuristics try to extract
   * file paths and version strings; unstructured claims are reported
   * as `unverifiable` rather than passed/failed.
   */
  claims?: string[]
  /** Optional: explicit list of files that should now exist. */
  expectedFiles?: string[]
  /**
   * Optional: explicit test files to lint for vacuous assertions
   * (wide-coverage names backed only by `toBeDefined()` /
   * `toBeTruthy()` / `not.toBeNull()` / `not.toBeUndefined()`).
   * If omitted, the audit auto-lints any touched-this-turn path
   * matching `*.test.ts|tsx|js|jsx|mjs|cjs`. Pass an empty array
   * to skip the lint entirely.
   */
  lintTestFiles?: string[]
}

interface FileBucket {
  touchedThisTurn: string[]
  newUntrackedDeliverables: string[]
  trackedModifiedDeliverables: string[]
  unrelatedResidue: string[]
  buildArtifacts: string[]
}

interface ClaimVerdict {
  claim: string
  verdict: 'confirmed' | 'unsupported' | 'unverifiable'
  evidence: string
}

/**
 * Patterns whose matches are filtered out of `unrelatedResidue` /
 * `newUntrackedDeliverables` and into `buildArtifacts` instead.
 *
 * Lockfiles (`package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`) are
 * intentionally NOT here. Hostile-QA grading 0.13.46 caught the
 * package.json↔package-lock.json version drift exactly because the
 * filter was masking it: the audit reported "no untouched changes"
 * while the lockfile had been stuck at 0.13.31 for 15 versions. A
 * tracked lockfile is a release-truth artefact, not a transient
 * build output, and silently filtering it from the audit is the
 * exact "delivery looks clean but isn't" failure this tool exists
 * to prevent.
 */
const BUILD_ARTIFACT_HINTS = [
  /^dist[\/\\]/,
  /^build[\/\\]/,
  /^node_modules[\/\\]/,
  /^coverage[\/\\]/,
  /^\.next[\/\\]/,
  /^\.turbo[\/\\]/,
  /\.pyc$/,
  /__pycache__[\/\\]/,
  /\.tsbuildinfo$/,
  /\.log$/,
]

export function createDeliveryAuditTool(): NativeToolDef<DeliveryAuditInput> {
  return {
    name: 'DeliveryAudit',
    description:
      'Reconcile a completion claim against working-tree evidence. Returns ' +
      'a structured ownership report (files touched this turn vs unrelated ' +
      'residue vs build artifacts) and per-claim verdicts (confirmed / ' +
      'unsupported / unverifiable). Call this BEFORE stating "done", ' +
      '"shipped", "tests pass", or any completion verb when the working ' +
      'tree is dirty — conversation.ts auto-detects those verbs and ' +
      'injects a runtime nudge to call this tool. Heuristics: file-exists ' +
      'claims check fs; version-shipped claims read package.json; ' +
      'tests-pass claims are unverifiable from disk and surface as such.',
    maturity: 'beta' as const,

    async execute(input: DeliveryAuditInput, context): Promise<ToolResult> {
      const cwd = process.cwd()
      const touchedFromTask = (context?.taskState?.contract?.touchedPaths ?? [])
        .map((p) => normalizeRelative(p, cwd))

      const gitStatus = readGitStatus(cwd)
      if (gitStatus === null) {
        return {
          output: 'DeliveryAudit: not inside a git repository — cannot enumerate working tree state. ' +
            'The audit is most useful inside a repo with a baseline; without one, only file-existence ' +
            'and version checks are meaningful.',
          isError: false,
          metadata: { mode: 'no-git', touchedFromTask },
        }
      }

      const buckets = bucketFiles(gitStatus, touchedFromTask)
      const claims = input.claims ?? []
      const expectedFiles = input.expectedFiles ?? []

      const claimVerdicts: ClaimVerdict[] = []
      for (const claim of claims) {
        claimVerdicts.push(verifyClaim(claim, cwd, gitStatus, touchedFromTask))
      }

      const expectedFileVerdicts = expectedFiles.map((f) => verifyExpectedFile(f, cwd, gitStatus))

      const testFilesToLint = resolveTestLintTargets(input, touchedFromTask, cwd)
      const vacuousFindings: VacuousAssertionFinding[] = []
      let testFilesLinted = 0
      for (const file of testFilesToLint) {
        try {
          const content = readFileSync(file, 'utf-8')
          const result = lintTestStrength(file, content)
          testFilesLinted += 1
          for (const finding of result.findings) vacuousFindings.push(finding)
        } catch {
          // Lint failures are not audit failures; just skip.
        }
      }

      const recommendations = buildRecommendations(buckets, claimVerdicts, expectedFileVerdicts, vacuousFindings)

      const lines: string[] = []
      lines.push('=== Delivery Audit ===')
      lines.push('')
      lines.push('Touched this turn (write/edit/notebook-edit):')
      if (buckets.touchedThisTurn.length === 0) {
        lines.push('  (none recorded — taskState.contract.touchedPaths is empty)')
      } else {
        for (const p of buckets.touchedThisTurn) lines.push(`  ${p}`)
      }
      lines.push('')
      lines.push('Working tree:')
      lines.push(`  Touched + tracked-modified : ${buckets.trackedModifiedDeliverables.length}`)
      lines.push(`  Touched + new untracked    : ${buckets.newUntrackedDeliverables.length}`)
      lines.push(`  Unrelated residue          : ${buckets.unrelatedResidue.length}`)
      lines.push(`  Likely build artifacts     : ${buckets.buildArtifacts.length}`)
      if (buckets.newUntrackedDeliverables.length > 0) {
        lines.push('')
        lines.push('  New untracked deliverables (need stage/commit before "shipped"):')
        for (const p of buckets.newUntrackedDeliverables) lines.push(`    ?? ${p}`)
      }
      if (buckets.unrelatedResidue.length > 0) {
        lines.push('')
        lines.push('  Unrelated residue (touched in prior sessions, not this turn):')
        for (const p of buckets.unrelatedResidue.slice(0, 20)) lines.push(`    ~  ${p}`)
        if (buckets.unrelatedResidue.length > 20) {
          lines.push(`    ... (+${buckets.unrelatedResidue.length - 20} more)`)
        }
      }

      if (claimVerdicts.length > 0) {
        lines.push('')
        lines.push('Claim verification:')
        for (const v of claimVerdicts) {
          const icon = v.verdict === 'confirmed' ? 'OK' : v.verdict === 'unsupported' ? 'XX' : '??'
          lines.push(`  [${icon}] ${v.claim}`)
          lines.push(`         ${v.verdict.toUpperCase()}: ${v.evidence}`)
        }
      }

      if (expectedFileVerdicts.length > 0) {
        lines.push('')
        lines.push('Expected files:')
        for (const v of expectedFileVerdicts) {
          const icon = v.verdict === 'confirmed' ? 'OK' : 'XX'
          lines.push(`  [${icon}] ${v.claim}`)
          lines.push(`         ${v.evidence}`)
        }
      }

      if (vacuousFindings.length > 0) {
        lines.push('')
        lines.push(`Vacuous test assertions (${vacuousFindings.length} finding(s) across ${testFilesLinted} file(s)):`)
        for (const f of vacuousFindings.slice(0, 12)) {
          lines.push(`  ${f.file}:${f.line}  "${f.testName}"`)
          lines.push(`    ${f.reason}`)
        }
        if (vacuousFindings.length > 12) {
          lines.push(`  ... (+${vacuousFindings.length - 12} more)`)
        }
      } else if (testFilesLinted > 0) {
        lines.push('')
        lines.push(`Test-strength lint: ${testFilesLinted} file(s) scanned, no vacuous wide-coverage assertions found.`)
      }

      if (recommendations.length > 0) {
        lines.push('')
        lines.push('Recommended next steps:')
        for (const r of recommendations) lines.push(`  - ${r}`)
      }

      const unsupportedCount = claimVerdicts.filter((c) => c.verdict === 'unsupported').length
        + expectedFileVerdicts.filter((c) => c.verdict === 'unsupported').length

      return {
        output: lines.join('\n'),
        isError: false,
        metadata: {
          mode: 'audited',
          buckets,
          claimVerdicts,
          expectedFileVerdicts,
          vacuousAssertions: vacuousFindings,
          testFilesLinted,
          unsupportedCount,
          recommendations,
        },
      }
    },
  }
}

// ─── helpers ───────────────────────────────────────────────────

function readGitStatus(cwd: string): GitStatusEntry[] | null {
  try {
    const result = spawnSync('git', ['status', '--porcelain=v1'], {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
    })
    if (result.status !== 0) return null
    const out = result.stdout.split('\n').filter((l) => l.length > 0)
    return out.map(parsePorcelainLine).filter((e): e is GitStatusEntry => e !== null)
  } catch {
    return null
  }
}

interface GitStatusEntry {
  index: string
  worktree: string
  path: string
}

function parsePorcelainLine(line: string): GitStatusEntry | null {
  if (line.length < 4) return null
  const index = line[0] ?? ' '
  const worktree = line[1] ?? ' '
  const path = line.slice(3)
  return { index, worktree, path }
}

function bucketFiles(entries: GitStatusEntry[], touchedFromTask: string[]): FileBucket {
  const touchedSet = new Set(touchedFromTask)
  const touchedThisTurn: string[] = [...touchedFromTask]
  const newUntrackedDeliverables: string[] = []
  const trackedModifiedDeliverables: string[] = []
  const unrelatedResidue: string[] = []
  const buildArtifacts: string[] = []

  for (const entry of entries) {
    const isUntracked = entry.index === '?' && entry.worktree === '?'
    const isBuildArtifact = BUILD_ARTIFACT_HINTS.some((re) => re.test(entry.path))
    const wasTouched = touchedSet.has(entry.path) || touchedSet.has(`./${entry.path}`)
    if (isBuildArtifact) {
      buildArtifacts.push(entry.path)
      continue
    }
    if (isUntracked) {
      if (wasTouched) newUntrackedDeliverables.push(entry.path)
      else unrelatedResidue.push(entry.path)
      continue
    }
    if (wasTouched) {
      trackedModifiedDeliverables.push(entry.path)
    } else {
      unrelatedResidue.push(entry.path)
    }
  }
  return {
    touchedThisTurn,
    newUntrackedDeliverables,
    trackedModifiedDeliverables,
    unrelatedResidue,
    buildArtifacts,
  }
}

function verifyClaim(
  claim: string,
  cwd: string,
  gitStatus: GitStatusEntry[],
  touchedFromTask: string[],
): ClaimVerdict {
  const lower = claim.toLowerCase()

  const versionMatch = /(?:shipped|released|bumped|发布|升到)\s+(?:v?)(\d+\.\d+\.\d+)/i.exec(claim)
  if (versionMatch) {
    const claimedVersion = versionMatch[1]!
    const pkgVersion = readPackageVersion(cwd)
    if (pkgVersion === null) {
      return { claim, verdict: 'unverifiable', evidence: 'no package.json found' }
    }
    // Cross-check the lockfile too. 0.13.46 hostile-QA caught the
    // exact "package.json bumped, package-lock.json forgot to bump
    // along with it" footgun — `npm publish` from this state still
    // works but a clean clone reinstalls with a stale `installedVersion`,
    // and any tooling that reads the lockfile (`npm ci`, supply-chain
    // audits, deterministic build pipelines) sees the older version.
    // Lockfile drift IS unsupported even when package.json agrees.
    const lockVersions = readLockfileVersions(cwd)
    if (pkgVersion !== claimedVersion) {
      return {
        claim,
        verdict: 'unsupported',
        evidence: `package.json version = ${pkgVersion}, claim says ${claimedVersion}`,
      }
    }
    if (lockVersions !== null) {
      const lockMismatch = lockVersions.filter((v) => v !== claimedVersion)
      if (lockMismatch.length > 0) {
        return {
          claim,
          verdict: 'unsupported',
          evidence:
            `package.json version = ${pkgVersion} matches, but ` +
            `package-lock.json carries ${lockMismatch.join(', ')} — ` +
            `run \`npm install --package-lock-only\` before claiming shipped.`,
        }
      }
    }
    return {
      claim,
      verdict: 'confirmed',
      evidence: lockVersions === null
        ? `package.json version = ${pkgVersion} (no lockfile)`
        : `package.json + package-lock.json both at ${pkgVersion}`,
    }
  }

  const fileLikePaths = extractPathLikeTokens(claim)
  if (fileLikePaths.length > 0) {
    const verdicts = fileLikePaths.map((p) => verifyFileMention(p, cwd, gitStatus, touchedFromTask))
    const allConfirmed = verdicts.every((v) => v.exists)
    if (allConfirmed) {
      const summary = verdicts
        .map((v) => `${v.path}: ${v.context}`)
        .join('; ')
      return { claim, verdict: 'confirmed', evidence: summary }
    }
    const missing = verdicts.filter((v) => !v.exists)
    return {
      claim,
      verdict: 'unsupported',
      evidence: `missing: ${missing.map((m) => m.path).join(', ')}`,
    }
  }

  if (
    /\b(test|tests|测试|specs?)\b/.test(lower) &&
    /(pass|passed|绿|通过|green)/.test(lower)
  ) {
    return {
      claim,
      verdict: 'unverifiable',
      evidence: 'test-pass claims need a fresh test run; DeliveryAudit does not execute tests',
    }
  }

  return {
    claim,
    verdict: 'unverifiable',
    evidence: 'no extractable file path or version; rephrase with concrete artefacts to verify',
  }
}

interface FileMentionVerdict {
  path: string
  exists: boolean
  context: string
}

function verifyFileMention(
  path: string,
  cwd: string,
  gitStatus: GitStatusEntry[],
  touchedFromTask: string[],
): FileMentionVerdict {
  const abs = isAbsolute(path) ? path : resolve(cwd, path)
  const exists = existsSync(abs)
  if (!exists) {
    return { path, exists: false, context: 'file does not exist on disk' }
  }
  const rel = relative(cwd, abs)
  const inGitStatus = gitStatus.find((e) => e.path === rel || e.path === path)
  const wasTouched = touchedFromTask.some((t) => t === rel || t === path || t.endsWith(rel))
  if (inGitStatus) {
    const isUntracked = inGitStatus.index === '?' && inGitStatus.worktree === '?'
    if (isUntracked && !wasTouched) {
      return { path, exists: true, context: 'exists but untracked AND not touched this turn (residue)' }
    }
    if (isUntracked) {
      return { path, exists: true, context: 'exists, NEW untracked (this turn)' }
    }
    return { path, exists: true, context: `exists, modified (${inGitStatus.index}${inGitStatus.worktree})` }
  }
  return { path, exists: true, context: 'exists, tracked + clean (was this really touched?)' }
}

function verifyExpectedFile(path: string, cwd: string, _gitStatus: GitStatusEntry[]): ClaimVerdict {
  const abs = isAbsolute(path) ? path : resolve(cwd, path)
  if (!existsSync(abs)) {
    return { claim: path, verdict: 'unsupported', evidence: 'file does not exist on disk' }
  }
  try {
    const stat = statSync(abs)
    const size = stat.size
    return { claim: path, verdict: 'confirmed', evidence: `exists (${size} bytes)` }
  } catch {
    return { claim: path, verdict: 'unsupported', evidence: 'stat failed' }
  }
}

/**
 * Decide which test files the lint should scan. Explicit input wins
 * (including an empty array — that means "skip the lint"). When
 * omitted, auto-target test-suffixed touched paths so a turn that
 * just authored a test file gets self-checked without ceremony.
 */
function resolveTestLintTargets(
  input: DeliveryAuditInput,
  touchedFromTask: string[],
  cwd: string,
): string[] {
  if (input.lintTestFiles !== undefined) {
    return input.lintTestFiles.map((p) => (isAbsolute(p) ? p : resolve(cwd, p)))
  }
  const testRe = /\.test\.[mc]?[jt]sx?$|\.spec\.[mc]?[jt]sx?$/
  const out: string[] = []
  for (const rel of touchedFromTask) {
    if (testRe.test(rel)) {
      out.push(isAbsolute(rel) ? rel : resolve(cwd, rel))
    }
  }
  return out
}

function buildRecommendations(
  buckets: FileBucket,
  claimVerdicts: ClaimVerdict[],
  expectedFileVerdicts: ClaimVerdict[],
  vacuousFindings: VacuousAssertionFinding[],
): string[] {
  const recs: string[] = []
  if (buckets.newUntrackedDeliverables.length > 0) {
    recs.push(
      `Stage and commit ${buckets.newUntrackedDeliverables.length} new untracked deliverable(s) ` +
      `before stating "shipped" or "merged".`,
    )
  }
  if (buckets.trackedModifiedDeliverables.length > 0) {
    recs.push(
      `${buckets.trackedModifiedDeliverables.length} tracked file(s) modified this turn — ` +
      `commit if not already done.`,
    )
  }
  if (buckets.unrelatedResidue.length > 0) {
    recs.push(
      `${buckets.unrelatedResidue.length} unrelated residue file(s) in dirty tree — clarify ownership ` +
      `(carry-over from prior sessions vs this-turn side effects).`,
    )
  }
  const unsupported = [...claimVerdicts, ...expectedFileVerdicts].filter((c) => c.verdict === 'unsupported')
  if (unsupported.length > 0) {
    recs.push(
      `Retract or rephrase ${unsupported.length} unsupported claim(s) — the working tree does not ` +
      `back them up.`,
    )
  }
  const unverifiable = claimVerdicts.filter((c) => c.verdict === 'unverifiable')
  if (unverifiable.length > 0) {
    recs.push(
      `${unverifiable.length} claim(s) unverifiable from disk — for test-pass / coverage / deployment ` +
      `claims, run the corresponding command and surface its output explicitly in your summary.`,
    )
  }
  if (vacuousFindings.length > 0) {
    recs.push(
      `${vacuousFindings.length} test(s) advertise wide coverage but only assert non-null shape — ` +
      `tighten the matchers (toBe / toEqual / toMatch / toHaveLength / toThrow / …) before claiming ` +
      `coverage in the summary.`,
    )
  }
  return recs
}

function readPackageVersion(cwd: string): string | null {
  try {
    const raw = readFileSync(resolve(cwd, 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw) as { version?: string }
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/**
 * Read every version field that should agree with package.json's:
 *   `version` (top-level lockfile)
 *   `packages[""].version` (npm v7+ lockfile shape, the package's own entry)
 * Returns deduped array, or null when no lockfile exists.
 */
function readLockfileVersions(cwd: string): string[] | null {
  try {
    const raw = readFileSync(resolve(cwd, 'package-lock.json'), 'utf-8')
    const lock = JSON.parse(raw) as { version?: string; packages?: Record<string, { version?: string }> }
    const versions = new Set<string>()
    if (typeof lock.version === 'string') versions.add(lock.version)
    const ownEntry = lock.packages?.['']
    if (ownEntry && typeof ownEntry.version === 'string') versions.add(ownEntry.version)
    return [...versions]
  } catch {
    return null
  }
}

/**
 * Pull file-path-looking tokens out of a free-text claim. Heuristic.
 * Matches `foo/bar.ts`, `src/native/tools/foo.tsx`, `tests/x.test.ts`,
 * `package.json`, etc. Avoids matching dotted versions ("0.13.43") by
 * requiring a slash or a known file extension.
 */
function extractPathLikeTokens(claim: string): string[] {
  const out: string[] = []
  const pattern = /(?:[\w@.-]+[/\\])+[\w@.-]+\.[\w]+|[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|py|rs|go|toml|yaml|yml|sh)\b/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(claim)) !== null) {
    out.push(match[0]!)
  }
  return [...new Set(out)]
}

function normalizeRelative(p: string, cwd: string): string {
  if (!isAbsolute(p)) return p.replace(/\\/g, '/')
  const rel = relative(cwd, p)
  return rel.split(sep).join('/')
}
