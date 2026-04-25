import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { buildFilePickerItems } from '../../../src/native/tui/file-picker.js'

describe('buildFilePickerItems', () => {
  it('lists files and directories as picker items without descending skipped directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-file-picker-'))
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, '.claude'))
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'package.json'), '{}')
    writeFileSync(join(root, '.env.example'), 'A=1')
    writeFileSync(join(root, 'src', 'index.ts'), 'export {}')
    writeFileSync(join(root, '.claude', 'ignored.json'), '{}')
    writeFileSync(join(root, 'node_modules', 'ignored.js'), '')

    const items = buildFilePickerItems({ cwd: root, limit: 20 })
    const values = items.map((item) => item.value)
    expect(values).toContain('package.json')
    expect(values).toContain('src/')
    expect(values).toContain('src/index.ts')
    expect(values).not.toContain('.claude/ignored.json')
    expect(values).not.toContain('node_modules/ignored.js')
    expect(values.indexOf('package.json')).toBeLessThan(values.indexOf('.env.example'))
  })
})
