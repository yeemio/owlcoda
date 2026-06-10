import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  compileRulesForTarget,
  loadResolvedPermissions,
  matchRulePattern,
  parsePermissionRule,
} from '../../src/native/permission-rules.js'
import type {
  PermissionRule,
  ResolvedPermissions,
} from '../../src/native/protocol/permission-rule-types.js'

describe('parsePermissionRule — Tool(pattern) / *(pattern) parser (PERM-1)', () => {
  it('parses Edit(src/**) as an enforced allow rule', () => {
    const r = parsePermissionRule('Edit(src/**)', 'allow')
    expect(r.rule).toEqual({
      raw: 'Edit(src/**)',
      tool: 'Edit',
      pattern: 'src/**',
      effect: 'allow',
      enforced: true,
    })
    expect(r.warnings).toEqual([])
  })

  it('parses *(~/.ssh/**) sugar as a wildcard-tool rule', () => {
    const r = parsePermissionRule('*(~/.ssh/**)', 'deny')
    expect(r.rule).toEqual({
      raw: '*(~/.ssh/**)',
      tool: '*',
      pattern: '~/.ssh/**',
      effect: 'deny',
      enforced: true,
    })
    expect(r.warnings).toEqual([])
  })

  it('parses Bash(curl *) but marks enforced=false and emits bash_not_enforced warning', () => {
    const r = parsePermissionRule('Bash(curl *)', 'deny')
    expect(r.rule).toBeDefined()
    expect(r.rule?.tool).toBe('Bash')
    expect(r.rule?.pattern).toBe('curl *')
    expect(r.rule?.enforced).toBe(false)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0].reason).toBe('bash_not_enforced')
    expect(r.warnings[0].message).toContain('Bash')
    expect(r.warnings[0].message).toContain('not enforced')
    // Message should suggest the *(path) replacement.
    expect(r.warnings[0].message).toMatch(/\*\(.*\)/)
  })

  it('rejects bare strings (no Tool wrapper) with bare_string warning', () => {
    const r = parsePermissionRule('~/.ssh/**', 'deny')
    expect(r.rule).toBeUndefined()
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0].reason).toBe('bare_string')
    expect(r.warnings[0].raw).toBe('~/.ssh/**')
  })

  it('rejects unknown tool names with unknown_tool warning', () => {
    const r = parsePermissionRule('Frobnicate(x)', 'deny')
    expect(r.rule).toBeUndefined()
    expect(r.warnings[0].reason).toBe('unknown_tool')
    expect(r.warnings[0].message).toContain('Frobnicate')
  })

  it('rejects empty pattern with empty_pattern warning', () => {
    const r = parsePermissionRule('Edit()', 'deny')
    expect(r.rule).toBeUndefined()
    expect(r.warnings[0].reason).toBe('empty_pattern')
  })

  it('rejects whitespace-only pattern as empty_pattern', () => {
    const r = parsePermissionRule('Edit(   )', 'deny')
    expect(r.rule).toBeUndefined()
    expect(r.warnings[0].reason).toBe('empty_pattern')
  })

  it('rejects malformed input (no closing paren) with malformed warning', () => {
    const r = parsePermissionRule('Edit(src/**', 'deny')
    expect(r.rule).toBeUndefined()
    expect(r.warnings[0].reason).toBe('malformed')
  })

  it('rejects empty string as malformed', () => {
    const r = parsePermissionRule('', 'deny')
    expect(r.rule).toBeUndefined()
    expect(r.warnings).toHaveLength(1)
  })

  it('treats ask as deny + emits ask_treated_as_deny warning', () => {
    const r = parsePermissionRule('Edit(src/**)', 'ask')
    expect(r.rule).toBeDefined()
    // Effective effect collapses ask → deny.
    expect(r.rule?.effect).toBe('deny')
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0].reason).toBe('ask_treated_as_deny')
  })

  it('Bash rule under ask emits BOTH ask_treated_as_deny AND bash_not_enforced', () => {
    // Compound case: both warnings should surface.
    const r = parsePermissionRule('Bash(curl *)', 'ask')
    expect(r.rule?.effect).toBe('deny')
    expect(r.rule?.enforced).toBe(false)
    const reasons = r.warnings.map(w => w.reason).sort()
    expect(reasons).toEqual(['ask_treated_as_deny', 'bash_not_enforced'])
  })

  it('tool name comparison is case-insensitive but normalizes to canonical case', () => {
    expect(parsePermissionRule('edit(src/foo.ts)', 'allow').rule?.tool).toBe('Edit')
    expect(parsePermissionRule('WRITE(./out/**)', 'allow').rule?.tool).toBe('Write')
    expect(parsePermissionRule('notebookedit(*.ipynb)', 'allow').rule?.tool).toBe('NotebookEdit')
    expect(parsePermissionRule('taskcreate(./scripts/**)', 'allow').rule?.tool).toBe('TaskCreate')
  })

  it('trims whitespace around pattern inside parens', () => {
    const r = parsePermissionRule('Edit(  src/foo.ts  )', 'allow')
    expect(r.rule?.pattern).toBe('src/foo.ts')
  })

  it('accepts patterns containing spaces (Bash command form)', () => {
    const r = parsePermissionRule('Bash(npm run test *)', 'allow')
    expect(r.rule?.pattern).toBe('npm run test *')
  })

  it('preserves raw string verbatim in returned rule', () => {
    const raw = 'Edit(  src/foo.ts  )'
    const r = parsePermissionRule(raw, 'allow')
    expect(r.rule?.raw).toBe(raw)
  })

  it('handles all path tools in the whitelist', () => {
    const tools = ['Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'TaskCreate']
    for (const tool of tools) {
      const r = parsePermissionRule(`${tool}(./x)`, 'deny')
      expect(r.rule?.tool).toBe(tool)
      expect(r.rule?.enforced).toBe(true)
      // No bash warning for non-Bash tools.
      expect(r.warnings.filter(w => w.reason === 'bash_not_enforced')).toEqual([])
    }
  })

  it('accepts the * wildcard tool', () => {
    const r = parsePermissionRule('*(./.env*)', 'deny')
    expect(r.rule?.tool).toBe('*')
    expect(r.rule?.enforced).toBe(true)
  })
})

