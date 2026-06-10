import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWriteTool } from '../../../src/native/tools/write.js'
import { createConversation, addUserMessage } from '../../../src/native/conversation.js'
import { ensureTaskExecutionState } from '../../../src/native/task-state.js'

describe('Native Write tool', () => {
  const write = createWriteTool()
  let dir: string
  let prevAllow: string | undefined

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'owlcoda-write-test-'))
    // The fs-policy guard restricts writes to process.cwd() by default.
    // Test fixtures live under tmpdir(), so opt that path in via the same
    // env-var seam real users would use to extend scope.
    prevAllow = process.env['OWLCODA_ALLOW_FS_ROOTS']
    process.env['OWLCODA_ALLOW_FS_ROOTS'] = dir
  })

  afterAll(async () => {
    if (prevAllow === undefined) delete process.env['OWLCODA_ALLOW_FS_ROOTS']
    else process.env['OWLCODA_ALLOW_FS_ROOTS'] = prevAllow
    await rm(dir, { recursive: true, force: true })
  })

  it('has correct name', () => {
    expect(write.name).toBe('write')
  })

  it('writes a new file', async () => {
    const path = join(dir, 'new.txt')
    const result = await write.execute({ path, content: 'hello world' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('bytes')
    const content = await readFile(path, 'utf-8')
    expect(content).toBe('hello world')
  })

  it('overwrites existing file atomically', async () => {
    const path = join(dir, 'overwrite.txt')
    await writeFile(path, 'old content')
    const result = await write.execute({ path, content: 'new content' })
    expect(result.isError).toBe(false)
    const content = await readFile(path, 'utf-8')
    expect(content).toBe('new content')
  })

  it('creates parent directories', async () => {
    const path = join(dir, 'deep', 'nested', 'file.txt')
    const result = await write.execute({ path, content: 'deep' })
    expect(result.isError).toBe(false)
    const content = await readFile(path, 'utf-8')
    expect(content).toBe('deep')
  })

  it('writes empty content', async () => {
    const path = join(dir, 'empty.txt')
    const result = await write.execute({ path, content: '' })
    expect(result.isError).toBe(false)
    const content = await readFile(path, 'utf-8')
    expect(content).toBe('')
  })

  it('writes UTF-8 content correctly', async () => {
    const path = join(dir, 'utf8.txt')
    const text = '你好世界 🌍'
    const result = await write.execute({ path, content: text })
    expect(result.isError).toBe(false)
    const content = await readFile(path, 'utf-8')
    expect(content).toBe(text)
  })

  it('reports byte count in metadata', async () => {
    const path = join(dir, 'meta.txt')
    const result = await write.execute({ path, content: 'abc' })
    expect(result.metadata?.bytes).toBe(3)
  })

  it('tags create kind and captures newContent when file is new', async () => {
    const path = join(dir, 'create-meta.txt')
    const result = await write.execute({ path, content: 'first\ncontent\n' })
    expect(result.metadata?.changeKind).toBe('create')
    expect(result.metadata?.created).toBe(true)
    expect(result.metadata?.oldContent).toBeNull()
    expect(result.metadata?.newContent).toBe('first\ncontent\n')
  })

  it('tags overwrite kind and captures old + new content for diff', async () => {
    const path = join(dir, 'overwrite-meta.txt')
    await writeFile(path, 'old\nbody\n')
    const result = await write.execute({ path, content: 'new\nbody\n' })
    expect(result.metadata?.changeKind).toBe('overwrite')
    expect(result.metadata?.created).toBe(false)
    expect(result.metadata?.oldContent).toBe('old\nbody\n')
    expect(result.metadata?.newContent).toBe('new\nbody\n')
  })

  // 0.13.59 schema-error path. Long-context kimi/deepseek sessions
  // reproducibly emit `tool_use` with empty input; pre-0.13.59 these
  // got the unhelpful "Path must be a non-empty string" error and
  // looped. New error names the schema, echoes the input, and tells
  // the model not to retry the same shape.
  describe('schema-error self-recovery (0.13.59)', () => {
    it('write({}) returns a schema error naming both missing fields', async () => {
      const result = await write.execute({} as any)
      expect(result.isError).toBe(true)
      expect(result.output).toMatch(/missing required field\(s\): `path`, `content`/)
      expect(result.output).toMatch(/Schema: \{ path: string \(absolute path\), content: string \}/)
      expect(result.output).toMatch(/Received input: \{\}/)
      expect(result.output).toMatch(/Do NOT retry the same input shape/)
      expect(result.metadata?.['schemaError']).toBe(true)
      expect(result.metadata?.['missingFields']).toEqual(['path', 'content'])
    })

    it('write({path: "/tmp/x"}) flags missing content only', async () => {
      const result = await write.execute({ path: '/tmp/x' } as any)
      expect(result.isError).toBe(true)
      expect(result.output).toMatch(/missing required field\(s\): `content`/)
      expect(result.metadata?.['missingFields']).toEqual(['content'])
    })

    it('write({path: "", content: "x"}) flags empty path', async () => {
      const result = await write.execute({ path: '', content: 'x' })
      expect(result.isError).toBe(true)
      expect(result.metadata?.['missingFields']).toEqual(['path'])
    })

    it('write with empty content (intentional empty file) is NOT flagged', async () => {
      const path = join(dir, 'empty.txt')
      const result = await write.execute({ path, content: '' })
      expect(result.isError).toBe(false)
      expect(result.metadata?.['schemaError']).toBeUndefined()
    })
  })

  // user-external deliverable path: fs-policy double-layer guard tests
  describe('user-external deliverable path (fs-policy double-layer)', () => {
    it('allows write to user-declared external path via context.taskState', async () => {
      // Use dir as the "external" output dir (already allowed by OWLCODA_ALLOW_FS_ROOTS above)
      const externalTarget = join(dir, 'user-declared-ext', 'out.html')
      const cwd = join(tmpdir(), 'owlcoda-write-ext-cwd')

      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, `输出到 ${externalTarget}`)
      const taskState = ensureTaskExecutionState(conversation, cwd)

      // Sanity: taskState should have user-external scope for the target
      expect(taskState.contract.allowedWritePaths.some(
        (s) => s.origin === 'user-external' && s.path.endsWith('/out.html'),
      )).toBe(true)

      // Execute with context carrying taskState
      const result = await write.execute(
        { path: externalTarget, content: '<html/>' },
        { taskState },
      )
      expect(result.isError).toBe(false)
      expect(result.output).toContain('bytes')
    })

    it('rejects write to undeclared external path even when taskState present (fs-policy blocks)', async () => {
      // cwd is a tmpdir that is NOT in OWLCODA_ALLOW_FS_ROOTS
      const fakeCwd = join(tmpdir(), 'owlcoda-write-fakecwd')
      const undeclaredPath = join(fakeCwd, 'not-declared', 'out.html')

      const conversation = createConversation({ system: 'test', model: 'm' })
      // User only declared some other path
      addUserMessage(conversation, '输出到 /tmp/some-other/path.html')
      const taskState = ensureTaskExecutionState(conversation, fakeCwd)

      const result = await write.execute(
        { path: undeclaredPath, content: '<html/>' },
        { taskState },
      )
      expect(result.isError).toBe(true)
      // fs-policy rejects it (outside workspace, not in externalScopes)
      expect(result.output).toMatch(/Error:/)
    })

    it('file-scope external path: child path is denied by fs-policy (key regression)', async () => {
      // User declares a file target (not a directory). The fs-policy must deny
      // any path that is a descendant of the declared file path.
      // We need a cwd outside the env-var root so allowedRoots doesn't help.
      const fakeCwd = join(tmpdir(), 'owlcoda-write-file-scope-cwd')
      // The child path must be outside dir too (dir is in OWLCODA_ALLOW_FS_ROOTS)
      // so we use a fresh tmpdir that isn't in any allowed root.
      const freshDir = await import('node:fs/promises').then((m) =>
        m.mkdtemp(join(tmpdir(), 'owlcoda-write-file-scope-ext-')),
      )
      try {
        const externalFileOutside = join(freshDir, 'out.html')
        const childPath = join(freshDir, 'out.html', 'child.txt')

        const conversation = createConversation({ system: 'test', model: 'm' })
        addUserMessage(conversation, `输出到 ${externalFileOutside}`)
        const taskState = ensureTaskExecutionState(conversation, fakeCwd)

        // Exact file path: should be allowed via externalScopes file-kind
        const exactResult = await write.execute(
          { path: externalFileOutside, content: '<html/>' },
          { taskState },
        )
        expect(exactResult.isError).toBe(false)

        // Child path: must be denied even though parent file is declared
        const childResult = await write.execute(
          { path: childPath, content: 'child' },
          { taskState },
        )
        expect(childResult.isError).toBe(true)
        expect(childResult.output).toMatch(/Error:/)
      } finally {
        await import('node:fs/promises').then((m) =>
          m.rm(freshDir, { recursive: true, force: true }),
        )
      }
    })
  })
})
