import { describe, expect, it } from 'vitest'

import { buildEditNowNudgePrompt } from '../../src/native/task-execution-policy.js'
import type { EditNowNudge } from '../../src/native/protocol/task-permission-types.js'

describe('buildEditNowNudgePrompt', () => {
  it('mentions tool, grant iteration, and iters-since-grant', () => {
    const nudge: EditNowNudge = {
      tool: 'edit',
      grantIteration: 3,
      itersSinceGrant: 5,
      grantTs: Date.now(),
    }

    const prompt = buildEditNowNudgePrompt(nudge)

    expect(prompt).toContain('[Runtime edit_now]')
    expect(prompt).toMatch(/edit/)
    expect(prompt).toMatch(/iteration 3/)
    expect(prompt).toMatch(/5 iterations/)
    expect(prompt).toMatch(/call the tool now/i)
  })
})
