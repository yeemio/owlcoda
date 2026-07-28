import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function trustBoundaryViolations(workflow: string): string[] {
  const violations: string[] = []
  if (!/^\s*pull_request:\s*$/m.test(workflow)) violations.push('pull_request missing')
  if (/^\s*['"]?pull_request_target['"]?\s*:/m.test(workflow)) {
    violations.push('pull_request_target is not allowed')
  }

  const declarations = [...workflow.matchAll(
    /(?:^|[\n,{])\s*(?:runs-on|['"]runs-on['"])\s*:\s*([^,\n}]+)/g,
  )].map(match => match[1]!.trim())
  if (declarations.length === 0) violations.push('runs-on missing')
  for (const declaration of declarations) {
    if (declaration !== 'macos-14') violations.push(`untrusted runs-on: ${declaration}`)
  }
  return violations
}

describe('public CI trust boundary', () => {
  it('never executes pull-request code on a persistent self-hosted runner', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8')

    expect(trustBoundaryViolations(workflow)).toEqual([])
  })

  it.each([
    ['scalar self-hosted job', '\n  attacker:\n    runs-on: self-hosted\n'],
    ['array self-hosted job', '\n  attacker:\n    runs-on: [self-hosted, macOS, ARM64]\n'],
    ['expression-selected runner', '\n  attacker:\n    runs-on: ${{ matrix.runner }}\n'],
    ['matrix-selected runner', '\n  attacker:\n    runs-on: matrix.runner\n'],
    ['inline self-hosted job', '\n  attacker: { runs-on: self-hosted, steps: [] }\n'],
    ['quoted self-hosted key', '\n  attacker:\n    "runs-on": self-hosted\n'],
    ['pull_request_target trigger', '\npull_request_target:\n'],
  ])('rejects a workflow mutation that adds %s', (_name, mutation) => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8')

    expect(trustBoundaryViolations(`${workflow}${mutation}`)).not.toEqual([])
  })
})
