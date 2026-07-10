import { readFile } from 'node:fs/promises'
import { dirname, extname, join, parse } from 'node:path'

export interface ScriptModuleMismatch {
  packageJsonPath: string
  reason: string
}

export async function checkNewScriptModuleMismatch(
  targetPath: string,
  content: string,
): Promise<ScriptModuleMismatch | null> {
  if (extname(targetPath).toLowerCase() !== '.js') return null
  const executableSource = stripCommentsAndLiterals(content)
  if (!containsCommonJsSyntax(executableSource)) return null

  let current = dirname(targetPath)
  const root = parse(current).root
  while (true) {
    const packageJsonPath = join(current, 'package.json')
    try {
      const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { type?: unknown }
      return pkg.type === 'module'
        ? { packageJsonPath, reason: `CommonJS syntax in .js conflicts with type=module from ${packageJsonPath}` }
        : null
    } catch (error) {
      if (error instanceof SyntaxError) return null
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null
    }
    if (current === root) return null
    current = dirname(current)
  }
}

function containsCommonJsSyntax(source: string): boolean {
  return /(^|[^\w.$])require\s*\(/m.test(source)
    || /\bmodule\s*\.\s*exports\b/.test(source)
    || /(^|[^\w$])exports\s*\.\s*[A-Za-z_$]/m.test(source)
}

function stripCommentsAndLiterals(source: string): string {
  let output = ''
  let state: 'code' | 'single' | 'double' | 'template' | 'line_comment' | 'block_comment' = 'code'
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    const next = source[i + 1]
    if (state === 'code') {
      if (char === '/' && next === '/') {
        output += '  '
        i++
        state = 'line_comment'
      } else if (char === '/' && next === '*') {
        output += '  '
        i++
        state = 'block_comment'
      } else if (char === "'") {
        output += ' '
        state = 'single'
      } else if (char === '"') {
        output += ' '
        state = 'double'
      } else if (char === '`') {
        output += ' '
        state = 'template'
      } else {
        output += char
      }
      continue
    }
    if (state === 'line_comment') {
      if (char === '\n') {
        output += '\n'
        state = 'code'
      } else output += ' '
      continue
    }
    if (state === 'block_comment') {
      if (char === '*' && next === '/') {
        output += '  '
        i++
        state = 'code'
      } else output += char === '\n' ? '\n' : ' '
      continue
    }
    const closing = state === 'single' ? "'" : state === 'double' ? '"' : '`'
    if (char === '\\' && i + 1 < source.length) {
      output += '  '
      i++
    } else if (char === closing) {
      output += ' '
      state = 'code'
    } else {
      output += char === '\n' ? '\n' : ' '
    }
  }
  return output
}
