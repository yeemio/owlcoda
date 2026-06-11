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

describe('git-source URL safety (remote-helper RCE guard)', () => {
  function recordingRunner() {
    const calls: string[][] = []
    const run: GitRunner = async (args) => {
      calls.push(args)
      if (args[0] === 'ls-remote') return 'deadbeefcafe1234\trefs/tags/v1\n'
      return ''
    }
    return { run, calls }
  }

  // git's `ext::`/`fd::` remote-helper transports execute arbitrary commands;
  // a leading `-` is option injection; `file://` reads the local FS. None of
  // these are valid third-party skill sources and must be refused before git runs.
  const dangerous = [
    'ext::sh -c "touch /tmp/pwned"',
    'fd::17/foo',
    'file:///etc/passwd',
    '-upload-pack=touch /tmp/pwned',
    '   ',
  ]
  for (const url of dangerous) {
    it(`refuses dangerous URL and never invokes git: ${JSON.stringify(url).slice(0, 24)}`, async () => {
      const { run, calls } = recordingRunner()
      await expect(
        resolveAndFetch({ url, ref: 'v1', dest: '/tmp/owlcoda-test-dest' }, run),
      ).rejects.toThrow()
      expect(calls).toHaveLength(0) // refused BEFORE any git command ran
    })
  }

  it('allows a normal https URL', async () => {
    const { run, calls } = recordingRunner()
    await resolveAndFetch({ url: 'https://github.com/o/r.git', ref: 'v1', dest: '/tmp/owlcoda-test-dest' }, run)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('allows an scp-like ssh URL', async () => {
    const { run, calls } = recordingRunner()
    await resolveAndFetch({ url: 'git@github.com:o/r.git', ref: 'v1', dest: '/tmp/owlcoda-test-dest' }, run)
    expect(calls.length).toBeGreaterThan(0)
  })
})
