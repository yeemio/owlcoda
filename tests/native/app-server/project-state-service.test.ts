import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appServerProjectStatePath } from '../../../src/native/app-server/project-state-service.js'

const temporaryRoots: string[] = []
const originalOwlCodaHome = process.env['OWLCODA_HOME']

afterEach(() => {
  if (originalOwlCodaHome === undefined) delete process.env['OWLCODA_HOME']
  else process.env['OWLCODA_HOME'] = originalOwlCodaHome
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

describe('App Server project state paths', () => {
  it('keeps mutable project-scoped state under OWLCODA_HOME instead of the repository', () => {
    const home = temporaryRoot('owlcoda-app-state-home-')
    const firstProject = temporaryRoot('owlcoda-app-state-project-a-')
    const secondProject = temporaryRoot('owlcoda-app-state-project-b-')
    process.env['OWLCODA_HOME'] = home

    const first = appServerProjectStatePath(firstProject, 'approvals.json')
    const firstAgain = appServerProjectStatePath(firstProject, 'approvals.json')
    const second = appServerProjectStatePath(secondProject, 'approvals.json')

    expect(first).toBe(firstAgain)
    expect(first).toMatch(new RegExp(`^${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/app-server/projects/[a-f0-9]{20}/approvals\\.json$`))
    expect(first.startsWith(firstProject)).toBe(false)
    expect(second).not.toBe(first)
  })
})