describe('matchRulePattern — path glob matching (PERM-2)', () => {
  const HOME = '/Users/test'
  const PROJECT = '/abs/project'

  describe('home expansion (~/)', () => {
    it('matches ~/.ssh/** against ~/.ssh/id_rsa', () => {
      expect(matchRulePattern('~/.ssh/**', '/Users/test/.ssh/id_rsa', PROJECT, HOME)).toBe(true)
    })

    it('matches ~/.ssh/** against ~/.ssh itself (trailing /** includes dir)', () => {
      // Permanent denies should cover the directory itself, not just descendants.
      expect(matchRulePattern('~/.ssh/**', '/Users/test/.ssh', PROJECT, HOME)).toBe(true)
    })

    it('matches ~/.ssh/** against a deep descendant', () => {
      expect(matchRulePattern('~/.ssh/**', '/Users/test/.ssh/sub/key', PROJECT, HOME)).toBe(true)
    })

    it('does NOT match ~/.ssh/** against ~/.ssh.bak (no false-prefix)', () => {
      expect(matchRulePattern('~/.ssh/**', '/Users/test/.ssh.bak', PROJECT, HOME)).toBe(false)
    })

    it('does NOT match ~/.ssh/** against a sibling dir', () => {
      expect(matchRulePattern('~/.ssh/**', '/Users/test/other/key', PROJECT, HOME)).toBe(false)
    })

    it('matches bare ~ against home dir', () => {
      expect(matchRulePattern('~', '/Users/test', PROJECT, HOME)).toBe(true)
    })
  })

  describe('absolute patterns', () => {
    // NOTE: avoid /etc here because macOS realpaths /etc → /private/etc and
    // the matcher canonicalizes the wildcard-free prefix. Use a path that
    // is unlikely to be symlinked on any platform.
    const ABS_ROOT = '/nonexistent-perm-test-root'

    it(`matches ${ABS_ROOT}/** against ${ABS_ROOT}/passwd`, () => {
      expect(matchRulePattern(`${ABS_ROOT}/**`, `${ABS_ROOT}/passwd`, PROJECT, HOME)).toBe(true)
    })

    it(`matches ${ABS_ROOT}/** against ${ABS_ROOT} itself`, () => {
      expect(matchRulePattern(`${ABS_ROOT}/**`, ABS_ROOT, PROJECT, HOME)).toBe(true)
    })

    it(`does NOT match ${ABS_ROOT}/** against ${ABS_ROOT}foo`, () => {
      expect(matchRulePattern(`${ABS_ROOT}/**`, `${ABS_ROOT}foo`, PROJECT, HOME)).toBe(false)
    })

    it('matches exact path against same canonical path', () => {
      expect(matchRulePattern(`${ABS_ROOT}/hosts`, `${ABS_ROOT}/hosts`, PROJECT, HOME)).toBe(true)
    })

    it('does NOT match exact path against same-prefix neighbor', () => {
      expect(matchRulePattern(`${ABS_ROOT}/hosts`, `${ABS_ROOT}/hosts.bak`, PROJECT, HOME)).toBe(false)
    })
  })

  describe('relative patterns (project-rooted)', () => {
    it('matches ./src/** against ./src/foo.ts under project', () => {
      expect(matchRulePattern('./src/**', '/abs/project/src/foo.ts', PROJECT, HOME)).toBe(true)
    })

    it('matches src/** (no ./) against ./src/foo.ts under project', () => {
      // Bare "src/**" resolves under project root.
      expect(matchRulePattern('src/**', '/abs/project/src/foo.ts', PROJECT, HOME)).toBe(true)
    })

    it('does NOT match src/** against /other/src/foo.ts (different project)', () => {
      expect(matchRulePattern('src/**', '/other/src/foo.ts', PROJECT, HOME)).toBe(false)
    })

    it('matches package-lock.json (exact, project-rooted) against project/package-lock.json', () => {
      expect(matchRulePattern('package-lock.json', '/abs/project/package-lock.json', PROJECT, HOME)).toBe(true)
    })

    it('does NOT match package-lock.json against project/sub/package-lock.json', () => {
      // Plain relative resolves at project root; no glob → only that exact file.
      expect(matchRulePattern('package-lock.json', '/abs/project/sub/package-lock.json', PROJECT, HOME)).toBe(false)
    })
  })

  describe('* single segment vs ** multi-segment', () => {
    it('* (single) matches within one segment but NOT across slashes', () => {
      expect(matchRulePattern('./.env*', '/abs/project/.env.local', PROJECT, HOME)).toBe(true)
      expect(matchRulePattern('./.env*', '/abs/project/.env', PROJECT, HOME)).toBe(true)
      expect(matchRulePattern('./.env*', '/abs/project/sub/.env', PROJECT, HOME)).toBe(false)
    })

    it('** in middle (a/**/b) matches zero or more intermediate segments', () => {
      expect(matchRulePattern('a/**/b', '/abs/project/a/b', PROJECT, HOME)).toBe(true)
      expect(matchRulePattern('a/**/b', '/abs/project/a/x/b', PROJECT, HOME)).toBe(true)
      expect(matchRulePattern('a/**/b', '/abs/project/a/x/y/b', PROJECT, HOME)).toBe(true)
      expect(matchRulePattern('a/**/b', '/abs/project/a/c', PROJECT, HOME)).toBe(false)
    })

    it('?  matches exactly one char within a segment', () => {
      expect(matchRulePattern('file?.ts', '/abs/project/file1.ts', PROJECT, HOME)).toBe(true)
      expect(matchRulePattern('file?.ts', '/abs/project/file12.ts', PROJECT, HOME)).toBe(false)
      // Critical: ? must not match slash.
      expect(matchRulePattern('a?b', '/abs/project/a/b', PROJECT, HOME)).toBe(false)
    })

    it('regex specials in pattern are escaped (not interpreted as regex)', () => {
      // `.` is regex-special but should be literal in a glob.
      expect(matchRulePattern('./.env', '/abs/project/.env', PROJECT, HOME)).toBe(true)
      expect(matchRulePattern('./.env', '/abs/project/xenv', PROJECT, HOME)).toBe(false)
    })
  })

  describe('symlink-aware canonical prefix (macOS /tmp → /private/tmp)', () => {
    it('canonical prefix in pattern matches realpath-style canonical path', () => {
      // Setup: pattern uses a real symlinked path. After normalization the
      // pattern's wildcard-free prefix is realpath'd so it matches canonical
      // input paths.
      const root = mkdtempSync(join(tmpdir(), 'owlcoda-perm-symlink-'))
      try {
        const realDir = realpathSync(join(root, '.'))
        mkdirSync(join(realDir, 'inner'))
        const canonicalChild = join(realDir, 'inner', 'foo.ts')
        // Pattern uses the original (possibly symlinked) form; canonical
        // child is the resolved form. Matcher should canonicalize the
        // prefix at match time.
        const pattern = join(root, 'inner/**')
        expect(matchRulePattern(pattern, canonicalChild, PROJECT, HOME)).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })

  describe('regression / edge cases', () => {
    it('empty pattern matches nothing', () => {
      expect(matchRulePattern('', '/abs/project/foo', PROJECT, HOME)).toBe(false)
    })

    it('empty path matches nothing', () => {
      expect(matchRulePattern('./foo', '', PROJECT, HOME)).toBe(false)
    })
  })
})

describe('matchRulePattern — real-file fixture (sanity)', () => {
  // Use a real tmp directory with realpath so canonicalization actually
  // produces the same shape as the gate's canonicalizeProvenancePath.
  it('round-trips a permanent-deny pattern against a real path', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'owlcoda-perm-fixture-')))
    try {
      const sshDir = join(root, '.ssh')
      mkdirSync(sshDir)
      const idRsa = join(sshDir, 'id_rsa')
      writeFileSync(idRsa, 'fake')
      const pattern = join(root, '.ssh', '**')
      expect(matchRulePattern(pattern, idRsa, root, root)).toBe(true)
      expect(matchRulePattern(pattern, sshDir, root, root)).toBe(true)
      expect(matchRulePattern(pattern, root, root, root)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('loadResolvedPermissions — 3-tier settings.json merge (PERM-3)', () => {
  function makeWorkspace(): { home: string; project: string; cleanup: () => void } {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'owlcoda-perm-home-')))
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'owlcoda-perm-proj-')))
    return {
      home,
      project,
      cleanup: () => {
        rmSync(home, { recursive: true, force: true })
        rmSync(project, { recursive: true, force: true })
      },
    }
  }

  function writeSettings(dir: string, content: unknown): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(content))
  }

  function writeLocalSettings(dir: string, content: unknown): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.local.json'), JSON.stringify(content))
  }

  it('returns empty ResolvedPermissions when no settings files exist', () => {
    const ws = makeWorkspace()
    try {
      const result = loadResolvedPermissions({
        homeDir: ws.home,
        projectRoot: ws.project,
        owlcodaHome: join(ws.home, '.owlcoda'),
      })
      expect(result.allow).toEqual([])
      expect(result.deny).toEqual([])
      expect(result.ask).toEqual([])
      expect(result.warnings).toEqual([])
    } finally {
      ws.cleanup()
    }
  })

  it('loads user-only deny rule and tags source=user', () => {
    const ws = makeWorkspace()
    try {
      const owlcodaHome = join(ws.home, '.owlcoda')
      writeSettings(owlcodaHome, {
        permissions: { deny: ['*(~/.ssh/**)'] },
      })
      const result = loadResolvedPermissions({
        homeDir: ws.home,
        projectRoot: ws.project,
        owlcodaHome,
      })
      expect(result.deny).toHaveLength(1)
      expect(result.deny[0].raw).toBe('*(~/.ssh/**)')
      expect(result.deny[0].source).toBe('user')
      expect(result.allow).toEqual([])
    } finally {
      ws.cleanup()
    }
  })

  it('loads project-only and tags source=project', () => {
    const ws = makeWorkspace()
    try {
      writeSettings(join(ws.project, '.owlcoda'), {
        permissions: { deny: ['Write(package-lock.json)'] },
      })
      const result = loadResolvedPermissions({
        homeDir: ws.home,
        projectRoot: ws.project,
        owlcodaHome: join(ws.home, '.owlcoda'),
      })
      expect(result.deny).toHaveLength(1)
      expect(result.deny[0].source).toBe('project')
    } finally {
      ws.cleanup()
    }
  })

  it('loads local-only and tags source=local', () => {
    const ws = makeWorkspace()
    try {
      writeLocalSettings(join(ws.project, '.owlcoda'), {
        permissions: { allow: ['Edit(scratch/**)'] },
      })
      const result = loadResolvedPermissions({
        homeDir: ws.home,
        projectRoot: ws.project,
        owlcodaHome: join(ws.home, '.owlcoda'),
      })
      expect(result.allow).toHaveLength(1)
      expect(result.allow[0].source).toBe('local')
    } finally {
      ws.cleanup()
    }
  })

  it('merges deny rules across all three layers (deny always wins)', () => {
    const ws = makeWorkspace()
    try {
      writeSettings(join(ws.home, '.owlcoda'), {
        permissions: { deny: ['*(~/.ssh/**)'] },
      })
      writeSettings(join(ws.project, '.owlcoda'), {
        permissions: { deny: ['Write(package-lock.json)'] },
      })
      writeLocalSettings(join(ws.project, '.owlcoda'), {
        permissions: { deny: ['Edit(scratch/secret.ts)'] },
      })
      const result = loadResolvedPermissions({
        homeDir: ws.home,
        projectRoot: ws.project,
        owlcodaHome: join(ws.home, '.owlcoda'),
      })
      expect(result.deny).toHaveLength(3)
      const sources = result.deny.map(r => r.source).sort()
      expect(sources).toEqual(['local', 'project', 'user'])
    } finally {
      ws.cleanup()
    }
  })

  it('Bash(...) rule loads with bash_not_enforced warning, rule still present', () => {
    const ws = makeWorkspace()
    try {
      writeSettings(join(ws.home, '.owlcoda'), {
        permissions: { deny: ['Bash(curl *)'] },
      })
      const result = loadResolvedPermissions({
        homeDir: ws.home,
        projectRoot: ws.project,
        owlcodaHome: join(ws.home, '.owlcoda'),
      })
      expect(result.deny).toHaveLength(1)
      expect(result.deny[0].enforced).toBe(false)
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0].reason).toBe('bash_not_enforced')
      expect(result.warnings[0].source).toBe('user')
    } finally {
      ws.cleanup()
    }
  })

  it('ask: rules become deny + ask_treated_as_deny warning', () => {
    const ws = makeWorkspace()
    try {
      writeSettings(join(ws.project, '.owlcoda'), {
        permissions: { ask: ['Edit(src/**)'] },
      })
      const result = loadResolvedPermissions({
        homeDir: ws.home,
        projectRoot: ws.project,
        owlcodaHome: join(ws.home, '.owlcoda'),
      })
      // ask: → deny: at the rule level, but the rule still records itself
      // in .ask for telemetry visibility (so we can see how many ask rules
      // got coerced). Wait — actually per spec we collapse to deny. Verify:
      expect(result.deny.some(r => r.raw === 'Edit(src/**)')).toBe(true)
      expect(result.warnings.some(w => w.reason === 'ask_treated_as_deny')).toBe(true)
    } finally {
      ws.cleanup()
    }
  })

  it('bare string rule emits bare_string warning, no rule loaded', () => {
    const ws = makeWorkspace()
    try {
      writeSettings(join(ws.home, '.owlcoda'), {
        permissions: { deny: ['~/.ssh/**'] },   // missing Tool() wrapper
      })
      const result = loadResolvedPermissions({
        homeDir: ws.home,
        projectRoot: ws.project,
        owlcodaHome: join(ws.home, '.owlcoda'),
      })
      expect(result.deny).toEqual([])
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0].reason).toBe('bare_string')
    } finally {
      ws.cleanup()
    }
  })

  it('invalid JSON in user file → warning, other layers still load', () => {
    const ws = makeWorkspace()
    try {
      const homeOwlcoda = join(ws.home, '.owlcoda')
      mkdirSync(homeOwlcoda, { recursive: true })
      writeFileSync(join(homeOwlcoda, 'settings.json'), '{not valid json')
      writeSettings(join(ws.project, '.owlcoda'), {
        permissions: { deny: ['Write(package-lock.json)'] },
      })
      const result = loadResolvedPermissions({
        homeDir: ws.home,
        projectRoot: ws.project,
        owlcodaHome: homeOwlcoda,
      })
      // Project rule still loaded.
      expect(result.deny).toHaveLength(1)
      expect(result.deny[0].source).toBe('project')
      // User file produced a malformed/parse warning.
      expect(result.warnings.some(w => w.source === 'user')).toBe(true)
    } finally {
      ws.cleanup()
    }
  })

  it('settings.json with no `permissions` key produces no rules and no warnings', () => {
    const ws = makeWorkspace()
    try {
      writeSettings(join(ws.home, '.owlcoda'), { somethingElse: true })
      const result = loadResolvedPermissions({
        homeDir: ws.home,
        projectRoot: ws.project,
        owlcodaHome: join(ws.home, '.owlcoda'),
      })
      expect(result.deny).toEqual([])
      expect(result.allow).toEqual([])
      expect(result.warnings).toEqual([])
    } finally {
      ws.cleanup()
    }
  })

  it('permissions block with empty allow/deny/ask arrays is fine', () => {
    const ws = makeWorkspace()
    try {
      writeSettings(join(ws.home, '.owlcoda'), {
        permissions: { allow: [], deny: [], ask: [] },
      })
      const result = loadResolvedPermissions({
        homeDir: ws.home,
        projectRoot: ws.project,
        owlcodaHome: join(ws.home, '.owlcoda'),
      })
      expect(result.deny).toEqual([])
      expect(result.warnings).toEqual([])
    } finally {
      ws.cleanup()
    }
  })

  it('non-string entries in allow/deny array emit malformed warning per entry', () => {
    const ws = makeWorkspace()
    try {
      writeSettings(join(ws.home, '.owlcoda'), {
        permissions: { deny: [42, null, 'Edit(src/**)'] },
      })
      const result = loadResolvedPermissions({
        homeDir: ws.home,
        projectRoot: ws.project,
        owlcodaHome: join(ws.home, '.owlcoda'),
      })
      // Two malformed warnings (for 42 and null), one valid rule.
      expect(result.deny).toHaveLength(1)
      expect(result.deny[0].raw).toBe('Edit(src/**)')
      expect(result.warnings.filter(w => w.reason === 'malformed')).toHaveLength(2)
    } finally {
      ws.cleanup()
    }
  })
})

