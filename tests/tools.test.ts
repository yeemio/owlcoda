/**
 * Tests for src/runtime/tools.ts — local tool execution runtime.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

import {
  executeTool,
  executeToolUse,
  TOOL_DEFINITIONS,
  SUPPORTED_TOOLS,
  isWithinWorkspace,
} from '../dist/runtime/tools.js'

// Isolated temp dir for each test run
const TEST_DIR = join(tmpdir(), `owlcoda-tools-test-${randomBytes(4).toString('hex')}`)

const autoApproveConfig = { cwd: TEST_DIR, autoApprove: true, approve: async () => true }

beforeAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
  mkdirSync(TEST_DIR, { recursive: true })
})

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
})

describe('tool definitions', () => {
  it('exports 4 tool definitions (Bash, Read, Write, Glob)', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(4)
    const names = TOOL_DEFINITIONS.map(t => t.name)
    expect(names).toContain('Bash')
    expect(names).toContain('Read')
    expect(names).toContain('Write')
    expect(names).toContain('Glob')
  })

  it('SUPPORTED_TOOLS is a Set with 4 entries', () => {
    expect(SUPPORTED_TOOLS).toBeInstanceOf(Set)
    expect(SUPPORTED_TOOLS.size).toBe(4)
  })

  it('each definition has name, description, inputSchema', () => {
    for (const def of TOOL_DEFINITIONS) {
      expect(typeof def.name).toBe('string')
      expect(typeof def.description).toBe('string')
      expect(def.inputSchema).toBeTruthy()
      expect(def.inputSchema.type).toBe('object')
    }
  })
})

describe('Bash executor', () => {

  it('executes a simple echo command', async () => {
    const result = await executeTool('Bash', { command: 'echo hello' }, autoApproveConfig)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('hello')
  })

  it('returns error for failing command', async () => {
    const result = await executeTool('Bash', { command: 'exit 42' }, autoApproveConfig)
    expect(result.isError).toBe(true)
  })

  it('returns error when command is missing', async () => {
    const result = await executeTool('Bash', {} as any, autoApproveConfig)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('command')
  })

  it('rejects command when not auto-approved and approve returns false', async () => {
    const result = await executeTool('Bash', { command: 'echo safe' }, {
      cwd: TEST_DIR,
      autoApprove: false,
      approve: async () => false,
    })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('rejected')
  })

})

describe('Read executor', () => {

  it('reads an existing file', async () => {
    const filePath = join(TEST_DIR, 'test-read.txt')
    writeFileSync(filePath, 'file content here', 'utf-8')
    const result = await executeTool('Read', { file_path: filePath }, autoApproveConfig)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('file content here')
  })

  it('returns error for missing file', async () => {
    const result = await executeTool('Read', { file_path: '/nonexistent/path/abc.txt' }, autoApproveConfig)
    expect(result.isError).toBe(true)
  })

  it('returns error when file_path is missing', async () => {
    const result = await executeTool('Read', {} as any, autoApproveConfig)
    expect(result.isError).toBe(true)
  })

})

describe('Write executor', () => {

  it('writes a new file', async () => {
    const filePath = join(TEST_DIR, 'write-test.txt')
    const result = await executeTool('Write', { file_path: filePath, content: 'new content' }, autoApproveConfig)
    expect(result.isError).toBe(false)
    expect(readFileSync(filePath, 'utf-8')).toBe('new content')
  })

  it('creates parent directories', async () => {
    const filePath = join(TEST_DIR, 'sub', 'dir', 'deep.txt')
    const result = await executeTool('Write', { file_path: filePath, content: 'deep file' }, autoApproveConfig)
    expect(result.isError).toBe(false)
    expect(existsSync(filePath)).toBe(true)
  })

  it('rejects write when approval denied', async () => {
    const filePath = join(TEST_DIR, 'denied.txt')
    const result = await executeTool('Write', { file_path: filePath, content: 'x' }, {
      cwd: TEST_DIR,
      autoApprove: false,
      approve: async () => false,
    })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('rejected')
    expect(existsSync(filePath)).toBe(false)
  })

})

describe('Glob executor', () => {

  it('finds matching files', async () => {
    writeFileSync(join(TEST_DIR, 'one.ts'), '', 'utf-8')
    writeFileSync(join(TEST_DIR, 'two.ts'), '', 'utf-8')
    const result = await executeTool('Glob', { pattern: '*.ts', path: TEST_DIR }, autoApproveConfig)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('one.ts')
    expect(result.output).toContain('two.ts')
  })

  it('returns no-match message when nothing found', async () => {
    const result = await executeTool('Glob', { pattern: '*.xyz', path: TEST_DIR }, autoApproveConfig)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('No files matching')
  })

})

describe('unknown tool', () => {
  it('returns error for unsupported tool name', async () => {
    const result = await executeTool('Nonexistent', { foo: 'bar' }, autoApproveConfig)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Unknown tool')
  })
})

describe('executeToolUse wrapper', () => {

  it('returns ToolResult with toolUseId', async () => {
    const result = await executeToolUse(
      { id: 'test-123', name: 'Bash', input: { command: 'echo wrapped' } },
      autoApproveConfig,
    )
    expect(result.toolUseId).toBe('test-123')
    expect(result.content).toContain('wrapped')
    expect(result.isError).toBe(false)
  })

  it('returns isError=true for failed tool', async () => {
    const result = await executeToolUse(
      { id: 'err-456', name: 'Read', input: { file_path: '/no/such/file' } },
      autoApproveConfig,
    )
    expect(result.toolUseId).toBe('err-456')
    expect(result.isError).toBe(true)
  })

})

// ─── Workspace boundary tests ───

describe('isWithinWorkspace', () => {
  it('returns true for path equal to cwd', () => {
    expect(isWithinWorkspace('/home/user/project', '/home/user/project')).toBe(true)
  })

  it('returns true for path inside cwd', () => {
    expect(isWithinWorkspace('/home/user/project/src/file.ts', '/home/user/project')).toBe(true)
  })

  it('returns false for path outside cwd', () => {
    expect(isWithinWorkspace('/etc/passwd', '/home/user/project')).toBe(false)
  })

  it('returns false for sibling directory', () => {
    expect(isWithinWorkspace('/home/user/other/file', '/home/user/project')).toBe(false)
  })

  it('returns false for path that is prefix but not parent', () => {
    // /home/user/project-other is NOT inside /home/user/project
    expect(isWithinWorkspace('/home/user/project-other/file', '/home/user/project')).toBe(false)
  })
})

describe('Read workspace boundary', () => {
  it('reads file inside cwd without approval', async () => {
    const filePath = join(TEST_DIR, 'boundary-read.txt')
    writeFileSync(filePath, 'in-workspace', 'utf-8')
    const result = await executeTool('Read', { file_path: filePath }, {
      cwd: TEST_DIR,
      autoApprove: false,
      approve: async () => { throw new Error('should not be called') },
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('in-workspace')
  })

  it('rejects read outside cwd when approval denied', async () => {
    const result = await executeTool('Read', { file_path: '/etc/hosts' }, {
      cwd: TEST_DIR,
      autoApprove: false,
      approve: async () => false,
    })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('outside workspace')
  })

  it('allows read outside cwd when approval granted', async () => {
    // /etc/hosts should exist on macOS/Linux
    const result = await executeTool('Read', { file_path: '/etc/hosts' }, {
      cwd: TEST_DIR,
      autoApprove: false,
      approve: async () => true,
    })
    expect(result.isError).toBe(false)
  })

  it('allows read outside cwd with autoApprove', async () => {
    const result = await executeTool('Read', { file_path: '/etc/hosts' }, {
      cwd: TEST_DIR,
      autoApprove: true,
      approve: async () => false,
    })
    expect(result.isError).toBe(false)
  })
})

describe('Glob workspace boundary', () => {
  it('globs inside cwd without approval', async () => {
    writeFileSync(join(TEST_DIR, 'glob-boundary.ts'), '', 'utf-8')
    const result = await executeTool('Glob', { pattern: '*.ts' }, {
      cwd: TEST_DIR,
      autoApprove: false,
      approve: async () => { throw new Error('should not be called') },
    })
    expect(result.isError).toBe(false)
  })

  it('rejects glob outside cwd when approval denied', async () => {
    const result = await executeTool('Glob', { pattern: '*.conf', path: '/etc' }, {
      cwd: TEST_DIR,
      autoApprove: false,
      approve: async () => false,
    })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('outside workspace')
  })
})
