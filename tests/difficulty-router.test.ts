import { describe, expect, it } from 'vitest'
import {
  classifyTurnDifficulty,
  resolveDifficultyModel,
  isRoutingShadowEnabled,
  buildRoutingShadowEvent,
} from '../src/difficulty-router.js'

function userText(text: string) {
  return { messages: [{ role: 'user', content: text }] }
}

describe('classifyTurnDifficulty', () => {
  it('classifies a short confirmation as simple', () => {
    const s = classifyTurnDifficulty(userText('yes, continue'))
    expect(s.difficulty).toBe('simple')
    expect(s.source).toBe('confirmation')
  })

  it('classifies a short summarize request as simple', () => {
    expect(classifyTurnDifficulty(userText('summarize the findings above')).difficulty).toBe('simple')
  })

  it('classifies an explicit complex verb as hard', () => {
    const s = classifyTurnDifficulty(userText('refactor the auth module to use the new endpoint layer'))
    expect(s.difficulty).toBe('hard')
    expect(s.source).toBe('complex_verb')
  })

  it('classifies a very long request as hard', () => {
    const s = classifyTurnDifficulty(userText('please '.repeat(400)))
    expect(s.difficulty).toBe('hard')
    expect(s.source).toBe('long_request')
  })

  it('defaults to moderate for an ordinary question (conservative: not simple)', () => {
    expect(classifyTurnDifficulty(userText('what files are in the src directory?')).difficulty).toBe('moderate')
  })

  it('does NOT call a short actionable ask simple (fix it is hard, not simple)', () => {
    expect(classifyTurnDifficulty(userText('fix the bug')).difficulty).not.toBe('simple')
  })

  it('extracts text from array content blocks', () => {
    const body = { messages: [{ role: 'user', content: [{ type: 'text', text: 'lgtm, proceed' }] }] }
    expect(classifyTurnDifficulty(body).difficulty).toBe('simple')
  })

  it('returns moderate when there are no messages (safe default)', () => {
    expect(classifyTurnDifficulty({}).difficulty).toBe('moderate')
  })
})

describe('resolveDifficultyModel', () => {
  const config = {
    models: [
      { id: 'small', tier: 'fast' },
      { id: 'mid', tier: 'balanced' },
      { id: 'big', tier: 'heavy' },
    ],
  } as any

  it('routes simple turns to the fast tier', () => {
    expect(resolveDifficultyModel(config, 'simple')).toBe('small')
  })

  it('routes hard turns to the heavy tier', () => {
    expect(resolveDifficultyModel(config, 'hard')).toBe('big')
  })

  it('routes moderate turns to the balanced tier', () => {
    expect(resolveDifficultyModel(config, 'moderate')).toBe('mid')
  })

  it('returns null when no model matches and there is no default', () => {
    expect(resolveDifficultyModel({ models: [] } as any, 'simple')).toBeNull()
  })
})

describe('isRoutingShadowEnabled', () => {
  it('defaults OFF (opt-in) when the env var is unset', () => {
    expect(isRoutingShadowEnabled({})).toBe(false)
  })

  it('is enabled by truthy values', () => {
    expect(isRoutingShadowEnabled({ OWLCODA_ROUTING_SHADOW: '1' })).toBe(true)
    expect(isRoutingShadowEnabled({ OWLCODA_ROUTING_SHADOW: 'on' })).toBe(true)
  })

  it('stays off for falsy values', () => {
    expect(isRoutingShadowEnabled({ OWLCODA_ROUTING_SHADOW: '0' })).toBe(false)
    expect(isRoutingShadowEnabled({ OWLCODA_ROUTING_SHADOW: 'false' })).toBe(false)
  })
})

describe('buildRoutingShadowEvent', () => {
  const config = {
    models: [{ id: 'small', tier: 'fast' }, { id: 'big', tier: 'heavy', default: true }],
  } as any

  it('builds an observe-decision envelope tagged with the difficulty', () => {
    const ev = buildRoutingShadowEvent(config, userText('yes, continue'), 'big')
    expect(ev.eventType).toBe('model_routing_shadow')
    expect(ev.decision).toBe('observe')
    expect((ev.attributes as any).difficulty).toBe('simple')
    expect((ev.attributes as any).actualModel).toBe('big')
    expect((ev.attributes as any).wouldRouteModel).toBe('small')
    expect((ev.attributes as any).wouldDiffer).toBe(true)
  })

  it('marks wouldDiffer false when difficulty routing agrees with the actual model', () => {
    const ev = buildRoutingShadowEvent(config, userText('refactor the whole module deeply'), 'big')
    expect((ev.attributes as any).wouldDiffer).toBe(false)
  })
})
