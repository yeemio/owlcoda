import { describe, it, expect } from 'vitest'
import { createAskUserQuestionTool } from '../../src/native/tools/ask-user.js'

describe('AskUserQuestion Tool', () => {
  it('has name AskUserQuestion', () => {
    const tool = createAskUserQuestionTool()
    expect(tool.name).toBe('AskUserQuestion')
  })

  it('has a description', () => {
    const tool = createAskUserQuestionTool()
    expect(tool.description).toBeTruthy()
  })

  it('rejects empty question', async () => {
    const tool = createAskUserQuestionTool()
    const result = await tool.execute({ question: '' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('question is required')
  })

  it('rejects non-string question', async () => {
    const tool = createAskUserQuestionTool()
    const result = await tool.execute({ question: 123 as any })
    expect(result.isError).toBe(true)
  })

  // ── P0 side-channel cleanup regression ──
  //
  // When the host provides `context.askUserQuestion`, the tool MUST
  // route through that callback and NEVER write to process.stdout
  // directly. Writing to stdout mid-tool races Ink's frame paint
  // (see memory/feedback_ink_side_channel_stdout_race.md). These
  // tests lock down that contract so a future refactor that
  // accidentally reintroduces the stdout path fails hard.

  it('routes through context.askUserQuestion when provided (no stdout.write)', async () => {
    const tool = createAskUserQuestionTool()
    let calls = 0
    let seenQuestion = ''
    let seenOpts: unknown = null
    const result = await tool.execute(
      {
        question: 'pick one',
        options: [{ label: 'A' }, { label: 'B', description: 'second' }],
        multiSelect: false,
      },
      {
        askUserQuestion: async (question, opts) => {
          calls++
          seenQuestion = question
          seenOpts = opts
          return '2'
        },
      },
    )
    expect(calls).toBe(1)
    expect(seenQuestion).toBe('pick one')
    expect(seenOpts).toEqual({
      options: [{ label: 'A' }, { label: 'B', description: 'second' }],
      multiSelect: false,
    })
    // "2" = 1-based index into options → label "B"
    expect(result.isError).toBe(false)
    expect(result.output).toBe('User selected: B')
    expect(result.metadata?.['selected']).toEqual(['B'])
  })

  it('passes a free-text answer straight through when no options match', async () => {
    const tool = createAskUserQuestionTool()
    const result = await tool.execute(
      { question: 'why?' },
      { askUserQuestion: async () => 'because' },
    )
    expect(result.isError).toBe(false)
    expect(result.output).toBe('User response: because')
    expect(result.metadata?.['answer']).toBe('because')
  })

  it('treats empty answer as cancellation (matches Ctrl+C/Escape on the overlay)', async () => {
    const tool = createAskUserQuestionTool()
    const result = await tool.execute(
      { question: 'stop?' },
      { askUserQuestion: async () => '' },
    )
    // Cancellation is NOT an error — the model learns the user
    // declined to answer without the tool itself failing.
    expect(result.isError).toBe(false)
    expect(result.output).toContain('cancelled')
    expect(result.metadata?.['cancelled']).toBe(true)
  })

  it('resolves multi-select numeric answers against options', async () => {
    const tool = createAskUserQuestionTool()
    const result = await tool.execute(
      {
        question: 'pick any',
        options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }],
        multiSelect: true,
      },
      { askUserQuestion: async () => '1, 3' },
    )
    expect(result.isError).toBe(false)
    expect(result.output).toBe('User selected: X, Z')
    expect(result.metadata?.['selected']).toEqual(['X', 'Z'])
  })

  it('surfaces host-callback errors as tool errors (does not crash the loop)', async () => {
    const tool = createAskUserQuestionTool()
    const result = await tool.execute(
      { question: 'boom?' },
      {
        askUserQuestion: async () => {
          throw new Error('overlay unmounted')
        },
      },
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('overlay unmounted')
  })

  it('does NOT write to process.stdout when context.askUserQuestion is provided', async () => {
    const tool = createAskUserQuestionTool()
    const writes: Array<string | Buffer> = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stdout.write = ((chunk: any): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      await tool.execute(
        { question: 'callback-route' },
        { askUserQuestion: async () => 'answer' },
      )
    } finally {
      process.stdout.write = originalWrite
    }
    // The host callback handles display; the tool itself must not
    // emit a byte. Any entry in `writes` is a direct invariant
    // violation.
    expect(writes).toEqual([])
  })
})
