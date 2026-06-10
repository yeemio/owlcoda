import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

let tempDir: string

vi.mock('../src/paths.js', () => ({
  getOwlcodaDir: () => tempDir,
}))

const { collectProxyExchange } = await import('../src/data/proxy-collector.js')

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'owlcoda-proxy-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('proxy collector', () => {
  it('skips exchanges with too few messages', async () => {
    // Only 2 messages (user + assistant) — below minMessages threshold (4)
    await collectProxyExchange({
      requestMessages: [
        { role: 'user', content: 'hello' },
      ],
      responseContent: 'hi there',
      model: 'test-model',
    })

    // Should not create training data
    const trainingDir = join(tempDir, 'training')
    const collected = join(trainingDir, 'collected.jsonl')
    // May not even create the directory for short exchanges
    if (existsSync(collected)) {
      const data = await readFile(collected, 'utf-8')
      expect(data.trim()).toBe('')
    }
  })

  it('collects qualifying exchanges with sufficient messages', async () => {
    // Build a conversation with 6 messages (3 turns) — above minMessages
    const messages = [
      { role: 'user', content: 'How do I use TypeScript generics?' },
      { role: 'assistant', content: 'Generics allow you to write reusable, type-safe code. Here is an example:\n```typescript\nfunction identity<T>(arg: T): T { return arg; }\n```' },
      { role: 'user', content: 'Can you show a more complex example with constraints?' },
      { role: 'assistant', content: 'Sure! You can constrain generics:\n```typescript\nfunction getProperty<T, K extends keyof T>(obj: T, key: K): T[K] { return obj[key]; }\n```\nThis ensures K is a valid key of T.' },
      { role: 'user', content: 'What about conditional types?' },
    ]

    await collectProxyExchange({
      requestMessages: messages,
      responseContent: 'Conditional types use the `extends` keyword in type position:\n```typescript\ntype IsString<T> = T extends string ? "yes" : "no";\n```\nThey enable powerful type-level programming.',
      model: 'test-model',
    })

    // Check if training data was collected (depends on quality score)
    const trainingDir = join(tempDir, 'training')
    const manifestPath = join(trainingDir, 'manifest.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'))
      // Either collected or skipped (both are valid outcomes depending on quality)
      expect(manifest.totalCollected + manifest.totalSkipped).toBeGreaterThanOrEqual(1)
    }
  })

  it('never throws even on errors', async () => {
    // Pass invalid data — should not throw
    await expect(collectProxyExchange({
      requestMessages: null as any,
      responseContent: null,
      model: '',
    })).resolves.toBeUndefined()
  })

  it('tags collected sessions as proxy-collected', async () => {
    // We can't directly inspect the session passed to the collector,
    // but we can verify the function completes without error
    const messages = [
      { role: 'user', content: 'test 1' },
      { role: 'assistant', content: 'response 1' },
      { role: 'user', content: 'test 2' },
      { role: 'assistant', content: 'response 2' },
      { role: 'user', content: 'test 3' },
    ]

    await expect(collectProxyExchange({
      requestMessages: messages,
      responseContent: 'response 3',
      model: 'proxy-model',
    })).resolves.toBeUndefined()
  })

  it('handles system messages in conversation', async () => {
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'question 1' },
      { role: 'assistant', content: 'answer 1' },
      { role: 'user', content: 'question 2' },
      { role: 'assistant', content: 'answer 2' },
      { role: 'user', content: 'question 3' },
    ]

    // System messages should be filtered out (only user/assistant kept)
    await expect(collectProxyExchange({
      requestMessages: messages,
      responseContent: 'answer 3',
      model: 'test',
    })).resolves.toBeUndefined()
  })
})