describe('compileRulesForTarget — rules → synthetic ProvenanceRecord (PERM-4)', () => {
  const HOME = '/Users/test'
  const PROJECT = '/abs/project'

  function makeRule(raw: string, effect: 'allow' | 'deny'): PermissionRule {
    const r = parsePermissionRule(raw, effect)
    if (!r.rule) throw new Error('test rule failed to parse')
    return r.rule
  }

  function makeRules(opts: { allow?: PermissionRule[]; deny?: PermissionRule[] } = {}): ResolvedPermissions {
    return {
      allow: opts.allow ?? [],
      deny: opts.deny ?? [],
      ask: [],
      warnings: [],
    }
  }

  it('returns empty pathRecords when no rules match', () => {
    const rules = makeRules({ deny: [makeRule('*(~/.ssh/**)', 'deny')] })
    const r = compileRulesForTarget(rules, 'Write', '/abs/project/src/foo.ts', PROJECT, HOME)
    expect(r.pathRecords).toEqual([])
  })

  it('synthesizes a permanent user_explicit_deny when deny rule matches', () => {
    const rules = makeRules({ deny: [makeRule('*(~/.ssh/**)', 'deny')] })
    const r = compileRulesForTarget(rules, 'Write', '/Users/test/.ssh/id_rsa', PROJECT, HOME)
    expect(r.pathRecords).toHaveLength(1)
    expect(r.pathRecords[0].kind).toBe('user_explicit_deny')
    expect(r.pathRecords[0].permanent).toBe(true)
    expect(r.pathRecords[0].originalString).toContain('~/.ssh/**')
  })

  it('synthesizes a permanent user_declared_target when allow rule matches', () => {
    const rules = makeRules({ allow: [makeRule('Edit(src/**)', 'allow')] })
    const r = compileRulesForTarget(rules, 'Edit', '/abs/project/src/foo.ts', PROJECT, HOME)
    expect(r.pathRecords).toHaveLength(1)
    expect(r.pathRecords[0].kind).toBe('user_declared_target')
    expect(r.pathRecords[0].permanent).toBe(true)
  })

  it('skips rules with enforced=false (Bash rules in v1)', () => {
    const rules = makeRules({ deny: [makeRule('Bash(curl *)', 'deny')] })
    // Bash rule is not-enforced. Target is irrelevant for this assertion.
    const r = compileRulesForTarget(rules, 'Bash', '/abs/project/foo', PROJECT, HOME)
    expect(r.pathRecords).toEqual([])
  })

  it('Tool-specific rule matches only that tool, not others', () => {
    const rules = makeRules({ deny: [makeRule('Edit(src/**)', 'deny')] })
    const target = '/abs/project/src/foo.ts'
    expect(compileRulesForTarget(rules, 'Edit', target, PROJECT, HOME).pathRecords).toHaveLength(1)
    expect(compileRulesForTarget(rules, 'Write', target, PROJECT, HOME).pathRecords).toEqual([])
    expect(compileRulesForTarget(rules, 'Bash', target, PROJECT, HOME).pathRecords).toEqual([])
  })

  it('*(pattern) rule matches any tool', () => {
    const rules = makeRules({ deny: [makeRule('*(/abs/sacred/**)', 'deny')] })
    const target = '/abs/sacred/file'
    for (const tool of ['Write', 'Edit', 'Bash', 'NotebookEdit']) {
      expect(
        compileRulesForTarget(rules, tool, target, PROJECT, HOME).pathRecords,
      ).toHaveLength(1)
    }
  })

  it('tool-name comparison is case-insensitive', () => {
    const rules = makeRules({ deny: [makeRule('Edit(src/**)', 'deny')] })
    expect(
      compileRulesForTarget(rules, 'edit', '/abs/project/src/x', PROJECT, HOME).pathRecords,
    ).toHaveLength(1)
    expect(
      compileRulesForTarget(rules, 'EDIT', '/abs/project/src/x', PROJECT, HOME).pathRecords,
    ).toHaveLength(1)
  })

  it('emits one record per matching rule (multiple rules can stack)', () => {
    const rules = makeRules({
      deny: [
        makeRule('*(~/.ssh/**)', 'deny'),
        makeRule('Write(~/.ssh/id_rsa)', 'deny'),
      ],
    })
    const r = compileRulesForTarget(rules, 'Write', '/Users/test/.ssh/id_rsa', PROJECT, HOME)
    expect(r.pathRecords).toHaveLength(2)
    expect(r.pathRecords.every(rec => rec.kind === 'user_explicit_deny')).toBe(true)
  })

  it('synthesizes both deny and allow records when both match (consumer decides precedence)', () => {
    const rules = makeRules({
      deny: [makeRule('*(/abs/secret/**)', 'deny')],
      allow: [makeRule('Write(/abs/secret/**)', 'allow')],
    })
    const r = compileRulesForTarget(rules, 'Write', '/abs/secret/file', PROJECT, HOME)
    expect(r.pathRecords).toHaveLength(2)
    const kinds = r.pathRecords.map(rec => rec.kind).sort()
    expect(kinds).toEqual(['user_declared_target', 'user_explicit_deny'])
    // The deny record carries permanent:true so the eventual admission
    // Step 1 will win — but PERM-4 is just the compiler; precedence is
    // PERM-5's job.
  })

  it('records preserve rule source for debugging', () => {
    const rule: PermissionRule = { ...makeRule('*(~/.ssh/**)', 'deny'), source: 'user' }
    const rules = makeRules({ deny: [rule] })
    const r = compileRulesForTarget(rules, 'Write', '/Users/test/.ssh/id_rsa', PROJECT, HOME)
    expect(r.pathRecords[0].originalString).toContain('user')
  })
})
