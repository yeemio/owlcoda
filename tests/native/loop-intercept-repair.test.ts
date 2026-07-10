import { describe, expect, it } from 'vitest'
import { buildLoopInterceptPrompt } from '../../src/native/conversation.js'

describe('non-destructive loop repair', () => {
  it('continues autonomously for BrowserJob instead of asking the user', () => {
    const prompt = buildLoopInterceptPrompt('repeated timeout', {
      name: 'BrowserJob',
      category: 'browser',
      intentTarget: 'capture',
      intentKey: 'browser:capture',
    })

    expect(prompt).toContain('Do not ask the user')
    expect(prompt).toContain('continue autonomously')
    expect(prompt).toContain('Do not repeat the same intent')
  })
})
