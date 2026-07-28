import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProvenanceRecord } from '../../src/native/protocol/write-provenance-types.js'
import {
  admit,
  ancestorDenies,
  canonicalizeProvenancePath,
  cloneProvenanceLedgerData,
  createEmptyProvenanceLedgerData,
  evaluateAdmission,
  extractPathsFromToolResult,
  extractPathsFromUserMessage,
  extractWriteTargets,
  formatProvenanceError,
  isGateProvenanceEnabled,
  parentRecords,
  records,
  size,
} from '../../src/native/write-provenance.js'
import type { ProvenanceTargetEvaluation } from '../../src/native/protocol/write-provenance-types.js'

describe('write target provenance foundation', () => {
  describe('isGateProvenanceEnabled', () => {
    it.each([
      [undefined, false],
      ['0', false],
      ['false', false],
      ['off', false],
      ['garbage', false],
      ['1', true],
      ['true', true],
      ['yes', true],
      [' TRUE ', true],
    ])('parses OWLCODA_GATE_PROVENANCE=%s as %s', (value, expected) => {
      expect(isGateProvenanceEnabled({ OWLCODA_GATE_PROVENANCE: value })).toBe(expected)
    })
  })

  it('creates an empty serializable ledger data shape', () => {
    expect(createEmptyProvenanceLedgerData()).toEqual({
      version: 1,
      recordsByPath: {},
    })
  })

  it('canonicalizes relative paths against cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-prov-'))
    try {
      expect(canonicalizeProvenancePath('notes/out.md', root)).toBe(join(realpathSync(root), 'notes', 'out.md'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('expands bare home paths with the supplied home directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'owlcoda-prov-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'owlcoda-prov-cwd-'))
    try {
      expect(canonicalizeProvenancePath('~/draft.md', cwd, { homeDir: home })).toBe(join(realpathSync(home), 'draft.md'))
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('realpaths existing parents while preserving a non-existent leaf', () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-prov-'))
    try {
      const actual = join(root, 'actual')
      const link = join(root, 'link')
      mkdirSync(actual)
      symlinkSync(actual, link)

      expect(canonicalizeProvenancePath('link/generated.md', root)).toBe(join(realpathSync(actual), 'generated.md'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('ledger admission helpers — basic ops', () => {
  describe('admit + records', () => {
    it('admits a record under the given path key', () => {
      const data = createEmptyProvenanceLedgerData()
      const record: ProvenanceRecord = {
        kind: 'user_declared_target',
        ts: 1000,
        originIteration: 0,
        originalString: '修一下 /abs/a.ts',
        verbContext: '修',
      }
      admit(data, '/abs/a.ts', record)
      expect(records(data, '/abs/a.ts')).toEqual([record])
    })

    it('appends multiple distinct records on same path', () => {
      const data = createEmptyProvenanceLedgerData()
      const r1: ProvenanceRecord = {
        kind: 'user_declared_target',
        ts: 1000,
        originIteration: 0,
        originalString: 'first',
      }
      const r2: ProvenanceRecord = {
        kind: 'tool_confirmed_existing',
        ts: 2000,
        originIteration: 1,
        originalString: 'Read /abs/a.ts',
        toolName: 'Read',
        toolSucceeded: true,
      }
      admit(data, '/abs/a.ts', r1)
      admit(data, '/abs/a.ts', r2)
      expect(records(data, '/abs/a.ts')).toEqual([r1, r2])
    })

    it('dedupes identical records on same path (same kind + originIteration + originalString)', () => {
      const data = createEmptyProvenanceLedgerData()
      const r1: ProvenanceRecord = {
        kind: 'user_declared_target',
        ts: 1000,
        originIteration: 0,
        originalString: '修一下 /abs/a.ts',
      }
      const r2_sameKey: ProvenanceRecord = {
        // identical (kind, originIteration, originalString) — should be deduped
        // even though ts differs.
        kind: 'user_declared_target',
        ts: 1500,
        originIteration: 0,
        originalString: '修一下 /abs/a.ts',
      }
      admit(data, '/abs/a.ts', r1)
      admit(data, '/abs/a.ts', r2_sameKey)
      expect(records(data, '/abs/a.ts')).toEqual([r1])
    })

    it('does not dedupe records with same kind but different originIteration', () => {
      const data = createEmptyProvenanceLedgerData()
      const r1: ProvenanceRecord = {
        kind: 'user_declared_target',
        ts: 1000,
        originIteration: 0,
        originalString: '改 /abs/a.ts',
      }
      const r2: ProvenanceRecord = {
        kind: 'user_declared_target',
        ts: 2000,
        originIteration: 2,  // different iter
        originalString: '改 /abs/a.ts',
      }
      admit(data, '/abs/a.ts', r1)
      admit(data, '/abs/a.ts', r2)
      expect(records(data, '/abs/a.ts')).toEqual([r1, r2])
    })

    it('returns an empty array for unknown path', () => {
      const data = createEmptyProvenanceLedgerData()
      expect(records(data, '/nonexistent')).toEqual([])
    })
  })

  describe('parentRecords', () => {
    it('returns records keyed under dirname(path)', () => {
      const data = createEmptyProvenanceLedgerData()
      const parentRec: ProvenanceRecord = {
        kind: 'parent_listing',
        ts: 1000,
        originIteration: 1,
        originalString: 'ls /abs',
        toolName: 'bash',
      }
      admit(data, '/abs', parentRec)
      expect(parentRecords(data, '/abs/foo.ts')).toEqual([parentRec])
    })

    it('returns empty array when parent has no records', () => {
      const data = createEmptyProvenanceLedgerData()
      admit(data, '/abs/foo.ts', {
        kind: 'tool_confirmed_existing',
        ts: 0,
        originIteration: 0,
        originalString: '',
      })
      // /abs is parent but has no records of its own
      expect(parentRecords(data, '/abs/foo.ts')).toEqual([])
    })

    it('uses path dirname (does not match by prefix)', () => {
      const data = createEmptyProvenanceLedgerData()
      // /abs/foo has a record; /abs/foo/bar.ts asks for its parent records
      admit(data, '/abs/foo', {
        kind: 'parent_listing',
        ts: 0,
        originIteration: 0,
        originalString: 'ls /abs/foo',
      })
      expect(parentRecords(data, '/abs/foo/bar.ts')).toHaveLength(1)
      // But asking parentRecords for /abs/foo (whose parent is /abs) should not return that
      expect(parentRecords(data, '/abs/foo')).toEqual([])
    })
  })

  describe('size', () => {
    it('counts all records across all paths', () => {
      const data = createEmptyProvenanceLedgerData()
      expect(size(data)).toBe(0)
      admit(data, '/a', {
        kind: 'user_reference',
        ts: 0,
        originIteration: 0,
        originalString: '/a',
      })
      expect(size(data)).toBe(1)
      admit(data, '/a', {
        kind: 'user_declared_target',
        ts: 0,
        originIteration: 1,
        originalString: '/a',
      })
      expect(size(data)).toBe(2)
      admit(data, '/b', {
        kind: 'user_reference',
        ts: 0,
        originIteration: 0,
        originalString: '/b',
      })
      expect(size(data)).toBe(3)
    })

    it('does not count deduped records twice', () => {
      const data = createEmptyProvenanceLedgerData()
      const r: ProvenanceRecord = {
        kind: 'user_reference',
        ts: 0,
        originIteration: 0,
        originalString: '/a',
      }
      admit(data, '/a', r)
      admit(data, '/a', r)
      admit(data, '/a', r)
      expect(size(data)).toBe(1)
    })
  })
})

describe('ancestorDenies — subtree deny precedence walker', () => {
  function makeSubtreeDeny(ts: number, originalString: string): ProvenanceRecord {
    return {
      kind: 'user_explicit_deny',
      ts,
      originIteration: 0,
      originalString,
      denyMarker: '不要改',
      denyScope: 'subtree',
    }
  }

  function makeExactDeny(ts: number, originalString: string): ProvenanceRecord {
    return {
      kind: 'user_explicit_deny',
      ts,
      originIteration: 0,
      originalString,
      denyMarker: '不要改',
      denyScope: 'exact',
    }
  }

  it('returns empty array for empty ledger', () => {
    const data = createEmptyProvenanceLedgerData()
    expect(ancestorDenies(data, '/tmp/project/a.ts')).toEqual([])
  })

  it('returns subtree deny on parent directory with sourcePath', () => {
    const data = createEmptyProvenanceLedgerData()
    const deny = makeSubtreeDeny(1000, '不要改 /tmp/project')
    admit(data, '/tmp/project', deny)
    expect(ancestorDenies(data, '/tmp/project/a.ts')).toEqual([
      { sourcePath: '/tmp/project', record: deny },
    ])
  })

  it('returns subtree deny on grandparent (walks multiple levels)', () => {
    const data = createEmptyProvenanceLedgerData()
    const deny = makeSubtreeDeny(1000, '不要改 /tmp')
    admit(data, '/tmp', deny)
    expect(ancestorDenies(data, '/tmp/project/sub/a.ts')).toEqual([
      { sourcePath: '/tmp', record: deny },
    ])
  })

  it('returns multiple subtree denies when several ancestors match', () => {
    const data = createEmptyProvenanceLedgerData()
    const denyTmp = makeSubtreeDeny(1000, '不要改 /tmp')
    const denyProj = makeSubtreeDeny(2000, '不要改 /tmp/project')
    admit(data, '/tmp', denyTmp)
    admit(data, '/tmp/project', denyProj)
    const result = ancestorDenies(data, '/tmp/project/a.ts')
    expect(result).toHaveLength(2)
    expect(result).toEqual(
      expect.arrayContaining([
        { sourcePath: '/tmp', record: denyTmp },
        { sourcePath: '/tmp/project', record: denyProj },
      ]),
    )
  })

  it('ignores exact-scope deny on parent (not a subtree deny)', () => {
    const data = createEmptyProvenanceLedgerData()
    const exact = makeExactDeny(1000, '不要改 /tmp/project')
    admit(data, '/tmp/project', exact)
    // /tmp/project is a parent but its deny is exact-scope; should not block descendants.
    expect(ancestorDenies(data, '/tmp/project/a.ts')).toEqual([])
  })

  it('ignores non-deny records on ancestor', () => {
    const data = createEmptyProvenanceLedgerData()
    admit(data, '/tmp/project', {
      kind: 'parent_listing',
      ts: 0,
      originIteration: 0,
      originalString: 'ls /tmp/project',
    })
    admit(data, '/tmp/project', {
      kind: 'user_reference',
      ts: 0,
      originIteration: 0,
      originalString: '/tmp/project',
    })
    expect(ancestorDenies(data, '/tmp/project/a.ts')).toEqual([])
  })

  it('does NOT include deny on the path itself (only ancestors)', () => {
    const data = createEmptyProvenanceLedgerData()
    const denyOnPath = makeSubtreeDeny(1000, '不要改 /tmp/project/a.ts')
    admit(data, '/tmp/project/a.ts', denyOnPath)
    // exact-path denies on `/tmp/project/a.ts` itself are not "ancestor" denies;
    // evaluateAdmission handles those separately via records(path).
    expect(ancestorDenies(data, '/tmp/project/a.ts')).toEqual([])
  })

  it('mixed subtree + exact denies on same ancestor — returns only subtree, with sourcePath', () => {
    const data = createEmptyProvenanceLedgerData()
    const subtreeDeny = makeSubtreeDeny(1000, '不要改 /tmp/project')
    const exactDeny = makeExactDeny(2000, '不要改 /tmp/project (specific)')
    admit(data, '/tmp/project', subtreeDeny)
    admit(data, '/tmp/project', exactDeny)
    expect(ancestorDenies(data, '/tmp/project/a.ts')).toEqual([
      { sourcePath: '/tmp/project', record: subtreeDeny },
    ])
  })
})

describe('cloneProvenanceLedgerData — snapshot deep copy', () => {
  it('returns a new object with equal contents', () => {
    const parent = createEmptyProvenanceLedgerData()
    admit(parent, '/a', {
      kind: 'user_declared_target',
      ts: 1000,
      originIteration: 0,
      originalString: '改 /a',
    })
    const child = cloneProvenanceLedgerData(parent)
    expect(child).not.toBe(parent)
    expect(child).toEqual(parent)
  })

  it('clone mutation does not affect parent', () => {
    const parent = createEmptyProvenanceLedgerData()
    admit(parent, '/a', {
      kind: 'user_declared_target',
      ts: 1000,
      originIteration: 0,
      originalString: '改 /a',
    })
    const child = cloneProvenanceLedgerData(parent)
    admit(child, '/b', {
      kind: 'user_declared_target',
      ts: 2000,
      originIteration: 1,
      originalString: '改 /b',
    })
    expect(records(parent, '/b')).toEqual([])
    expect(records(child, '/b')).toHaveLength(1)
  })

  it('parent mutation after clone does not affect child', () => {
    const parent = createEmptyProvenanceLedgerData()
    admit(parent, '/a', {
      kind: 'user_declared_target',
      ts: 1000,
      originIteration: 0,
      originalString: '改 /a',
    })
    const child = cloneProvenanceLedgerData(parent)
    admit(parent, '/b', {
      kind: 'user_declared_target',
      ts: 2000,
      originIteration: 1,
      originalString: '改 /b',
    })
    expect(records(child, '/b')).toEqual([])
    expect(records(parent, '/b')).toHaveLength(1)
  })

  it('record array mutation in clone does not affect parent', () => {
    // Records array reference must be deep-copied, not shared.
    const parent = createEmptyProvenanceLedgerData()
    admit(parent, '/a', {
      kind: 'user_reference',
      ts: 0,
      originIteration: 0,
      originalString: 'r1',
    })
    const child = cloneProvenanceLedgerData(parent)
    admit(child, '/a', {
      kind: 'user_declared_target',
      ts: 1,
      originIteration: 1,
      originalString: 'r2',
    })
    expect(records(parent, '/a')).toHaveLength(1)
    expect(records(child, '/a')).toHaveLength(2)
  })

  it('clone of clone works (chained snapshot)', () => {
    const a = createEmptyProvenanceLedgerData()
    admit(a, '/x', {
      kind: 'user_reference',
      ts: 0,
      originIteration: 0,
      originalString: 'x',
    })
    const b = cloneProvenanceLedgerData(a)
    const c = cloneProvenanceLedgerData(b)
    admit(c, '/y', {
      kind: 'user_reference',
      ts: 0,
      originIteration: 1,
      originalString: 'y',
    })
    expect(size(a)).toBe(1)
    expect(size(b)).toBe(1)
    expect(size(c)).toBe(2)
  })

  it('preserves all record fields including deny markers and scope', () => {
    const parent = createEmptyProvenanceLedgerData()
    admit(parent, '/tmp/project', {
      kind: 'user_explicit_deny',
      ts: 1000,
      originIteration: 0,
      originalString: '不要改 /tmp/project',
      denyMarker: '不要改',
      denyScope: 'subtree',
    })
    const child = cloneProvenanceLedgerData(parent)
    expect(records(child, '/tmp/project')[0]).toEqual(records(parent, '/tmp/project')[0])
    expect(records(child, '/tmp/project')[0].denyScope).toBe('subtree')
  })
})

describe('evaluateAdmission — admission decisions', () => {
  const dummyTs = (n: number): ProvenanceRecord => ({
    kind: 'user_reference',
    ts: n,
    originIteration: 0,
    originalString: 'x',
  })

  describe('Step 2: admit rules (no deny)', () => {
    it('blocks empty ledger for existing file', () => {
      const data = createEmptyProvenanceLedgerData()
      const r = evaluateAdmission(data, '/abs/a.ts', false)
      expect(r.admitted).toBe(false)
      expect(r.denyActive).toBeFalsy()
      expect(r.availableRecords).toEqual({ path: [], parent: [] })
    })

    it('blocks empty ledger for new file', () => {
      const data = createEmptyProvenanceLedgerData()
      const r = evaluateAdmission(data, '/abs/a.ts', true)
      expect(r.admitted).toBe(false)
      expect(r.denyActive).toBeFalsy()
    })

    it('admits via user_declared_target for existing file', () => {
      const data = createEmptyProvenanceLedgerData()
      const declared: ProvenanceRecord = {
        kind: 'user_declared_target',
        ts: 100,
        originIteration: 0,
        originalString: '改 /abs/a.ts',
        verbContext: '改',
      }
      admit(data, '/abs/a.ts', declared)
      const r = evaluateAdmission(data, '/abs/a.ts', false)
      expect(r.admitted).toBe(true)
      expect(r.via).toBe('user_declared_target')
      expect(r.record).toEqual(declared)
    })

    it('admits via user_declared_target for new file', () => {
      const data = createEmptyProvenanceLedgerData()
      const declared: ProvenanceRecord = {
        kind: 'user_declared_target',
        ts: 100,
        originIteration: 0,
        originalString: '写 /abs/new.ts',
        verbContext: '写',
      }
      admit(data, '/abs/new.ts', declared)
      const r = evaluateAdmission(data, '/abs/new.ts', true)
      expect(r.admitted).toBe(true)
      expect(r.via).toBe('user_declared_target')
    })

    it('admits via tool_confirmed_existing for existing file', () => {
      const data = createEmptyProvenanceLedgerData()
      const confirmed: ProvenanceRecord = {
        kind: 'tool_confirmed_existing',
        ts: 200,
        originIteration: 1,
        originalString: '/abs/a.ts',
        toolName: 'Read',
        toolSucceeded: true,
      }
      admit(data, '/abs/a.ts', confirmed)
      const r = evaluateAdmission(data, '/abs/a.ts', false)
      expect(r.admitted).toBe(true)
      expect(r.via).toBe('tool_confirmed_existing')
    })

    it('does not admit via tool_confirmed_existing for new file (siblings do not authorize parent)', () => {
      const data = createEmptyProvenanceLedgerData()
      // sibling existed on disk, but the target is a NEW file in same dir
      admit(data, '/abs/sibling.ts', {
        kind: 'tool_confirmed_existing',
        ts: 200,
        originIteration: 1,
        originalString: '/abs/sibling.ts',
        toolName: 'Read',
      })
      // new file admission for /abs/newfile.ts:
      const r = evaluateAdmission(data, '/abs/newfile.ts', true)
      expect(r.admitted).toBe(false)
    })

    it('admits via parent_listing for new file', () => {
      const data = createEmptyProvenanceLedgerData()
      const listing: ProvenanceRecord = {
        kind: 'parent_listing',
        ts: 300,
        originIteration: 2,
        originalString: 'ls /abs/',
        toolName: 'bash',
      }
      admit(data, '/abs', listing)
      const r = evaluateAdmission(data, '/abs/newfile.ts', true)
      expect(r.admitted).toBe(true)
      expect(r.via).toBe('parent_listing')
    })

    it('does not admit via parent_listing for existing file (need path-level evidence)', () => {
      const data = createEmptyProvenanceLedgerData()
      admit(data, '/abs', {
        kind: 'parent_listing',
        ts: 300,
        originIteration: 2,
        originalString: 'ls /abs/',
      })
      // existing file admission for /abs/a.ts: need user_declared_target or tool_confirmed_existing
      const r = evaluateAdmission(data, '/abs/a.ts', false)
      expect(r.admitted).toBe(false)
    })

    it('rejects user_reference alone (existing file)', () => {
      const data = createEmptyProvenanceLedgerData()
      admit(data, '/abs/a.ts', {
        kind: 'user_reference',
        ts: 100,
        originIteration: 0,
        originalString: '在 log 看到 /abs/a.ts',
      })
      const r = evaluateAdmission(data, '/abs/a.ts', false)
      expect(r.admitted).toBe(false)
      expect(r.availableRecords?.path).toHaveLength(1)
    })

    it('rejects user_reference alone (new file)', () => {
      const data = createEmptyProvenanceLedgerData()
      admit(data, '/abs/new.ts', {
        kind: 'user_reference',
        ts: 100,
        originIteration: 0,
        originalString: '/abs/new.ts',
      })
      const r = evaluateAdmission(data, '/abs/new.ts', true)
      expect(r.admitted).toBe(false)
    })
  })

  describe('Step 1: deny precedence', () => {
    const makeDeny = (ts: number, scope: 'exact' | 'subtree' = 'exact'): ProvenanceRecord => ({
      kind: 'user_explicit_deny',
      ts,
      originIteration: 0,
      originalString: 'not allowed',
      denyMarker: '不要改',
      denyScope: scope,
    })

    const makeRevoke = (ts: number): ProvenanceRecord => ({
      kind: 'user_explicit_revoke',
      ts,
      originIteration: 1,
      originalString: 'allow now',
      revokeMarker: '算了',
      verbContext: '改',
    })

    it('blocks on exact deny with no revoke', () => {
      const data = createEmptyProvenanceLedgerData()
      const deny = makeDeny(1000)
      admit(data, '/tmp/foo', deny)
      const r = evaluateAdmission(data, '/tmp/foo', false)
      expect(r.admitted).toBe(false)
      expect(r.denyActive).toBe(true)
      expect(r.activeDenyRecord).toEqual(deny)
    })

    it('lifts exact deny when revoke ts > deny ts', () => {
      const data = createEmptyProvenanceLedgerData()
      admit(data, '/tmp/foo', makeDeny(1000))
      admit(data, '/tmp/foo', makeRevoke(2000))
      // Also add a declared_target so Step 2 can admit
      admit(data, '/tmp/foo', {
        kind: 'user_declared_target',
        ts: 2000,
        originIteration: 1,
        originalString: '算了 改吧 /tmp/foo',
        verbContext: '改',
      })
      const r = evaluateAdmission(data, '/tmp/foo', false)
      expect(r.denyActive).toBeFalsy()
      expect(r.admitted).toBe(true)
      expect(r.via).toBe('user_declared_target')
    })

    it('keeps deny active when revoke ts < deny ts (deny re-asserted later)', () => {
      const data = createEmptyProvenanceLedgerData()
      admit(data, '/tmp/foo', makeRevoke(500))   // earlier revoke
      const deny = makeDeny(1000)
      admit(data, '/tmp/foo', deny)
      const r = evaluateAdmission(data, '/tmp/foo', false)
      expect(r.admitted).toBe(false)
      expect(r.denyActive).toBe(true)
      expect(r.activeDenyRecord?.ts).toBe(1000)
    })

    it('blocks on subtree deny on ancestor', () => {
      const data = createEmptyProvenanceLedgerData()
      const subDeny = makeDeny(1000, 'subtree')
      admit(data, '/tmp/project', subDeny)
      const r = evaluateAdmission(data, '/tmp/project/a.ts', false)
      expect(r.admitted).toBe(false)
      expect(r.denyActive).toBe(true)
      expect(r.activeDenyRecord).toEqual(subDeny)
    })

    it('lifts subtree deny when revoke on the SAME ancestor and later', () => {
      const data = createEmptyProvenanceLedgerData()
      admit(data, '/tmp/project', makeDeny(1000, 'subtree'))
      admit(data, '/tmp/project', makeRevoke(2000))
      // Add parent_listing so Step 2 can admit a child new file
      admit(data, '/tmp/project', {
        kind: 'parent_listing',
        ts: 2000,
        originIteration: 1,
        originalString: 'ls /tmp/project',
      })
      const r = evaluateAdmission(data, '/tmp/project/a.ts', true)
      expect(r.denyActive).toBeFalsy()
      expect(r.admitted).toBe(true)
      expect(r.via).toBe('parent_listing')
    })

    it('keeps subtree deny active when revoke is on CHILD path (F36 scope match)', () => {
      const data = createEmptyProvenanceLedgerData()
      admit(data, '/tmp/project', makeDeny(1000, 'subtree'))
      // Revoke is on the CHILD path, not the ancestor — does not lift the parent deny
      admit(data, '/tmp/project/a.ts', makeRevoke(2000))
      const r = evaluateAdmission(data, '/tmp/project/a.ts', false)
      expect(r.admitted).toBe(false)
      expect(r.denyActive).toBe(true)
    })

    it('blocks when any of multiple subtree denies is unrevoked', () => {
      const data = createEmptyProvenanceLedgerData()
      admit(data, '/tmp', makeDeny(1000, 'subtree'))
      admit(data, '/tmp/project', makeDeny(1500, 'subtree'))
      // Only revoke the inner one
      admit(data, '/tmp/project', makeRevoke(2000))
      const r = evaluateAdmission(data, '/tmp/project/a.ts', false)
      // Outer /tmp subtree deny still active
      expect(r.admitted).toBe(false)
      expect(r.denyActive).toBe(true)
      expect(r.activeDenyRecord?.ts).toBe(1000)
    })

    it('blocks via subtree deny on ancestor even when exact deny on path is lifted', () => {
      const data = createEmptyProvenanceLedgerData()
      // Exact deny on path, revoked
      admit(data, '/tmp/project/a.ts', makeDeny(500))
      admit(data, '/tmp/project/a.ts', makeRevoke(1000))
      // But subtree deny on /tmp/project, NOT revoked
      admit(data, '/tmp/project', makeDeny(800, 'subtree'))
      const r = evaluateAdmission(data, '/tmp/project/a.ts', false)
      expect(r.admitted).toBe(false)
      expect(r.denyActive).toBe(true)
      expect(r.activeDenyRecord?.denyScope).toBe('subtree')
    })

    it('reports the most-recent unrevoked deny as activeDenyRecord', () => {
      const data = createEmptyProvenanceLedgerData()
      admit(data, '/a', makeDeny(1000, 'subtree'))
      admit(data, '/a/b', makeDeny(2000, 'subtree'))
      const r = evaluateAdmission(data, '/a/b/c.ts', false)
      expect(r.denyActive).toBe(true)
      // 2000 > 1000, so the inner one is more recent
      expect(r.activeDenyRecord?.ts).toBe(2000)
    })

    it('uses dummyTs to silence unused-var warning', () => {
      // Sanity: dummyTs helper used in fixtures
      expect(dummyTs(1).ts).toBe(1)
    })
  })

  describe('Step 0: synthetic permanent records (PERM-5)', () => {
    const permanentDeny: ProvenanceRecord = {
      kind: 'user_explicit_deny',
      ts: Number.NEGATIVE_INFINITY,
      originIteration: -1,
      originalString: 'settings.json (user): *(~/.ssh/**)',
      denyMarker: 'settings_rule',
      denyScope: 'exact',
      permanent: true,
    }
    const permanentAdmit: ProvenanceRecord = {
      kind: 'user_declared_target',
      ts: Number.NEGATIVE_INFINITY,
      originIteration: -1,
      originalString: 'settings.json (user): Edit(./out/**)',
      verbContext: 'settings_rule',
      permanent: true,
    }

    it('synthetic permanent deny blocks the write', () => {
      const data = createEmptyProvenanceLedgerData()
      const r = evaluateAdmission(data, '/Users/me/.ssh/id_rsa', false, {
        syntheticPathRecords: [permanentDeny],
      })
      expect(r.admitted).toBe(false)
      expect(r.denyActive).toBe(true)
      expect(r.activeDenyRecord?.permanent).toBe(true)
    })

    it('synthetic permanent deny survives a conversation revoke', () => {
      // The user said "算了 改吧 X" — normally that would lift any
      // conversation-level deny. But a permanent (rule-driven) deny does
      // NOT respond to that.
      const data = createEmptyProvenanceLedgerData()
      admit(data, '/Users/me/.ssh/id_rsa', {
        kind: 'user_explicit_revoke',
        ts: 9999999999,                   // very recent revoke
        originIteration: 5,
        originalString: '算了 改吧 ~/.ssh/id_rsa',
        revokeMarker: '算了',
      })
      // Also a declared_target so Step 2 would admit absent the deny.
      admit(data, '/Users/me/.ssh/id_rsa', {
        kind: 'user_declared_target',
        ts: 9999999999,
        originIteration: 5,
        originalString: '算了 改吧 ~/.ssh/id_rsa',
        verbContext: '改',
      })

      const r = evaluateAdmission(data, '/Users/me/.ssh/id_rsa', false, {
        syntheticPathRecords: [permanentDeny],
      })
      expect(r.admitted).toBe(false)
      expect(r.denyActive).toBe(true)
      expect(r.activeDenyRecord?.permanent).toBe(true)
    })

    it('synthetic permanent admit authorizes when ledger has only user_reference', () => {
      const data = createEmptyProvenanceLedgerData()
      admit(data, '/abs/project/out/foo.ts', {
        kind: 'user_reference',
        ts: 100,
        originIteration: 0,
        originalString: '/abs/project/out/foo.ts',
      })
      const r = evaluateAdmission(data, '/abs/project/out/foo.ts', false, {
        syntheticPathRecords: [permanentAdmit],
      })
      expect(r.admitted).toBe(true)
      expect(r.via).toBe('user_declared_target')
    })

    it('synthetic permanent admit authorizes new file (no parent_listing needed)', () => {
      const data = createEmptyProvenanceLedgerData()
      const r = evaluateAdmission(data, '/abs/project/out/newdir/file.ts', true, {
        syntheticPathRecords: [permanentAdmit],
      })
      expect(r.admitted).toBe(true)
      expect(r.via).toBe('user_declared_target')
    })

    it('synthetic permanent deny wins when both deny and admit are present', () => {
      // User has both `deny: ['*(/abs/x/**)']` and `allow: ['Write(/abs/x/**)']`.
      // Per CC semantics, deny wins. Our synthetic injection respects this
      // via Step 1 running before Step 2.
      const data = createEmptyProvenanceLedgerData()
      const r = evaluateAdmission(data, '/abs/x/file', false, {
        syntheticPathRecords: [permanentDeny, permanentAdmit],
      })
      expect(r.admitted).toBe(false)
      expect(r.denyActive).toBe(true)
    })

    it('syntheticParentRecords allow new-file admission when rule grants parent', () => {
      // An allow rule like `Edit(./out)` (no globstar) wouldn't match a child
      // file directly. But if we ALSO seed parent_listing on the parent dir,
      // new-file admission can pick it up.
      // (PERM-4 doesn't currently produce parent_listing records — this test
      // verifies the option works should a future variant need it.)
      const parentListing: ProvenanceRecord = {
        kind: 'parent_listing',
        ts: Number.NEGATIVE_INFINITY,
        originIteration: -1,
        originalString: 'settings.json',
        permanent: true,
      }
      const data = createEmptyProvenanceLedgerData()
      const r = evaluateAdmission(data, '/abs/project/out/newfile.ts', true, {
        syntheticParentRecords: [parentListing],
      })
      expect(r.admitted).toBe(true)
      expect(r.via).toBe('parent_listing')
    })

    it('no synthetic records → admission unchanged from pre-PERM-5 behavior', () => {
      // Regression guard. Existing call sites without `opts` must keep
      // working unchanged.
      const data = createEmptyProvenanceLedgerData()
      const r = evaluateAdmission(data, '/abs/x', false)
      expect(r.admitted).toBe(false)
    })
  })
})

describe('admission fixtures — spec F-IDs (synthetic records, no extractor)', () => {
  // These fixtures use synthetic records to demonstrate admission behavior
  // at the ledger level. Extractor classification is S0-3; this layer
  // assumes the extractor would produce these records and validates that
  // evaluateAdmission responds correctly. Names match spec §8 fixture IDs.

  const declared = (path: string, verb = '改'): ProvenanceRecord => ({
    kind: 'user_declared_target',
    ts: 1000,
    originIteration: 0,
    originalString: `${verb}一下 ${path}`,
    verbContext: verb,
  })
  const reference = (path: string): ProvenanceRecord => ({
    kind: 'user_reference',
    ts: 1000,
    originIteration: 0,
    originalString: path,
  })
  const toolConfirmed = (path: string, tool = 'Read'): ProvenanceRecord => ({
    kind: 'tool_confirmed_existing',
    ts: 2000,
    originIteration: 1,
    originalString: path,
    toolName: tool,
    toolSucceeded: true,
  })
  const parentListing = (tool = 'bash'): ProvenanceRecord => ({
    kind: 'parent_listing',
    ts: 3000,
    originIteration: 2,
    originalString: 'ls dir/',
    toolName: tool,
  })
  // iter param avoids dedupe collision when same kind/originalString repeats across turns
  const deny = (scope: 'exact' | 'subtree' = 'exact', ts = 5000, iter = 0): ProvenanceRecord => ({
    kind: 'user_explicit_deny',
    ts,
    originIteration: iter,
    originalString: `not allowed (iter ${iter})`,
    denyMarker: '不要改',
    denyScope: scope,
  })
  const revoke = (ts = 6000, iter = 1): ProvenanceRecord => ({
    kind: 'user_explicit_revoke',
    ts,
    originIteration: iter,
    originalString: `algo le (iter ${iter})`,
    revokeMarker: '算了',
    verbContext: '改',
  })

  it('F21: pure existential user_reference does not authorize write', () => {
    const data = createEmptyProvenanceLedgerData()
    admit(data, '/abs/utils.ts', reference('/abs/utils.ts'))
    expect(evaluateAdmission(data, '/abs/utils.ts', false).admitted).toBe(false)
  })

  it('F22: existential reference (旧文件在 …) does not authorize write', () => {
    const data = createEmptyProvenanceLedgerData()
    admit(data, '/abs/old.ts', {
      kind: 'user_reference',
      ts: 1000,
      originIteration: 0,
      originalString: '旧文件在 /abs/old.ts',
    })
    expect(evaluateAdmission(data, '/abs/old.ts', false).admitted).toBe(false)
  })

  it('F25: Read sibling does not admit creating new file in same dir', () => {
    const data = createEmptyProvenanceLedgerData()
    admit(data, '/abs/sibling.ts', toolConfirmed('/abs/sibling.ts'))
    expect(evaluateAdmission(data, '/abs/newfile.ts', true).admitted).toBe(false)
  })

  it('F26: declared_target spans multiple paths in one message (synthetic)', () => {
    const data = createEmptyProvenanceLedgerData()
    admit(data, '/abs/a.ts', declared('/abs/a.ts'))
    admit(data, '/abs/b.ts', declared('/abs/b.ts'))
    expect(evaluateAdmission(data, '/abs/a.ts', false).admitted).toBe(true)
    expect(evaluateAdmission(data, '/abs/b.ts', false).admitted).toBe(true)
  })

  it('F28: bare path mention (user_reference) does not authorize write', () => {
    const data = createEmptyProvenanceLedgerData()
    admit(data, '/a/b', reference('/a/b'))
    expect(evaluateAdmission(data, '/a/b', false).admitted).toBe(false)
  })

  it('F29: exact deny blocks write to that path', () => {
    const data = createEmptyProvenanceLedgerData()
    admit(data, '/tmp/foo', deny('exact'))
    const r = evaluateAdmission(data, '/tmp/foo', false)
    expect(r.admitted).toBe(false)
    expect(r.denyActive).toBe(true)
  })

  it('F30: revoke after deny (dual record) admits subsequent write', () => {
    const data = createEmptyProvenanceLedgerData()
    admit(data, '/tmp/foo', deny('exact', 1000))
    // Extractor Stage B emits both records on revoke; here synthetic:
    admit(data, '/tmp/foo', revoke(2000))
    admit(data, '/tmp/foo', declared('/tmp/foo'))
    const r = evaluateAdmission(data, '/tmp/foo', false)
    expect(r.admitted).toBe(true)
    expect(r.via).toBe('user_declared_target')
  })

  it('F31: vague follow-up (no path + verb pair) does not revoke deny', () => {
    const data = createEmptyProvenanceLedgerData()
    admit(data, '/tmp/foo', deny('exact', 1000))
    // No revoke record at all — vague "那个改一下" produces no user_explicit_revoke
    // because Stage B requires marker + verb + path. Empty revoke ledger.
    const r = evaluateAdmission(data, '/tmp/foo', false)
    expect(r.admitted).toBe(false)
    expect(r.denyActive).toBe(true)
  })

  it('F32: deny → revoke → deny re-asserted', () => {
    const data = createEmptyProvenanceLedgerData()
    admit(data, '/tmp/foo', deny('exact', 1000, 0))
    admit(data, '/tmp/foo', revoke(2000, 1))
    admit(data, '/tmp/foo', deny('exact', 3000, 2)) // re-asserted at later iter
    const r = evaluateAdmission(data, '/tmp/foo', false)
    expect(r.admitted).toBe(false)
    expect(r.denyActive).toBe(true)
    expect(r.activeDenyRecord?.ts).toBe(3000)
  })

  it('F34: subtree deny on existing directory blocks descendant write', () => {
    const data = createEmptyProvenanceLedgerData()
    admit(data, '/tmp/project', deny('subtree'))
    const r = evaluateAdmission(data, '/tmp/project/a.ts', true)
    expect(r.admitted).toBe(false)
    expect(r.denyActive).toBe(true)
  })

  it('F35: deny on non-existent path with denyScope=exact (defensive default) blocks exact path', () => {
    const data = createEmptyProvenanceLedgerData()
    // Extractor would set denyScope='exact' on ENOENT; admission uses ?? 'exact' fallback
    const denyNoScope: ProvenanceRecord = {
      kind: 'user_explicit_deny',
      ts: 1000,
      originIteration: 0,
      originalString: '不要改 /tmp/missing.txt',
      denyMarker: '不要改',
      // denyScope intentionally omitted to verify defensive fallback
    }
    admit(data, '/tmp/missing.txt', denyNoScope)
    const r = evaluateAdmission(data, '/tmp/missing.txt', true)
    expect(r.admitted).toBe(false)
    expect(r.denyActive).toBe(true)
  })

  it('F36: child-path revoke does NOT lift parent subtree deny', () => {
    const data = createEmptyProvenanceLedgerData()
    admit(data, '/tmp/project', deny('subtree', 1000))
    admit(data, '/tmp/project/a.ts', revoke(2000)) // revoke is on CHILD path
    const r = evaluateAdmission(data, '/tmp/project/a.ts', false)
    expect(r.admitted).toBe(false)
    expect(r.denyActive).toBe(true)
    expect(r.activeDenyRecord?.denyScope).toBe('subtree')
  })

  it('F37a: parent subtree revoke lifts deny BUT child still has no admission', () => {
    const data = createEmptyProvenanceLedgerData()
    admit(data, '/tmp/project', deny('subtree', 1000))
    admit(data, '/tmp/project', revoke(2000))     // matching-scope revoke
    // BUT no parent_listing emitted, and no user_declared_target on the child
    const r = evaluateAdmission(data, '/tmp/project/a.ts', true)
    expect(r.denyActive).toBeFalsy()                // deny lifted
    expect(r.admitted).toBe(false)                  // but still blocked at Step 2
  })

  it('F37b: parent subtree revoke + ls /tmp/project/ → child new-file write passes', () => {
    const data = createEmptyProvenanceLedgerData()
    admit(data, '/tmp/project', deny('subtree', 1000))
    admit(data, '/tmp/project', revoke(2000))
    admit(data, '/tmp/project', parentListing())   // ls /tmp/project (kind=parent_listing)
    const r = evaluateAdmission(data, '/tmp/project/a.ts', true)
    expect(r.admitted).toBe(true)
    expect(r.via).toBe('parent_listing')
  })
})

describe('extractPathsFromUserMessage — Stage D (user_reference default)', () => {
  const tmpCwd = realpathSync(tmpdir())   // any existing dir, used for relative resolution

  // Tests use paths under a non-existent ancestor (`/nonexistent-test-root`)
  // so canonicalize() won't realpath them to symlinked targets like
  // /tmp -> /private/tmp on macOS. The canonicalize() helper falls through
  // to the literal abs path when no ancestor exists on disk.

  it('returns empty result for empty text', () => {
    const r = extractPathsFromUserMessage('', { cwd: tmpCwd, ts: 0, originIteration: 0 })
    expect(r.extractions).toEqual([])
    expect(r.skippedGlobDenies).toEqual([])
  })

  it('returns empty result for text without path-like tokens', () => {
    const r = extractPathsFromUserMessage('看一下结果就行', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toEqual([])
  })

  it('scans long path-free text in bounded time', () => {
    const startedAt = performance.now()
    const r = extractPathsFromUserMessage('x'.repeat(50_000), {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })

    expect(r.extractions).toEqual([])
    expect(performance.now() - startedAt).toBeLessThan(250)
  })

  it('classifies bare path mention (no verb / no deny marker) as user_reference', () => {
    const r = extractPathsFromUserMessage('error log: 看 /nonexistent-test-root/utils.ts 那个 stack trace', {
      cwd: tmpCwd, ts: 1000, originIteration: 0,
    })
    expect(r.extractions).toHaveLength(1)
    expect(r.extractions[0].kind).toBe('user_reference')
    expect(r.extractions[0].path).toBe('/nonexistent-test-root/utils.ts')
    // path is canonicalized; originalString preserves a window around how it appeared
    expect(r.extractions[0].originalString).toContain('/nonexistent-test-root/utils.ts')
    // No verb/deny/revoke metadata for plain references
    expect(r.extractions[0].verbContext).toBeUndefined()
    expect(r.extractions[0].denyMarker).toBeUndefined()
    expect(r.extractions[0].revokeMarker).toBeUndefined()
  })

  it('extracts multiple paths from same message', () => {
    const r = extractPathsFromUserMessage('我刚看了 /nonexistent-test-root/a.ts 和 /nonexistent-test-root/b.ts', {
      cwd: tmpCwd, ts: 1000, originIteration: 0,
    })
    expect(r.extractions).toHaveLength(2)
    expect(r.extractions.map(e => e.path).sort()).toEqual([
      '/nonexistent-test-root/a.ts',
      '/nonexistent-test-root/b.ts',
    ])
    for (const ex of r.extractions) {
      expect(ex.kind).toBe('user_reference')
    }
  })

  it('canonicalizes relative paths against cwd', () => {
    const r = extractPathsFromUserMessage('check src/foo.ts please', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toHaveLength(1)
    expect(r.extractions[0].path).toBe(join(tmpCwd, 'src/foo.ts'))
  })

  it('ignores http(s) URLs', () => {
    const r = extractPathsFromUserMessage('see https://example.com/foo/bar for details', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toEqual([])
  })

  it('ignores single-segment tokens without slash', () => {
    const r = extractPathsFromUserMessage('看 README 或 LICENSE 还有 package.json', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    // Bare filenames without a slash do not match the path-token regex
    expect(r.extractions).toEqual([])
  })

  it('strips trailing punctuation from extracted path', () => {
    const r = extractPathsFromUserMessage('我看 /nonexistent-test-root/x.ts, /nonexistent-test-root/y.ts. 看到了', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions.map(e => e.path).sort()).toEqual([
      '/nonexistent-test-root/x.ts',
      '/nonexistent-test-root/y.ts',
    ])
  })

  it('does not classify version strings or pure numerics as paths', () => {
    const r = extractPathsFromUserMessage('we are on 1.2.3 of 5.6.7 right now', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toEqual([])
  })

  it('expands ~/ paths via homeDir option', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'owlcoda-extract-home-')))
    try {
      const r = extractPathsFromUserMessage('看一下 ~/notes/draft.md 这个文件', {
        cwd: tmpCwd, ts: 0, originIteration: 0, homeDir: home,
      })
      expect(r.extractions).toHaveLength(1)
      expect(r.extractions[0].path).toBe(join(home, 'notes/draft.md'))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('extractPathsFromUserMessage — Stage C (verb-paired declared_target)', () => {
  const tmpCwd = realpathSync(tmpdir())

  it('classifies path right after Chinese implementation verb as declared_target', () => {
    const r = extractPathsFromUserMessage('改一下 /nonexistent-test-root/a.ts', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toHaveLength(1)
    expect(r.extractions[0].kind).toBe('user_declared_target')
    // verbContext is the matched implementation verb root
    expect(['改', '改一下']).toContain(r.extractions[0].verbContext)
  })

  it('classifies path right after English implementation verb as declared_target', () => {
    const r = extractPathsFromUserMessage('please fix /nonexistent-test-root/a.ts now', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toHaveLength(1)
    expect(r.extractions[0].kind).toBe('user_declared_target')
    expect(r.extractions[0].verbContext?.toLowerCase()).toBe('fix')
  })

  it('classifies multiple paths spanned by single verb when both fall within window', () => {
    const r = extractPathsFromUserMessage('修 /tmp/a.ts 跟 /tmp/b.ts', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toHaveLength(2)
    for (const e of r.extractions) {
      expect(e.kind).toBe('user_declared_target')
    }
  })

  it('falls back to user_reference when verb is beyond 30-char window', () => {
    // ~70 chars between `修` and the path
    const r = extractPathsFromUserMessage(
      '修 the codebase someday in the future when we have more time properly /tmp/a.ts',
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    expect(r.extractions).toHaveLength(1)
    expect(r.extractions[0].kind).toBe('user_reference')
    expect(r.extractions[0].verbContext).toBeUndefined()
  })

  it('uses the closest (rightmost) verb if multiple appear in window', () => {
    const r = extractPathsFromUserMessage('write a plan then fix /a.ts', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toHaveLength(1)
    expect(r.extractions[0].kind).toBe('user_declared_target')
    expect(r.extractions[0].verbContext?.toLowerCase()).toBe('fix')
  })

  it('observation verbs (eg. 看) do not authorize as declared_target', () => {
    const r = extractPathsFromUserMessage('看一下 /tmp/utils.ts 这个文件', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toHaveLength(1)
    // 看 is not an implementation verb — stays as user_reference
    expect(r.extractions[0].kind).toBe('user_reference')
  })

  it('English implementation verbs require word boundary (not part of larger word)', () => {
    // `writeable` should NOT trigger `write` verb detection
    const r = extractPathsFromUserMessage('the writeable area /tmp/a.ts has issues', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toHaveLength(1)
    expect(r.extractions[0].kind).toBe('user_reference')
  })
})

describe('extractPathsFromUserMessage — Stage A (user_explicit_deny + scope)', () => {
  const tmpCwd = realpathSync(tmpdir())

  it('classifies Chinese prohibition pattern as user_explicit_deny', () => {
    const r = extractPathsFromUserMessage('不要改 /nonexistent-deny-root/foo.ts', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toHaveLength(1)
    expect(r.extractions[0].kind).toBe('user_explicit_deny')
    expect(r.extractions[0].denyMarker).toBeTruthy()
    expect(r.extractions[0].denyMarker?.includes('不要')).toBe(true)
  })

  it('classifies bare 不要 (no verb suffix) as user_explicit_deny', () => {
    const r = extractPathsFromUserMessage('不要 /nonexistent-deny-root/foo.ts', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toHaveLength(1)
    expect(r.extractions[0].kind).toBe('user_explicit_deny')
  })

  it('classifies 别动 X as user_explicit_deny', () => {
    const r = extractPathsFromUserMessage('别动 /nonexistent-deny-root/data.bin', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toHaveLength(1)
    expect(r.extractions[0].kind).toBe('user_explicit_deny')
  })

  it('classifies English do not / don\'t prohibition as user_explicit_deny', () => {
    const r = extractPathsFromUserMessage("don't modify /nonexistent-deny-root/lock.json", {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toHaveLength(1)
    expect(r.extractions[0].kind).toBe('user_explicit_deny')
  })

  it('Stage A wins over Stage C when both deny and verb apply to same path', () => {
    // `不要改` contains the verb `改` — Stage A must run first so we get deny, not declared
    const r = extractPathsFromUserMessage('不要改 /nonexistent-deny-root/critical.ts', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions[0].kind).toBe('user_explicit_deny')
  })

  it('F34: deny on existing directory → denyScope=subtree', () => {
    const realDir = realpathSync(mkdtempSync(join(tmpdir(), 'owlcoda-deny-dir-')))
    try {
      const r = extractPathsFromUserMessage(`不要改 ${realDir}`, {
        cwd: tmpCwd, ts: 0, originIteration: 0,
      })
      expect(r.extractions).toHaveLength(1)
      expect(r.extractions[0].kind).toBe('user_explicit_deny')
      expect(r.extractions[0].denyScope).toBe('subtree')
    } finally {
      rmSync(realDir, { recursive: true, force: true })
    }
  })

  it('classifies bare existing directory names in explicit deny context', () => {
    const realDir = realpathSync(mkdtempSync(join(tmpdir(), 'owlcoda-deny-bare-')))
    const child = join(realDir, 'existingDir')
    mkdirSync(child)
    try {
      const r = extractPathsFromUserMessage('不要改 existingDir', {
        cwd: realDir, ts: 0, originIteration: 0,
      })
      expect(r.extractions).toHaveLength(1)
      expect(r.extractions[0]).toEqual(expect.objectContaining({
        path: child,
        kind: 'user_explicit_deny',
        denyScope: 'subtree',
      }))
    } finally {
      rmSync(realDir, { recursive: true, force: true })
    }
  })

  it('does not classify non-existent bare words in explicit deny context', () => {
    const r = extractPathsFromUserMessage('不要改 imaginaryThing', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toEqual([])
  })

  it('F35: deny on non-existent path → denyScope=exact', () => {
    const r = extractPathsFromUserMessage(
      '不要改 /nonexistent-deny-root/never-was-there.txt',
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    expect(r.extractions[0].kind).toBe('user_explicit_deny')
    expect(r.extractions[0].denyScope).toBe('exact')
  })

  it('deny on existing file → denyScope=exact (not subtree)', () => {
    const realDir = realpathSync(mkdtempSync(join(tmpdir(), 'owlcoda-deny-file-')))
    const file = join(realDir, 'real.txt')
    writeFileSync(file, 'hi')
    try {
      const r = extractPathsFromUserMessage(`不要改 ${file}`, {
        cwd: tmpCwd, ts: 0, originIteration: 0,
      })
      expect(r.extractions[0].kind).toBe('user_explicit_deny')
      expect(r.extractions[0].denyScope).toBe('exact')
    } finally {
      rmSync(realDir, { recursive: true, force: true })
    }
  })

  it('falls back to user_reference when deny marker is beyond 30-char window', () => {
    const r = extractPathsFromUserMessage(
      '不要 use the new approach we said earlier for testing now /nonexistent-deny-root/x.ts',
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    expect(r.extractions[0].kind).toBe('user_reference')
  })

  it('multiple paths in deny phrase: all classified as deny', () => {
    // `不要改` spans both paths within window
    const r = extractPathsFromUserMessage('不要改 /tmp/a.ts /tmp/b.ts', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toHaveLength(2)
    for (const ex of r.extractions) {
      expect(ex.kind).toBe('user_explicit_deny')
    }
  })
})

describe('extractPathsFromUserMessage — Stage B (user_explicit_revoke + dual record)', () => {
  const tmpCwd = realpathSync(tmpdir())

  it('Stage B: marker + verb + path → DUAL record (revoke + declared_target)', () => {
    const r = extractPathsFromUserMessage('算了 改吧 /tmp/foo', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toHaveLength(2)
    const kinds = r.extractions.map(e => e.kind).sort()
    expect(kinds).toEqual(['user_declared_target', 'user_explicit_revoke'])
    // Both records on same canonical path
    expect(new Set(r.extractions.map(e => e.path)).size).toBe(1)
  })

  it('revoke record carries revokeMarker and verbContext', () => {
    const r = extractPathsFromUserMessage('算了 改吧 /tmp/foo', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    const revokeRec = r.extractions.find(e => e.kind === 'user_explicit_revoke')
    expect(revokeRec).toBeDefined()
    expect(revokeRec?.revokeMarker?.includes('算了')).toBe(true)
    expect(revokeRec?.verbContext).toBeTruthy()
  })

  it('declared_target side of dual emit carries verbContext (no revokeMarker)', () => {
    const r = extractPathsFromUserMessage('算了 改吧 /tmp/foo', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    const declared = r.extractions.find(e => e.kind === 'user_declared_target')
    expect(declared).toBeDefined()
    expect(declared?.verbContext).toBeTruthy()
    expect(declared?.revokeMarker).toBeUndefined()
  })

  it('English revoke: "actually edit X" → dual emit', () => {
    const r = extractPathsFromUserMessage('actually edit /tmp/foo now', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toHaveLength(2)
    const kinds = r.extractions.map(e => e.kind).sort()
    expect(kinds).toEqual(['user_declared_target', 'user_explicit_revoke'])
  })

  it('marker-verb compound without space (`算了改吧 X`) triggers Stage B', () => {
    // `算了` is a marker; `改` (inside `改吧`) is the verb. Both present → dual emit.
    const r = extractPathsFromUserMessage('算了改吧 /tmp/foo', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toHaveLength(2)
  })

  it('bare `改吧 X` (verb-only, no revoke marker) is Stage C only (no revoke)', () => {
    // Per spec §16.3, `改吧` is a verb-imperative not a revoke marker.
    // Without `算了`/`撤回`/etc., bare `改吧 X` should not lift a prior deny.
    const r = extractPathsFromUserMessage('改吧 /tmp/foo', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toHaveLength(1)
    expect(r.extractions[0].kind).toBe('user_declared_target')
  })

  it('marker without nearby verb → NOT Stage B (falls through)', () => {
    // `算了` alone, no implementation verb in window
    const r = extractPathsFromUserMessage('算了 /tmp/foo', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toHaveLength(1)
    // Should fall to Stage D (user_reference); no `改` verb → no Stage B/C
    expect(r.extractions[0].kind).toBe('user_reference')
  })

  it('F31: vague `那个改一下` (no explicit path) → no extraction at all', () => {
    const r = extractPathsFromUserMessage('那个改一下', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    // No path-like token in message → trivially no revoke produced
    expect(r.extractions).toEqual([])
  })

  it('Stage A (deny) still wins over Stage B when both could apply', () => {
    // `不要改 X` — should be deny, not revoke. Order: A → B → C → D
    const r = extractPathsFromUserMessage('不要改 /tmp/foo', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toHaveLength(1)
    expect(r.extractions[0].kind).toBe('user_explicit_deny')
  })
})

describe('extractPathsFromUserMessage — glob deny skip (S0-3.5)', () => {
  const tmpCwd = realpathSync(tmpdir())

  it('F33: 不要改 src/*.ts produces skippedGlobDenies, no deny record', () => {
    const r = extractPathsFromUserMessage('不要改 src/*.ts now please', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    // No deny extraction (literal-path scope only)
    expect(r.extractions.filter(e => e.kind === 'user_explicit_deny')).toHaveLength(0)
    expect(r.skippedGlobDenies).toHaveLength(1)
    expect(r.skippedGlobDenies[0].pattern).toContain('*')
    expect(r.skippedGlobDenies[0].pattern).toContain('src/')
  })

  it('English glob deny: don\'t modify src/**/*.ts → skipped', () => {
    const r = extractPathsFromUserMessage("don't modify src/**/*.ts ever", {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.skippedGlobDenies).toHaveLength(1)
    expect(r.skippedGlobDenies[0].pattern).toContain('*')
  })

  it('glob after literal prefix: 不要改 /tmp/foo/*.ts → prefix NOT emitted as deny', () => {
    // Path regex would otherwise capture `/tmp/foo` as a prefix. Glob detection
    // should suppress this so we do not emit a literal deny on /tmp/foo.
    const r = extractPathsFromUserMessage('不要改 /tmp/foo/*.ts', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toEqual([])
    expect(r.skippedGlobDenies).toHaveLength(1)
  })

  it('glob WITHOUT deny context: no skipped marker emitted, extractions also skip', () => {
    // Plain mention of a glob pattern (no deny phrase) — neither produces
    // a deny record (correct) nor surfaces in skippedGlobDenies (no deny
    // context to report).
    const r = extractPathsFromUserMessage('看一下 src/*.ts 这些文件', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.skippedGlobDenies).toEqual([])
    // No literal-path emission either — `src/*.ts` is not a literal path
    expect(r.extractions.filter(e => e.kind === 'user_explicit_deny')).toHaveLength(0)
  })

  it('literal deny next to a separate glob-shaped token gets both: deny + skip', () => {
    // `不要改 /tmp/literal.ts` is a normal literal deny.
    // No separate glob phrase → skippedGlobDenies stays empty.
    const r = extractPathsFromUserMessage('不要改 /tmp/literal.ts', {
      cwd: tmpCwd, ts: 0, originIteration: 0,
    })
    expect(r.extractions).toHaveLength(1)
    expect(r.extractions[0].kind).toBe('user_explicit_deny')
    expect(r.skippedGlobDenies).toEqual([])
  })
})

describe('extractPathsFromToolResult — signature + isError handling (S0-4.1)', () => {
  const tmpCwd = realpathSync(tmpdir())

  it('returns [] when isError=true (no admission from failed locators)', () => {
    // F24: failed Read on hallucinated path returns empty — Article failure case.
    const r = extractPathsFromToolResult(
      'Read',
      { file_path: '/Users/X/missing.md' },
      'ENOENT: no such file or directory',
      true,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    expect(r).toEqual([])
  })

  it('returns [] when isError=true regardless of tool kind', () => {
    // Glob/Grep/Bash on failure all admit nothing.
    expect(
      extractPathsFromToolResult('Glob', { pattern: '**/foo' }, '', true, {
        cwd: tmpCwd, ts: 0, originIteration: 0,
      }),
    ).toEqual([])
    expect(
      extractPathsFromToolResult('Bash', { command: 'ls /nope' }, 'err', true, {
        cwd: tmpCwd, ts: 0, originIteration: 0,
      }),
    ).toEqual([])
  })

  it('returns [] for unknown tool name on success', () => {
    // Defensive: gate only extracts from the tools the spec calls out.
    const r = extractPathsFromToolResult(
      'SomeCustomTool',
      { file_path: '/abs/a.ts' },
      'content',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    expect(r).toEqual([])
  })
})

describe('extractPathsFromToolResult — Read tool (S0-4.2)', () => {
  const tmpCwd = realpathSync(tmpdir())

  it('admits input file_path as tool_confirmed_existing on Read success', () => {
    const r = extractPathsFromToolResult(
      'Read',
      { file_path: '/abs/a.ts' },
      'file contents here',
      false,
      { cwd: tmpCwd, ts: 1000, originIteration: 1 },
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('tool_confirmed_existing')
    expect(r[0].path).toBe('/abs/a.ts')
    expect(r[0].toolName).toBe('Read')
    expect(r[0].toolSucceeded).toBe(true)
  })

  it('admits native Read input path as tool_confirmed_existing', () => {
    const r = extractPathsFromToolResult(
      'Read',
      { path: '/abs/native-read.ts' },
      'file contents here',
      false,
      { cwd: tmpCwd, ts: 1000, originIteration: 1 },
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('tool_confirmed_existing')
    expect(r[0].path).toBe('/abs/native-read.ts')
  })

  it('canonicalizes relative file_path against cwd', () => {
    const r = extractPathsFromToolResult(
      'Read',
      { file_path: 'src/foo.ts' },
      'content',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    expect(r).toHaveLength(1)
    expect(r[0].path).toBe(join(tmpCwd, 'src/foo.ts'))
  })

  it('F25: Read does NOT admit parent directory', () => {
    // Critical invariant. Read on /abs/sibling.ts proves the file exists, but
    // does not authorize creating new files in /abs/.
    const r = extractPathsFromToolResult(
      'Read',
      { file_path: '/abs/sibling.ts' },
      'content',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    // Only one extraction — the file path, kind=tool_confirmed_existing.
    // No parent_listing emitted.
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('tool_confirmed_existing')
    expect(r[0].path).toBe('/abs/sibling.ts')
  })

  it('returns [] when Read input lacks file_path field', () => {
    // Defensive: malformed input should not crash the extractor.
    const r = extractPathsFromToolResult(
      'Read',
      {},
      'content',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    expect(r).toEqual([])
  })

  it('returns [] when Read input file_path is not a string', () => {
    const r = extractPathsFromToolResult(
      'Read',
      { file_path: 42 },
      'content',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    expect(r).toEqual([])
  })

  it('lowercases tool name comparison (handles read/Read variants)', () => {
    const r = extractPathsFromToolResult(
      'read',
      { file_path: '/abs/a.ts' },
      'content',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    expect(r).toHaveLength(1)
    // toolName preserves the input casing on the record for telemetry
    expect(r[0].toolName).toBe('read')
  })
})

describe('extractPathsFromToolResult — Glob tool (S0-4.3)', () => {
  const tmpCwd = realpathSync(tmpdir())

  it('admits each matched line as tool_confirmed_existing', () => {
    const r = extractPathsFromToolResult(
      'Glob',
      { pattern: 'src/native/*.ts' },
      '/abs/src/native/a.ts\n/abs/src/native/b.ts\n',
      false,
      { cwd: tmpCwd, ts: 1000, originIteration: 1 },
    )
    const confirmed = r.filter(e => e.kind === 'tool_confirmed_existing')
    expect(confirmed).toHaveLength(2)
    expect(confirmed.map(e => e.path).sort()).toEqual([
      '/abs/src/native/a.ts',
      '/abs/src/native/b.ts',
    ])
    for (const e of confirmed) {
      expect(e.toolName).toBe('Glob')
      expect(e.toolSucceeded).toBe(true)
    }
  })

  it('admits longest static parent prefix as parent_listing', () => {
    const r = extractPathsFromToolResult(
      'Glob',
      { pattern: 'src/native/*.ts' },
      '/abs/src/native/a.ts\n',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    const parents = r.filter(e => e.kind === 'parent_listing')
    expect(parents).toHaveLength(1)
    // 'src/native' is the longest static prefix — canonicalized against cwd
    expect(parents[0].path).toBe(join(tmpCwd, 'src/native'))
  })

  it('full-tree pattern (**/foo) admits no parent_listing', () => {
    // First token is `**` — static prefix is empty → no parent admit.
    const r = extractPathsFromToolResult(
      'Glob',
      { pattern: '**/foo' },
      '/abs/x/foo\n/abs/y/foo\n',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    expect(r.filter(e => e.kind === 'parent_listing')).toEqual([])
    // But matches still admit as tool_confirmed_existing
    expect(r.filter(e => e.kind === 'tool_confirmed_existing')).toHaveLength(2)
  })

  it('mixed pattern (src/**/*.ts) admits static prefix `src` as parent', () => {
    const r = extractPathsFromToolResult(
      'Glob',
      { pattern: 'src/**/*.ts' },
      '/abs/src/foo.ts\n/abs/src/sub/bar.ts\n',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    const parents = r.filter(e => e.kind === 'parent_listing')
    expect(parents).toHaveLength(1)
    expect(parents[0].path).toBe(join(tmpCwd, 'src'))
  })

  it('absolute glob pattern admits absolute static prefix', () => {
    const r = extractPathsFromToolResult(
      'Glob',
      { pattern: '/abs/dir/*.ts' },
      '/abs/dir/x.ts\n',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    const parents = r.filter(e => e.kind === 'parent_listing')
    expect(parents).toHaveLength(1)
    expect(parents[0].path).toBe('/abs/dir')
  })

  it('empty Glob result (no matches) still admits static parent_listing', () => {
    // Pattern had a static parent and Glob succeeded (returned []),
    // so the dir was "listed" even if empty. parent_listing should emit.
    const r = extractPathsFromToolResult(
      'Glob',
      { pattern: 'src/*.ts' },
      '',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    const parents = r.filter(e => e.kind === 'parent_listing')
    expect(parents).toHaveLength(1)
    expect(parents[0].path).toBe(join(tmpCwd, 'src'))
  })

  it('ignores blank result lines and non-path noise', () => {
    const r = extractPathsFromToolResult(
      'Glob',
      { pattern: 'src/*.ts' },
      '/abs/src/a.ts\n\n   \n',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    expect(r.filter(e => e.kind === 'tool_confirmed_existing')).toHaveLength(1)
  })

  it('returns [] when Glob input has no pattern field', () => {
    const r = extractPathsFromToolResult(
      'Glob',
      {},
      '/abs/x\n',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    expect(r).toEqual([])
  })

  it('returns [] when Glob pattern is not a string', () => {
    const r = extractPathsFromToolResult(
      'Glob',
      { pattern: 42 },
      '',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    expect(r).toEqual([])
  })
})

describe('extractPathsFromToolResult — Grep tool (S0-4.4)', () => {
  const tmpCwd = realpathSync(tmpdir())

  it('admits each matched file path as tool_confirmed_existing (paths-only mode)', () => {
    const r = extractPathsFromToolResult(
      'Grep',
      { pattern: 'TODO' },
      '/abs/src/a.ts\n/abs/src/b.ts\n',
      false,
      { cwd: tmpCwd, ts: 1000, originIteration: 1 },
    )
    expect(r).toHaveLength(2)
    for (const e of r) {
      expect(e.kind).toBe('tool_confirmed_existing')
      expect(e.toolName).toBe('Grep')
    }
    expect(r.map(e => e.path).sort()).toEqual([
      '/abs/src/a.ts',
      '/abs/src/b.ts',
    ])
  })

  it('admits matched file from "path:line:content" formatted results (one per file, deduped)', () => {
    // Grep -n style. Multiple lines from same file should produce ONE
    // tool_confirmed_existing record per distinct path.
    const r = extractPathsFromToolResult(
      'Grep',
      { pattern: 'TODO' },
      '/abs/src/a.ts:12:// TODO: refactor\n/abs/src/a.ts:42:// TODO: doc\n/abs/src/b.ts:7:// TODO\n',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    expect(r.map(e => e.path).sort()).toEqual([
      '/abs/src/a.ts',
      '/abs/src/b.ts',
    ])
  })

  it('does NOT admit parent directory (only file paths)', () => {
    // Critical: Grep is a content search, not a directory listing.
    const r = extractPathsFromToolResult(
      'Grep',
      { pattern: 'foo', path: '/abs/src' },
      '/abs/src/a.ts\n',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    expect(r.filter(e => e.kind === 'parent_listing')).toEqual([])
  })

  it('returns [] for empty Grep result (no matches)', () => {
    const r = extractPathsFromToolResult(
      'Grep',
      { pattern: 'foo' },
      '',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    expect(r).toEqual([])
  })

  it('returns [] when Grep input has no pattern field', () => {
    const r = extractPathsFromToolResult(
      'Grep',
      {},
      '/abs/x\n',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    expect(r).toEqual([])
  })

  it('skips non-path lines (header / summary text)', () => {
    const r = extractPathsFromToolResult(
      'Grep',
      { pattern: 'foo' },
      'Found 2 matches:\n/abs/src/a.ts\n/abs/src/b.ts\nDone.\n',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    expect(r.map(e => e.path).sort()).toEqual([
      '/abs/src/a.ts',
      '/abs/src/b.ts',
    ])
  })
})

describe('extractPathsFromToolResult — Bash discovery: ls/find/tree (S0-4.5)', () => {
  const tmpCwd = realpathSync(tmpdir())

  it('F4: bash `ls /abs/dist/` admits dir as parent_listing AND each basename as tool_confirmed_existing', () => {
    const r = extractPathsFromToolResult(
      'Bash',
      { command: 'ls /abs/dist/' },
      'index.html\nstyle.css\nscript.js\n',
      false,
      { cwd: tmpCwd, ts: 1000, originIteration: 1 },
    )
    const parents = r.filter(e => e.kind === 'parent_listing')
    const confirmed = r.filter(e => e.kind === 'tool_confirmed_existing')
    expect(parents).toHaveLength(1)
    expect(parents[0].path).toBe('/abs/dist')
    expect(confirmed.map(e => e.path).sort()).toEqual([
      '/abs/dist/index.html',
      '/abs/dist/script.js',
      '/abs/dist/style.css',
    ])
  })

  it('bash `ls` (no args) admits cwd as parent_listing', () => {
    const r = extractPathsFromToolResult(
      'Bash',
      { command: 'ls' },
      'a.ts\nb.ts\n',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    const parents = r.filter(e => e.kind === 'parent_listing')
    expect(parents).toHaveLength(1)
    expect(parents[0].path).toBe(tmpCwd)
  })

  it('bash `ls -la /abs/dir/` skips `total N` line and `.`/`..` entries', () => {
    const r = extractPathsFromToolResult(
      'Bash',
      { command: 'ls -la /abs/dir/' },
      'total 8\ndrwxr-xr-x  4 user  group  128 May 26 12:00 .\ndrwxr-xr-x  3 user  group  128 May 26 12:00 ..\n-rw-r--r--  1 user  group  100 May 26 12:00 foo.ts\n',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    // Parent dir admitted; only real entries (foo.ts) confirmed; total/./.. skipped.
    const confirmed = r.filter(e => e.kind === 'tool_confirmed_existing')
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0].path).toBe('/abs/dir/foo.ts')
  })

  it('bash `find /abs/dir -name "*.ts"` admits dir as parent + each full path', () => {
    const r = extractPathsFromToolResult(
      'Bash',
      { command: 'find /abs/dir -name "*.ts"' },
      '/abs/dir/a.ts\n/abs/dir/sub/b.ts\n',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    const parents = r.filter(e => e.kind === 'parent_listing')
    const confirmed = r.filter(e => e.kind === 'tool_confirmed_existing')
    expect(parents).toHaveLength(1)
    expect(parents[0].path).toBe('/abs/dir')
    expect(confirmed.map(e => e.path).sort()).toEqual([
      '/abs/dir/a.ts',
      '/abs/dir/sub/b.ts',
    ])
  })

  it('bash `tree /abs/proj` admits dir as parent_listing only (no per-entry parsing for v1)', () => {
    // Tree formatted output is hard to parse; v1 just admits the queried dir.
    const r = extractPathsFromToolResult(
      'Bash',
      { command: 'tree /abs/proj' },
      '/abs/proj\n├── a.ts\n└── b.ts\n',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    const parents = r.filter(e => e.kind === 'parent_listing')
    expect(parents).toHaveLength(1)
    expect(parents[0].path).toBe('/abs/proj')
  })

  it('bash command unrelated to discovery returns []', () => {
    // No write target extraction here — that's S0-5. Discovery returns nothing.
    const r = extractPathsFromToolResult(
      'Bash',
      { command: 'echo hello' },
      'hello\n',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    expect(r).toEqual([])
  })

  it('returns [] when Bash input has no command field', () => {
    const r = extractPathsFromToolResult(
      'Bash',
      {},
      '',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    expect(r).toEqual([])
  })

  it('F14: ls dist/ does NOT admit deeper subdirectory dist/subdir as parent_listing', () => {
    // Recursive admission would weaken the explicit-evidence principle (§7.4).
    const r = extractPathsFromToolResult(
      'Bash',
      { command: 'ls /abs/dist/' },
      'subdir\nindex.html\n',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    // /abs/dist/subdir appears as a tool_confirmed_existing (it's an entry,
    // file or dir), but it is NOT promoted to parent_listing — model must
    // explicitly `ls /abs/dist/subdir/` to gain that.
    const parents = r.filter(e => e.kind === 'parent_listing')
    expect(parents).toHaveLength(1)
    expect(parents[0].path).toBe('/abs/dist')
    // subdir is not a parent_listing
    const subdirParent = parents.find(e => e.path === '/abs/dist/subdir')
    expect(subdirParent).toBeUndefined()
  })
})

describe('extractPathsFromToolResult — Bash mkdir / mkdir -p (S0-4.6)', () => {
  const tmpCwd = realpathSync(tmpdir())

  it('bash `mkdir /abs/newdir` admits the created dir as parent_listing', () => {
    const r = extractPathsFromToolResult(
      'Bash',
      { command: 'mkdir /abs/newdir' },
      '',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('parent_listing')
    expect(r[0].path).toBe('/abs/newdir')
  })

  it('bash `mkdir a b c` (multi-target) admits each dir as parent_listing', () => {
    const r = extractPathsFromToolResult(
      'Bash',
      { command: 'mkdir /abs/a /abs/b /abs/c' },
      '',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    expect(r).toHaveLength(3)
    for (const e of r) {
      expect(e.kind).toBe('parent_listing')
    }
    expect(r.map(e => e.path).sort()).toEqual([
      '/abs/a',
      '/abs/b',
      '/abs/c',
    ])
  })

  it('bash `mkdir -p /abs/a/b/c` admits each ancestor + final dir as parent_listing', () => {
    const r = extractPathsFromToolResult(
      'Bash',
      { command: 'mkdir -p /abs/a/b/c' },
      '',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    // /abs, /abs/a, /abs/a/b, /abs/a/b/c all become parent_listing
    const paths = r.map(e => e.path).sort()
    expect(paths).toEqual([
      '/abs',
      '/abs/a',
      '/abs/a/b',
      '/abs/a/b/c',
    ])
    for (const e of r) {
      expect(e.kind).toBe('parent_listing')
    }
  })

  it('bash `mkdir -p a/b/c` (relative) admits each ancestor canonicalized against cwd', () => {
    const r = extractPathsFromToolResult(
      'Bash',
      { command: 'mkdir -p a/b/c' },
      '',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    const paths = r.map(e => e.path).sort()
    expect(paths).toEqual([
      join(tmpCwd, 'a'),
      join(tmpCwd, 'a/b'),
      join(tmpCwd, 'a/b/c'),
    ])
  })

  it('bash `mkdir -p` with multiple targets expands each chain independently', () => {
    const r = extractPathsFromToolResult(
      'Bash',
      { command: 'mkdir -p /abs/x/y /abs/m/n' },
      '',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    const paths = r.map(e => e.path).sort()
    // Each chain: /abs, /abs/x, /abs/x/y, /abs/m, /abs/m/n
    expect(paths).toEqual([
      '/abs',
      '/abs',  // each chain admits its own /abs ancestor
      '/abs/m',
      '/abs/m/n',
      '/abs/x',
      '/abs/x/y',
    ])
  })

  it('bash `mkdir` with no args returns []', () => {
    const r = extractPathsFromToolResult(
      'Bash',
      { command: 'mkdir' },
      '',
      false,
      { cwd: tmpCwd, ts: 0, originIteration: 0 },
    )
    expect(r).toEqual([])
  })
})

describe('S0-4 end-to-end fixtures — extractor + admit + evaluateAdmission', () => {
  // Verifies the full pipe: tool result → extractor → ledger.admit → admission.
  // These fixtures match spec §8.2 F-IDs that S0-4 is responsible for.

  const tmpCwd = realpathSync(tmpdir())

  function feedToolResult(
    data: ReturnType<typeof createEmptyProvenanceLedgerData>,
    toolName: string,
    input: Record<string, unknown>,
    result: string,
    isError: boolean,
    iter: number,
  ): void {
    const extracted = extractPathsFromToolResult(toolName, input, result, isError, {
      cwd: tmpCwd, ts: 1000 + iter, originIteration: iter,
    })
    for (const e of extracted) {
      admit(data, e.path, {
        kind: e.kind,
        ts: 1000 + iter,
        originIteration: iter,
        originalString: e.originalString,
        toolName: e.toolName,
        toolSucceeded: e.toolSucceeded,
      })
    }
  }

  it('F3: Glob returns src/foo.ts → Edit src/foo.ts admits via tool_confirmed_existing', () => {
    const data = createEmptyProvenanceLedgerData()
    feedToolResult(
      data,
      'Glob',
      { pattern: 'src/**/foo*' },
      '/abs/src/foo.ts\n',
      false,
      1,
    )
    const r = evaluateAdmission(data, '/abs/src/foo.ts', false)
    expect(r.admitted).toBe(true)
    expect(r.via).toBe('tool_confirmed_existing')
  })

  it('F4: ls /abs/dist/ → Write /abs/dist/output.html (new file) admits via parent_listing', () => {
    const data = createEmptyProvenanceLedgerData()
    feedToolResult(
      data,
      'Bash',
      { command: 'ls /abs/dist/' },
      'index.html\nstyle.css\n',
      false,
      1,
    )
    const r = evaluateAdmission(data, '/abs/dist/output.html', true)
    expect(r.admitted).toBe(true)
    expect(r.via).toBe('parent_listing')
  })

  it('F13a: empty ledger, Edit /etc/hosts → block', () => {
    const data = createEmptyProvenanceLedgerData()
    // No tool calls executed
    const r = evaluateAdmission(data, '/etc/hosts', false)
    expect(r.admitted).toBe(false)
  })

  it('F13b: after Read /etc/hosts succeeds → Edit /etc/hosts admits', () => {
    const data = createEmptyProvenanceLedgerData()
    feedToolResult(
      data,
      'Read',
      { file_path: '/etc/hosts' },
      '127.0.0.1 localhost\n',
      false,
      1,
    )
    // The write-target lookup must use the same canonical form as the
    // extractor admitted. /etc/hosts realpaths to /private/etc/hosts on
    // macOS — the call site responsible for evaluateAdmission canonicalizes
    // the write target first, mirroring extractor side.
    const canonical = canonicalizeProvenancePath('/etc/hosts', tmpCwd)
    const r = evaluateAdmission(data, canonical, false)
    expect(r.admitted).toBe(true)
    expect(r.via).toBe('tool_confirmed_existing')
  })

  it('F14: only ls /abs/dist/ observed → Write /abs/dist/subdir/foo.html blocks', () => {
    const data = createEmptyProvenanceLedgerData()
    feedToolResult(
      data,
      'Bash',
      { command: 'ls /abs/dist/' },
      'subdir\nindex.html\n',
      false,
      1,
    )
    // /abs/dist/subdir is a tool_confirmed_existing (it's an entry)
    // but its OWN parent_listing was never emitted, so new-file admission
    // for /abs/dist/subdir/foo.html fails.
    const r = evaluateAdmission(data, '/abs/dist/subdir/foo.html', true)
    expect(r.admitted).toBe(false)
  })

  it('F24: failed Read on hallucinated path admits nothing — Write still blocks', () => {
    // Article failure case. Empty ledger, Read returns ENOENT (isError=true).
    const data = createEmptyProvenanceLedgerData()
    feedToolResult(
      data,
      'Read',
      { file_path: '/Users/X/missing.md' },
      'ENOENT: no such file or directory',
      true,   // <-- isError
      1,
    )
    expect(size(data)).toBe(0)   // nothing admitted
    const r = evaluateAdmission(data, '/Users/X/missing.md', true)
    expect(r.admitted).toBe(false)
  })

  it('F25: Read sibling does not authorize creating new file in same dir', () => {
    const data = createEmptyProvenanceLedgerData()
    feedToolResult(
      data,
      'Read',
      { file_path: '/abs/src/native/foo.ts' },
      'content',
      false,
      1,
    )
    // sibling admitted; new file in same dir has no parent_listing → block
    const r = evaluateAdmission(data, '/abs/src/native/bar.ts', true)
    expect(r.admitted).toBe(false)
  })
})

describe('extractWriteTargets — Write / Edit / NotebookEdit (S0-5.1)', () => {
  const tmpCwd = realpathSync(tmpdir())

  it('Write tool: input file_path becomes a single non-destructive `write` target', () => {
    const r = extractWriteTargets('Write', { file_path: '/abs/a.ts' }, tmpCwd)
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('write')
    expect(r[0].path).toBe('/abs/a.ts')
    expect(r[0].destructive).toBe(false)
  })

  it('Write tool: native input path becomes a single non-destructive `write` target', () => {
    const r = extractWriteTargets('Write', { path: '/abs/native-write.ts' }, tmpCwd)
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('write')
    expect(r[0].path).toBe('/abs/native-write.ts')
    expect(r[0].destructive).toBe(false)
  })

  it('Edit tool: input file_path becomes a single `edit` target', () => {
    const r = extractWriteTargets('Edit', { file_path: '/abs/a.ts' }, tmpCwd)
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('edit')
    expect(r[0].path).toBe('/abs/a.ts')
    expect(r[0].destructive).toBe(false)
  })

  it('Edit tool: native input path becomes a single `edit` target', () => {
    const r = extractWriteTargets('Edit', { path: '/abs/native-edit.ts' }, tmpCwd)
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('edit')
    expect(r[0].path).toBe('/abs/native-edit.ts')
    expect(r[0].destructive).toBe(false)
  })

  it('NotebookEdit tool: input notebook_path becomes a `notebook_edit` target', () => {
    const r = extractWriteTargets('NotebookEdit', { notebook_path: '/abs/x.ipynb' }, tmpCwd)
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('notebook_edit')
    expect(r[0].path).toBe('/abs/x.ipynb')
  })

  it('canonicalizes relative file_path against cwd', () => {
    const r = extractWriteTargets('Write', { file_path: 'src/foo.ts' }, tmpCwd)
    expect(r).toHaveLength(1)
    expect(r[0].path).toBe(join(tmpCwd, 'src/foo.ts'))
  })

  it('returns [] when input file_path is missing', () => {
    expect(extractWriteTargets('Write', {}, tmpCwd)).toEqual([])
    expect(extractWriteTargets('Edit', {}, tmpCwd)).toEqual([])
    expect(extractWriteTargets('NotebookEdit', {}, tmpCwd)).toEqual([])
  })

  it('returns [] when file_path is not a string', () => {
    expect(extractWriteTargets('Write', { file_path: 42 }, tmpCwd)).toEqual([])
  })

  it('returns [] for an unknown tool name (non-write tool, non-bash)', () => {
    expect(extractWriteTargets('Read', { file_path: '/abs/a.ts' }, tmpCwd)).toEqual([])
    expect(extractWriteTargets('Glob', { pattern: 'src/*' }, tmpCwd)).toEqual([])
  })

  it('tool-name comparison is case-insensitive (write / WRITE / Write all dispatch)', () => {
    for (const name of ['Write', 'write', 'WRITE']) {
      const r = extractWriteTargets(name, { file_path: '/abs/a.ts' }, tmpCwd)
      expect(r).toHaveLength(1)
      expect(r[0].kind).toBe('write')
    }
  })
})

describe('extractWriteTargets — Bash redirect >, >>, 2> (S0-5.2)', () => {
  const tmpCwd = realpathSync(tmpdir())

  it('F5: `echo X > /tmp/foo.txt` extracts /tmp/foo.txt as redirect_stdout', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'echo X > /tmp/foo.txt' },
      tmpCwd,
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('redirect_stdout')
    expect(r[0].path).toBe(canonicalizeProvenancePath('/tmp/foo.txt', tmpCwd))
    expect(r[0].destructive).toBe(true)
  })

  it('append redirect `>>` extracts a redirect_stdout target', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'echo X >> /tmp/out.log' },
      tmpCwd,
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('redirect_stdout')
  })

  it('stderr redirect `2>` extracts a redirect_stderr target', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'cmd 2> /tmp/err.log' },
      tmpCwd,
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('redirect_stderr')
    expect(r[0].path).toBe(canonicalizeProvenancePath('/tmp/err.log', tmpCwd))
  })

  it('combined `cmd > a 2> b` extracts two targets (stdout + stderr)', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'cmd > /tmp/a 2> /tmp/b' },
      tmpCwd,
    )
    expect(r).toHaveLength(2)
    const kinds = r.map(e => e.kind).sort()
    expect(kinds).toEqual(['redirect_stderr', 'redirect_stdout'])
  })

  it('double redirect `cmd > a > b` extracts both stdout targets', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'cmd > /tmp/a > /tmp/b' },
      tmpCwd,
    )
    expect(r).toHaveLength(2)
    expect(r.every(e => e.kind === 'redirect_stdout')).toBe(true)
    expect(r.map(e => e.path).sort()).toEqual([
      canonicalizeProvenancePath('/tmp/a', tmpCwd),
      canonicalizeProvenancePath('/tmp/b', tmpCwd),
    ])
  })

  it('handles `>file` without space between operator and target', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'echo X >/tmp/foo.txt' },
      tmpCwd,
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('redirect_stdout')
    expect(r[0].path).toBe(canonicalizeProvenancePath('/tmp/foo.txt', tmpCwd))
  })

  it('canonicalizes relative redirect targets against cwd', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'echo X > out.log' },
      tmpCwd,
    )
    expect(r).toHaveLength(1)
    expect(r[0].path).toBe(join(tmpCwd, 'out.log'))
  })

  it('returns [] when command has no recognized write shape', () => {
    expect(extractWriteTargets('Bash', { command: 'echo hello' }, tmpCwd)).toEqual([])
  })

  it('returns [] when bash command is missing or empty', () => {
    expect(extractWriteTargets('Bash', {}, tmpCwd)).toEqual([])
    expect(extractWriteTargets('Bash', { command: '' }, tmpCwd)).toEqual([])
  })

  it('does NOT confuse `>` inside a quoted string with a redirect', () => {
    // Quoted `>` should not be parsed as a redirect operator.
    const r = extractWriteTargets(
      'Bash',
      { command: 'echo "a > b" hello' },
      tmpCwd,
    )
    expect(r).toEqual([])
  })

  it('F6 (extractor side): user-message-admit happens elsewhere, extractor still emits target', () => {
    // Regardless of ledger state, the extractor names the target.
    // Admission decision (pass vs block) is the gate's job, not the extractor's.
    const r = extractWriteTargets(
      'Bash',
      { command: 'echo X > /tmp/output.log' },
      tmpCwd,
    )
    expect(r).toHaveLength(1)
    expect(r[0].path).toBe(canonicalizeProvenancePath('/tmp/output.log', tmpCwd))
  })
})

describe('extractWriteTargets — Bash tee + sed -i (S0-5.3)', () => {
  const tmpCwd = realpathSync(tmpdir())

  it('`echo X | tee /tmp/a` extracts /tmp/a as kind=tee', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'echo X | tee /tmp/a' },
      tmpCwd,
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('tee')
    expect(r[0].path).toBe(canonicalizeProvenancePath('/tmp/a', tmpCwd))
    expect(r[0].destructive).toBe(false)
  })

  it('`tee a b c` (multi-target) emits one tee target per file', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'echo X | tee /tmp/a /tmp/b /tmp/c' },
      tmpCwd,
    )
    expect(r).toHaveLength(3)
    for (const e of r) {
      expect(e.kind).toBe('tee')
    }
    expect(r.map(e => e.path).sort()).toEqual([
      canonicalizeProvenancePath('/tmp/a', tmpCwd),
      canonicalizeProvenancePath('/tmp/b', tmpCwd),
      canonicalizeProvenancePath('/tmp/c', tmpCwd),
    ])
  })

  it('tee -a (append) is still kind=tee (not destructive)', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'echo X | tee -a /tmp/log' },
      tmpCwd,
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('tee')
    expect(r[0].destructive).toBe(false)
  })

  it('combined `tee a > b` emits tee a + redirect_stdout b', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'echo X | tee /tmp/a > /tmp/b' },
      tmpCwd,
    )
    expect(r).toHaveLength(2)
    const byKind = r.reduce<Record<string, string[]>>((acc, e) => {
      const list = acc[e.kind] ?? []
      list.push(e.path)
      acc[e.kind] = list
      return acc
    }, {})
    expect(byKind.tee).toEqual([canonicalizeProvenancePath('/tmp/a', tmpCwd)])
    expect(byKind.redirect_stdout).toEqual([canonicalizeProvenancePath('/tmp/b', tmpCwd)])
  })

  it('F17: `sed -i ... foo.txt` extracts foo.txt as sed_inplace (destructive=true)', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: "sed -i 's/a/b/' /tmp/foo.txt" },
      tmpCwd,
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('sed_inplace')
    expect(r[0].path).toBe(canonicalizeProvenancePath('/tmp/foo.txt', tmpCwd))
    expect(r[0].destructive).toBe(true)
  })

  it('sed -i with multiple files: each becomes sed_inplace target', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: "sed -i 's/a/b/' /tmp/a.txt /tmp/b.txt /tmp/c.txt" },
      tmpCwd,
    )
    expect(r).toHaveLength(3)
    for (const e of r) {
      expect(e.kind).toBe('sed_inplace')
      expect(e.destructive).toBe(true)
    }
  })

  it('sed -i.bak (suffix-form) still extracts target as sed_inplace', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: "sed -i.bak 's/a/b/' /tmp/foo.txt" },
      tmpCwd,
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('sed_inplace')
    expect(r[0].path).toBe(canonicalizeProvenancePath('/tmp/foo.txt', tmpCwd))
  })

  it("sed -i '' (BSD empty-suffix form) skips the empty arg and finds the file", () => {
    const r = extractWriteTargets(
      'Bash',
      { command: "sed -i '' 's/a/b/' /tmp/foo.txt" },
      tmpCwd,
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('sed_inplace')
    expect(r[0].path).toBe(canonicalizeProvenancePath('/tmp/foo.txt', tmpCwd))
  })

  it('sed without -i (writes to stdout) extracts nothing', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: "sed 's/a/b/' /tmp/foo.txt" },
      tmpCwd,
    )
    // sed without -i is non-destructive — no write target.
    expect(r).toEqual([])
  })

  it('tee without a target file returns empty (no write destination)', () => {
    // `echo X | tee` alone writes to stdout — no file target.
    const r = extractWriteTargets(
      'Bash',
      { command: 'echo X | tee' },
      tmpCwd,
    )
    expect(r).toEqual([])
  })
})

describe('extractWriteTargets — Bash cp / mv / rm (S0-5.4)', () => {
  const tmpCwd = realpathSync(tmpdir())

  it('F16: `cp /src /dst` extracts /dst as kind=cp', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'cp /tmp/src.txt /tmp/dst.txt' },
      tmpCwd,
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('cp')
    expect(r[0].path).toBe(canonicalizeProvenancePath('/tmp/dst.txt', tmpCwd))
  })

  it('cp src1 src2 dst/ extracts only dst (last positional)', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'cp /tmp/a.txt /tmp/b.txt /tmp/dest/' },
      tmpCwd,
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('cp')
    expect(r[0].path).toBe(canonicalizeProvenancePath('/tmp/dest', tmpCwd))
  })

  it('cp -r src dst/ ignores -r flag and extracts dst', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'cp -r /tmp/src/ /tmp/dst/' },
      tmpCwd,
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('cp')
    expect(r[0].path).toBe(canonicalizeProvenancePath('/tmp/dst', tmpCwd))
  })

  it('mv src dst extracts dst as kind=mv (destructive=true)', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'mv /tmp/old.txt /tmp/new.txt' },
      tmpCwd,
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('mv')
    expect(r[0].path).toBe(canonicalizeProvenancePath('/tmp/new.txt', tmpCwd))
    expect(r[0].destructive).toBe(true)
  })

  it('F18: `rm /tmp/foo` extracts /tmp/foo as kind=rm (destructive=true)', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'rm /tmp/foo' },
      tmpCwd,
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('rm')
    expect(r[0].path).toBe(canonicalizeProvenancePath('/tmp/foo', tmpCwd))
    expect(r[0].destructive).toBe(true)
  })

  it('rm with multiple targets extracts each as a separate rm record', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'rm /tmp/a /tmp/b /tmp/c' },
      tmpCwd,
    )
    expect(r).toHaveLength(3)
    for (const e of r) {
      expect(e.kind).toBe('rm')
      expect(e.destructive).toBe(true)
    }
    expect(r.map(e => e.path).sort()).toEqual([
      canonicalizeProvenancePath('/tmp/a', tmpCwd),
      canonicalizeProvenancePath('/tmp/b', tmpCwd),
      canonicalizeProvenancePath('/tmp/c', tmpCwd),
    ])
  })

  it('rm -rf dir/ ignores -rf flag and extracts the dir', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'rm -rf /tmp/junk/' },
      tmpCwd,
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('rm')
    expect(r[0].destructive).toBe(true)
    expect(r[0].path).toBe(canonicalizeProvenancePath('/tmp/junk', tmpCwd))
  })

  it('cp / mv / rm with no positionals returns []', () => {
    expect(extractWriteTargets('Bash', { command: 'cp' }, tmpCwd)).toEqual([])
    expect(extractWriteTargets('Bash', { command: 'cp -r' }, tmpCwd)).toEqual([])
    expect(extractWriteTargets('Bash', { command: 'mv' }, tmpCwd)).toEqual([])
    expect(extractWriteTargets('Bash', { command: 'rm' }, tmpCwd)).toEqual([])
  })

  it('cp src dst (single positional pair) — single positional alone treats as no dst', () => {
    // `cp src` alone is invalid (cp requires at least 2 args). If we see
    // only one positional, treat as a no-target case (fail-open).
    const r = extractWriteTargets(
      'Bash',
      { command: 'cp /tmp/src.txt' },
      tmpCwd,
    )
    expect(r).toEqual([])
  })
})

describe('extractWriteTargets — Bash heredoc + mkdir + fail-open (S0-5.5)', () => {
  const tmpCwd = realpathSync(tmpdir())

  it('F19: heredoc `cat <<EOF > /tmp/path` extracts /tmp/path as kind=heredoc', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'cat <<EOF > /tmp/path\nhello world\nEOF' },
      tmpCwd,
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('heredoc')
    expect(r[0].path).toBe(canonicalizeProvenancePath('/tmp/path', tmpCwd))
  })

  it('marks overwrite redirects destructive while append redirects remain non-destructive', () => {
    const overwrite = extractWriteTargets('Bash', { command: 'echo x >| /tmp/overwrite' }, tmpCwd)
    const append = extractWriteTargets('Bash', { command: 'echo x >> /tmp/append' }, tmpCwd)

    expect(overwrite).toHaveLength(1)
    expect(overwrite[0].destructive).toBe(true)
    expect(append).toHaveLength(1)
    expect(append[0].destructive).toBe(false)
  })

  it('ignores redirect-like text inside a heredoc body', () => {
    const result = extractWriteTargets(
      'Bash',
      { command: 'cat <<EOF > /tmp/output\nbody > /tmp/not-a-target | tee /tmp/also-not-a-target\nEOF' },
      tmpCwd,
    )

    expect(result).toHaveLength(1)
    expect(result[0].path).toBe(canonicalizeProvenancePath('/tmp/output', tmpCwd))
  })

  it('heredoc with `<<-` indented form is also detected as heredoc', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'cat <<-EOF > /tmp/out.txt\n\thello\nEOF' },
      tmpCwd,
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('heredoc')
  })

  it('mkdir /tmp/newdir extracts /tmp/newdir as kind=mkdir', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'mkdir /tmp/newdir' },
      tmpCwd,
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('mkdir')
    expect(r[0].path).toBe(canonicalizeProvenancePath('/tmp/newdir', tmpCwd))
    expect(r[0].destructive).toBe(false)
  })

  it('mkdir -p a/b/c extracts each intermediate as kind=mkdir', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'mkdir -p /tmp/a/b/c' },
      tmpCwd,
    )
    // Multi-level mkdir admits each created dir as a separate target.
    expect(r.length).toBeGreaterThanOrEqual(1)
    for (const e of r) {
      expect(e.kind).toBe('mkdir')
      expect(e.destructive).toBe(false)
    }
    // The deepest path must be included.
    expect(r.some(e => e.path === canonicalizeProvenancePath('/tmp/a/b/c', tmpCwd))).toBe(true)
  })

  it('mkdir multi-target: mkdir /a /b /c → three targets', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'mkdir /tmp/a /tmp/b /tmp/c' },
      tmpCwd,
    )
    expect(r).toHaveLength(3)
    for (const e of r) {
      expect(e.kind).toBe('mkdir')
    }
  })

  it('F10: `python -c "..."` extracts nothing → fail-open (gate passes)', () => {
    // python with -c that uses open().write() bypasses the bash extractor.
    // The fail-open contract: no targets extracted → gate passes.
    const r = extractWriteTargets(
      'Bash',
      { command: `python -c "open('/tmp/foo.txt','w').write('x')"` },
      tmpCwd,
    )
    expect(r).toEqual([])
  })

  it('unrecognized bash shape returns [] (fail-open)', () => {
    const r = extractWriteTargets(
      'Bash',
      { command: 'curl https://example.com/api' },
      tmpCwd,
    )
    expect(r).toEqual([])
  })

  it('multiple write patterns in one command yield multiple targets', () => {
    // cp + rm in a chained command — both targets extracted.
    const r = extractWriteTargets(
      'Bash',
      { command: 'cp /tmp/src.txt /tmp/dst.txt && rm /tmp/old.txt' },
      tmpCwd,
    )
    const kinds = r.map(e => e.kind).sort()
    expect(kinds).toEqual(['cp', 'rm'])
  })
})

describe('formatProvenanceError — spec §5.5 diagnostics (S2-2)', () => {
  function makeEval(
    path: string,
    isNewFile: boolean,
    admission: ProvenanceTargetEvaluation['admission'],
    kind: ProvenanceTargetEvaluation['target']['kind'] = 'write',
  ): ProvenanceTargetEvaluation {
    return {
      target: { path, kind, destructive: false },
      canonical: path,
      isNewFile,
      admission,
    }
  }

  it('returns empty string when there are no failures', () => {
    expect(formatProvenanceError([])).toBe('')
  })

  it('active deny: quotes deny iteration + original string + revoke-by-name guidance', () => {
    const denyRec = {
      kind: 'user_explicit_deny' as const,
      ts: 1000,
      originIteration: 3,
      originalString: '不要改 /tmp/cache.db',
      denyMarker: '不要改',
      denyScope: 'exact' as const,
    }
    const failure = makeEval('/tmp/cache.db', false, {
      admitted: false,
      denyActive: true,
      activeDenyRecord: denyRec,
      availableRecords: { path: [denyRec], parent: [] },
    })
    const msg = formatProvenanceError([failure])
    // Path identification
    expect(msg).toContain('/tmp/cache.db')
    // Quote the deny iteration
    expect(msg).toContain('3')
    // Quote the deny's original wording
    expect(msg).toContain('不要改 /tmp/cache.db')
    // Revoke-by-name guidance must name the path explicitly
    expect(msg.toLowerCase()).toMatch(/revoke|算了|改吧|actually/i)
    // Critical: deny precedence is hard — declared_target later does not override
    expect(msg.toLowerCase()).toMatch(/override|hard|stays/i)
  })

  it('existing file with no records: prompts a Read + ask-user fallback', () => {
    const failure = makeEval('/abs/src/missing.ts', false, {
      admitted: false,
      availableRecords: { path: [], parent: [] },
    })
    const msg = formatProvenanceError([failure])
    expect(msg).toContain('/abs/src/missing.ts')
    // Should suggest a Read / Glob to confirm
    expect(msg.toLowerCase()).toMatch(/read|glob/i)
    // Or ask user
    expect(msg.toLowerCase()).toMatch(/user|ask/i)
  })

  it('existing file with only user_reference: names the record kind and explains it does NOT authorize', () => {
    const referenceRec = {
      kind: 'user_reference' as const,
      ts: 1000,
      originIteration: 0,
      originalString: '看 log 提到 /abs/legacy.ts',
    }
    const failure = makeEval('/abs/legacy.ts', false, {
      admitted: false,
      availableRecords: { path: [referenceRec], parent: [] },
    })
    const msg = formatProvenanceError([failure])
    expect(msg).toContain('/abs/legacy.ts')
    expect(msg).toContain('user_reference')
    // Should explain reference does not authorize
    expect(msg.toLowerCase()).toMatch(/not.*authoriz|insufficient|not a write target|mentioned/i)
  })

  it('new file with no admission: prompts parent listing + names parent dir explicitly', () => {
    const failure = makeEval('/abs/dist/output.html', true, {
      admitted: false,
      availableRecords: { path: [], parent: [] },
    })
    const msg = formatProvenanceError([failure])
    expect(msg).toContain('/abs/dist/output.html')
    // Parent dir mentioned by name
    expect(msg).toContain('/abs/dist')
    // Should mention new file context
    expect(msg.toLowerCase()).toMatch(/new file|creating/i)
    // Should suggest ls / Glob / mkdir to admit the parent
    expect(msg.toLowerCase()).toMatch(/ls|glob|mkdir|parent_listing/i)
  })

  it('multi-target bash: aggregates per-target diagnostics with target count', () => {
    const f1 = makeEval('/tmp/a.txt', true, {
      admitted: false,
      availableRecords: { path: [], parent: [] },
    })
    const f2 = makeEval('/abs/legacy.ts', false, {
      admitted: false,
      availableRecords: {
        path: [{
          kind: 'user_reference',
          ts: 1000,
          originIteration: 0,
          originalString: '/abs/legacy.ts',
        }],
        parent: [],
      },
    })
    const msg = formatProvenanceError([f1, f2])
    // Both paths appear
    expect(msg).toContain('/tmp/a.txt')
    expect(msg).toContain('/abs/legacy.ts')
    // Header mentions multiple
    expect(msg.toLowerCase()).toMatch(/2 |multiple|targets/i)
  })

  it('deny + non-deny mixed: deny block renders FIRST (highest precedence)', () => {
    const denyRec = {
      kind: 'user_explicit_deny' as const,
      ts: 1000,
      originIteration: 2,
      originalString: '不要改 /etc/hosts',
      denyMarker: '不要改',
      denyScope: 'exact' as const,
    }
    const denyFailure = makeEval('/etc/hosts', false, {
      admitted: false,
      denyActive: true,
      activeDenyRecord: denyRec,
      availableRecords: { path: [denyRec], parent: [] },
    })
    const refFailure = makeEval('/abs/other.ts', false, {
      admitted: false,
      availableRecords: { path: [], parent: [] },
    })
    const msg = formatProvenanceError([refFailure, denyFailure])
    const denyIdx = msg.indexOf('/etc/hosts')
    const otherIdx = msg.indexOf('/abs/other.ts')
    expect(denyIdx).toBeGreaterThanOrEqual(0)
    expect(otherIdx).toBeGreaterThanOrEqual(0)
    // Deny mention must come before the non-deny failure
    expect(denyIdx).toBeLessThan(otherIdx)
  })
})
