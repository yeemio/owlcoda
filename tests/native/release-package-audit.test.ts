import { describe, expect, it } from 'vitest'

import {
  auditReleasePackageFileList,
  REQUIRED_RELEASE_PACKAGE_FILES,
} from '../../src/native/release-package-audit.js'

describe('release package audit', () => {
  const validFiles = [
    'package/dist/cli.js',
    'package/dist/build-info.json',
    'package/schemas/runtime-event-contract.v1.schema.json',
    'package/skills/goal-driven-project-loop/SKILL.md',
    'package/skills/openai-docs/SKILL.md',
    'package/skills/testing/test-driven-development/SKILL.md',
    'package/README.md',
    'package/README.zh.md',
    'package/CHANGELOG.md',
    'package/LICENSE',
    'package/SOURCE.md',
    'package/NOTICE.md',
    'package/assets/branding/admin-models.png',
    'package/scripts/postbuild.mjs',
    'package/config.example.json',
    'package/package.json',
  ]

  it('passes when the package contains required release artifacts and no forbidden surfaces', () => {
    const audit = auditReleasePackageFileList(validFiles)

    expect(audit.passed).toBe(true)
    expect(audit.missing).toEqual([])
    expect(audit.forbidden).toEqual([])
    expect(audit.hasSkillEntrypoints).toBe(3)
    expect(audit.required).toEqual(REQUIRED_RELEASE_PACKAGE_FILES)
  })

  it('fails when runtime truth schema, skill entrypoints, or private source surfaces are wrong', () => {
    const audit = auditReleasePackageFileList([
      ...validFiles.filter((file) => !file.includes('runtime-event-contract.v1.schema.json')),
      'package/src/native/runtime-events.ts',
      'package/dist/native/runtime-events.js.map',
    ])

    expect(audit.passed).toBe(false)
    expect(audit.missing).toContain('schemas/runtime-event-contract.v1.schema.json')
    expect(audit.forbidden).toEqual([
      'src/native/runtime-events.ts',
      'dist/native/runtime-events.js.map',
    ])
  })
})
