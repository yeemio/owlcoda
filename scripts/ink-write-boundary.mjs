#!/usr/bin/env node
// F7 module-boundary lint — fitness cell arch.ink_write_boundary.
//
// Forbid side-channel terminal writes from React effect hooks in the Ink layer.
// The renderer fork legitimately writes to stdout in ~35 places (alt-screen,
// cursor, mouse, the buffered flush), so a blanket "no stdout.write in ink" ban
// would be all false positives. The invariant memory teaches is narrower: a
// useLayoutEffect / useEffect must NEVER stdout.write directly — every write
// goes through the buffered render Diff. This scopes the ban to effect-hook
// bodies via the TypeScript AST, so the legit renderer sites are untouched.
//
// typescript is a devDependency (already present for the build). This script is
// NOT shipped (npm files[] publishes dist/, not scripts/), so it adds nothing
// to the runtime install and does not touch package.json.
import ts from 'typescript'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const EFFECT_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect'])

function effectHookName(node) {
  if (!ts.isCallExpression(node)) return null
  const e = node.expression
  const name = ts.isIdentifier(e)
    ? e.text
    : ts.isPropertyAccessExpression(e)
      ? e.name.text
      : ''
  return EFFECT_HOOKS.has(name) ? name : null
}

function isStdoutWrite(node, sf) {
  if (!ts.isCallExpression(node)) return false
  const e = node.expression
  if (!ts.isPropertyAccessExpression(e)) return false
  if (e.name.text !== 'write') return false
  const obj = e.expression.getText(sf)
  return obj === 'stdout' || obj.endsWith('.stdout')
}

/** Lines where a stdout.write call sits lexically inside a React effect-hook
 *  callback. Pure — takes source text, returns {line, text}[]. */
export function findInkSideChannelWrites(sourceText, fileName = 'input.tsx') {
  // Parse per extension: .ts as TS, .tsx as TSX. Parsing .ts as TSX misreads
  // angle-bracket type assertions (`<Foo>bar`) as JSX, which can swallow a real
  // stdout.write the gate must catch.
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(
    fileName, sourceText, ts.ScriptTarget.Latest, true, kind,
  )
  const violations = []
  const visit = (node, insideEffect) => {
    if (insideEffect && isStdoutWrite(node, sf)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      violations.push({
        line: line + 1,
        text: node.getText(sf).split('\n')[0].trim().slice(0, 100),
      })
    }
    if (effectHookName(node) && node.arguments.length > 0) {
      const cb = node.arguments[0]
      ts.forEachChild(node, child => visit(child, insideEffect || child === cb))
      return
    }
    ts.forEachChild(node, child => visit(child, insideEffect))
  }
  visit(sf, false)
  return violations
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const root = process.cwd()
  const enforce = process.argv.includes('--enforce')
  const files = execFileSync('git', ['ls-files', 'src/ink'], { cwd: root, encoding: 'utf-8' })
    .split('\n')
    .filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))
  const all = []
  for (const f of files) {
    for (const h of findInkSideChannelWrites(readFileSync(join(root, f), 'utf-8'), f)) {
      all.push({ file: f, ...h })
    }
  }
  if (all.length > 0) {
    console.error('Ink side-channel writes (stdout.write inside a React effect hook):')
    for (const v of all) console.error(`  ${v.file}:${v.line}  ${v.text}`)
    console.error(
      `\n${all.length} violation(s). Route terminal writes through the buffered render Diff, not effect hooks.`,
    )
    process.exit(enforce ? 1 : 0)
  }
  console.log(`arch.ink_write_boundary: scanned ${files.length} Ink sources, no effect-hook stdout writes.`)
}
