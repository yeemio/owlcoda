import { describe, expect, it } from 'vitest'
import { resolveAndFetch, type GitRunner } from '../src/skills/git-source.js'

describe('git-source', () => {
  it('resolves a ref to a SHA and fetches into dest using the injected runner', async () => {
    const calls: string[][] = []
    const fakeRunner: GitRunner = async (args) => {
      calls.push(args)
      if (args[0] === 'ls-remote') return 'deadbeefcafe1234\trefs/tags/v1\n'
      return ''
    }
    const res = await resolveAndFetch({ url: 'https://e/repo.git', ref: 'v1', dest: '/tmp/x' }, fakeRunner)
    expect(res.pinnedRef).toBe('deadbeefcafe1234')
    expect(calls.some(c => c[0] === 'ls-remote')).toBe(true)
    expect(calls.some(c => c.includes('clone') || c.includes('fetch'))).toBe(true)
  })
})
