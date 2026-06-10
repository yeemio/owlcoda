import { afterEach, describe, expect, it } from 'vitest'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extractWriteTargets } from '../../src/native/write-provenance.js'

afterEach(() => {
  delete process.env['OWLCODA_GATE_PROVENANCE']
})

describe('extractWriteTargets — TaskCreate (S2-4)', () => {
  const cwd = realpathSync(tmpdir())

  it('TaskCreate({subject}) with no command yields no write targets (passes)', () => {
    // Subject-only TaskCreate is a planning op, not a filesystem mutation.
    const r = extractWriteTargets('TaskCreate', { subject: 'Audit auth flow' }, cwd)
    expect(r).toEqual([])
  })

  it('TaskCreate({command: "echo x > /tmp/foo"}) extracts the redirect target', () => {
    // The command field reuses the bash extractor path so the gate can
    // reason about the spawned command's writes the same way it does
    // for top-level bash calls.
    const r = extractWriteTargets(
      'TaskCreate',
      { command: 'echo x > /tmp/spawned-foo.txt' },
      cwd,
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('redirect_stdout')
    expect(r[0].path).toContain('spawned-foo.txt')
  })

  it('TaskCreate({command: "rm /tmp/junk"}) extracts the rm target (destructive)', () => {
    const r = extractWriteTargets(
      'TaskCreate',
      { command: 'rm /tmp/spawned-junk' },
      cwd,
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('rm')
    expect(r[0].destructive).toBe(true)
  })

  it('TaskCreate({command: "echo hi"}) (non-mutating) yields no write targets', () => {
    // Read-only bash inside TaskCreate is fine; no extraction, gate passes.
    const r = extractWriteTargets(
      'TaskCreate',
      { command: 'echo hi' },
      cwd,
    )
    expect(r).toEqual([])
  })

  it('TaskCreate({subject, command}) extracts targets from the command (subject ignored)', () => {
    // Mixed input — only the command field matters for write-target extraction.
    const r = extractWriteTargets(
      'TaskCreate',
      {
        subject: 'Some plan',
        command: 'cat <<EOF > /tmp/spawned-out\nhi\nEOF',
      },
      cwd,
    )
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('heredoc')
  })

  it('tool-name comparison is case-insensitive (TaskCreate / taskcreate / TASKCREATE)', () => {
    for (const name of ['TaskCreate', 'taskcreate', 'TASKCREATE']) {
      const r = extractWriteTargets(name, { command: 'rm /tmp/x' }, cwd)
      expect(r).toHaveLength(1)
      expect(r[0].kind).toBe('rm')
    }
  })

  it('TaskCreate({command: "python -c \\"open(...).write(...)\\""}) fails open (no targets)', () => {
    // Unparseable bash inside TaskCreate follows the same fail-open
    // contract as top-level bash: extractor returns []. The wired caller
    // emits path_provenance_bash_unparseable telemetry so the gap is
    // tracked, but the gate does not block.
    const r = extractWriteTargets(
      'TaskCreate',
      { command: `python -c "open('/tmp/foo','w').write('x')"` },
      cwd,
    )
    expect(r).toEqual([])
  })
})
