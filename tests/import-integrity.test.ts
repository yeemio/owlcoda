import { describe, expect, it } from 'vitest'
import {
  checkTrackedImports,
  extractRelativeImports,
  findImportedUntracked,
  resolveImportCandidates,
} from '../src/native/import-integrity.js'

describe('extractRelativeImports', () => {
  it('captures static imports, side-effect imports, re-exports, and dynamic imports', () => {
    const source = [
      "import { a } from './a.js'",
      "import './b.js'",
      "export { c } from '../c/d.js'",
      "export * from './e.js'",
      "const m = await import('./f.js')",
    ].join('\n')
    expect(extractRelativeImports(source)).toEqual([
      './a.js', './b.js', '../c/d.js', './e.js', './f.js',
    ])
  })

  it('ignores bare specifiers (packages and node builtins)', () => {
    const source = [
      "import { x } from 'vitest'",
      "import { readFileSync } from 'node:fs'",
      "import foo from '@scope/pkg'",
    ].join('\n')
    expect(extractRelativeImports(source)).toEqual([])
  })

  it('supports single and double quotes', () => {
    expect(extractRelativeImports(`import x from "./dq.js"`)).toEqual(['./dq.js'])
  })

  it('ignores a relative "from" that appears inside a line or block comment', () => {
    expect(extractRelativeImports("// ported from './legacy.js'\nimport { x } from './real.js'")).toEqual(['./real.js'])
    expect(extractRelativeImports("/* uses ./old.js: from '../old.js' */\nimport './side.js'")).toEqual(['./side.js'])
  })
})

describe('resolveImportCandidates', () => {
  it('rewrites a sibling .js specifier to its .ts / .tsx source candidates', () => {
    const got = resolveImportCandidates('src/endpoints/messages.ts', './headers-timeout.js')
    expect(got).toContain('src/endpoints/headers-timeout.ts')
    expect(got).toContain('src/endpoints/headers-timeout.tsx')
  })

  it('resolves parent-relative specifiers to a normalized POSIX path', () => {
    expect(resolveImportCandidates('src/a/b.ts', '../c/d.js')).toContain('src/c/d.ts')
  })

  it('offers extensionless and directory-index candidates', () => {
    const got = resolveImportCandidates('src/a.ts', './x')
    expect(got).toContain('src/x.ts')
    expect(got).toContain('src/x/index.ts')
  })

  it('keeps a .json specifier as-is', () => {
    expect(resolveImportCandidates('src/a.ts', './data.json')).toContain('src/data.json')
  })
})

describe('checkTrackedImports', () => {
  it('reports a tracked file importing a module whose every candidate is untracked', () => {
    const files = [{ file: 'src/m.ts', source: "import './headers-timeout.js'" }]
    const tracked = new Set(['src/m.ts'])
    expect(checkTrackedImports(files, tracked)).toEqual([
      { file: 'src/m.ts', missingImport: 'src/headers-timeout.ts' },
    ])
  })

  it('passes when one of the resolution candidates is tracked', () => {
    const files = [{ file: 'src/m.ts', source: "import './helper.js'" }]
    const tracked = new Set(['src/m.ts', 'src/helper.tsx'])
    expect(checkTrackedImports(files, tracked)).toEqual([])
  })

  it('ignores bare-package imports entirely', () => {
    const files = [{ file: 'src/m.ts', source: "import { z } from 'vitest'" }]
    expect(checkTrackedImports(files, new Set(['src/m.ts']))).toEqual([])
  })
})

describe('findImportedUntracked', () => {
  it('is the membership kernel over a pre-resolved graph', () => {
    const graph = [{ file: 'src/a.ts', resolvedImports: ['src/b.ts', 'src/c.ts'] }]
    expect(findImportedUntracked(graph, new Set(['src/a.ts', 'src/b.ts']))).toEqual([
      { file: 'src/a.ts', missingImport: 'src/c.ts' },
    ])
  })
})
