// Import-integrity check behind fitness cell build.imported_untracked.
//
// The 0.14.53 "断头 HEAD" blocker: a new source module is imported by tracked
// code but never `git add`ed. The dirty working tree builds fine (the file is
// on disk) yet a clean clone — and therefore the published tarball — is broken
// because the importer resolves to a module that does not exist in git. The
// clean-checkout build step already fails on this, but only with a cryptic
// `TS2307: Cannot find module`. This module turns it into a named, precise
// diagnostic ("tracked file X imports untracked module Y") and gives the
// fitness matrix a deterministic, directly-probeable kernel.

import { posix as path } from 'node:path'

export interface ModuleImport {
  /** The tracked source file doing the importing (repo-relative POSIX path). */
  file: string
  /** Repo-relative POSIX paths its relative imports resolve to. */
  resolvedImports: string[]
}

export interface ImportedUntrackedViolation {
  file: string
  missingImport: string
}

/** Given the relative-import graph of tracked files and the set of git-tracked
 *  repo-relative paths, return every import whose target is NOT tracked — the
 *  "imported but never git-added" class. Pure. */
export function findImportedUntracked(
  modules: readonly ModuleImport[],
  trackedFiles: ReadonlySet<string>,
): ImportedUntrackedViolation[] {
  const violations: ImportedUntrackedViolation[] = []
  for (const mod of modules) {
    for (const target of mod.resolvedImports) {
      if (!trackedFiles.has(target)) {
        violations.push({ file: mod.file, missingImport: target })
      }
    }
  }
  return violations
}

/** Relative (`./` or `../`) import specifiers in TS/JS source text, in source
 *  order. Covers static `from`, side-effect `import '...'`, re-export `from`,
 *  and dynamic `import('...')`. Bare package / node-builtin specifiers are
 *  dropped — they cannot be untracked-in-repo. */
/** Drop block + line comments so a `from '...'` written inside a comment is not
 *  mistaken for an import. (The rarer case of a relative specifier inside a
 *  string literal is left to the clean-clone build, the authoritative backstop.) */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
}

export function extractRelativeImports(source: string): string[] {
  const code = stripComments(source)
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g, // import/export ... from '...'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('...')
    /\bimport\s+['"]([^'"]+)['"]/g, // side-effect import '...'
  ]
  const hits: Array<{ index: number; spec: string }> = []
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(code)) !== null) {
      hits.push({ index: m.index, spec: m[1]! })
    }
  }
  hits.sort((a, b) => a.index - b.index)
  return hits
    .map(h => h.spec)
    .filter(spec => spec.startsWith('./') || spec.startsWith('../'))
}

/** Repo-relative POSIX source paths a relative specifier could resolve to, in
 *  priority order. Handles the ESM `.js`→`.ts`/`.tsx` rewrite, extensionless
 *  and directory (`/index`) imports, and `.json`. */
export function resolveImportCandidates(importerFile: string, specifier: string): string[] {
  const joined = path.join(path.dirname(importerFile), specifier)
  const candidates: string[] = []
  const add = (p: string): void => { if (!candidates.includes(p)) candidates.push(p) }
  if (joined.endsWith('.json')) {
    add(joined)
  } else if (joined.endsWith('.js') || joined.endsWith('.mjs') || joined.endsWith('.cjs')) {
    const base = joined.slice(0, joined.lastIndexOf('.'))
    add(`${base}.ts`)
    add(`${base}.tsx`)
    add(joined)
  } else if (joined.endsWith('.ts') || joined.endsWith('.tsx')) {
    add(joined)
  } else {
    add(`${joined}.ts`)
    add(`${joined}.tsx`)
    add(`${joined}/index.ts`)
    add(`${joined}/index.tsx`)
  }
  return candidates
}

/** Brain of the build.imported_untracked gate: for each source file, every
 *  relative import whose resolution candidates are ALL untracked is a clean-
 *  clone build break (the importer is tracked but its target was never
 *  git-added). Pure — caller supplies file contents and the git-tracked set. */
export function checkTrackedImports(
  files: readonly { file: string; source: string }[],
  trackedFiles: ReadonlySet<string>,
): ImportedUntrackedViolation[] {
  const violations: ImportedUntrackedViolation[] = []
  for (const { file, source } of files) {
    for (const spec of extractRelativeImports(source)) {
      const candidates = resolveImportCandidates(file, spec)
      if (!candidates.some(c => trackedFiles.has(c))) {
        violations.push({ file, missingImport: candidates[0] ?? spec })
      }
    }
  }
  return violations
}
