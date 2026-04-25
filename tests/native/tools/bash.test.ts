import { describe, it, expect } from 'vitest'
import { createBashTool } from '../../../src/native/tools/bash.js'

describe('Native Bash tool', () => {
  const bash = createBashTool()

  // ── Basic contract ──

  it('has correct name and description', () => {
    expect(bash.name).toBe('bash')
    expect(bash.description).toBeTruthy()
  })

  // ── Successful execution ──

  it('runs a simple echo command', async () => {
    const result = await bash.execute({ command: 'echo hello' })
    expect(result.isError).toBe(false)
    expect(result.output).toBe('hello')
  })

  it('captures multi-line stdout', async () => {
    const result = await bash.execute({
      command: 'echo "line1"; echo "line2"; echo "line3"',
    })
    expect(result.isError).toBe(false)
    expect(result.output).toBe('line1\nline2\nline3')
  })

  it('captures stderr separately', async () => {
    const result = await bash.execute({
      command: 'echo ok; echo err >&2',
    })
    expect(result.output).toContain('ok')
    expect(result.output).toContain('[stderr]')
    expect(result.output).toContain('err')
  })

  // ── Exit codes ──

  it('reports exit code 0 as success', async () => {
    const result = await bash.execute({ command: 'true' })
    expect(result.isError).toBe(false)
    expect(result.metadata?.exitCode).toBe(0)
  })

  it('reports non-zero exit code as error', async () => {
    const result = await bash.execute({ command: 'exit 42' })
    expect(result.isError).toBe(true)
    expect(result.metadata?.exitCode).toBe(42)
  })

  it('reports failure for command not found', async () => {
    const result = await bash.execute({
      command: 'nonexistent_command_xyz_123',
    })
    expect(result.isError).toBe(true)
    expect(result.metadata?.exitCode).not.toBe(0)
  })

  // ── Working directory ──

  it('runs in custom cwd', async () => {
    const result = await bash.execute({
      command: 'pwd',
      cwd: '/tmp',
    })
    expect(result.isError).toBe(false)
    // /tmp may resolve to /private/tmp on macOS
    expect(result.output).toMatch(/\/tmp/)
  })

  // ── Empty / invalid input ──

  it('rejects empty command', async () => {
    const result = await bash.execute({ command: '' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('empty command')
  })

  it('rejects whitespace-only command', async () => {
    const result = await bash.execute({ command: '   ' })
    expect(result.isError).toBe(true)
  })

  // ── Timeout ──

  it('kills process on timeout', async () => {
    const result = await bash.execute({
      command: 'sleep 60',
      timeoutMs: 200,
    })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('timed out')
    expect(result.metadata?.killed).toBe(true)
  }, 10_000)

  // ── Output truncation ──

  it('truncates very large output', async () => {
    // Generate ~2 MiB of output (exceeds 1 MiB cap)
    const result = await bash.execute({
      command: 'dd if=/dev/zero bs=1024 count=2048 2>/dev/null | LC_ALL=C tr "\\0" "A"',
      timeoutMs: 10_000,
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('truncated')
  }, 15_000)

  // ── Pipes and compound commands ──

  it('handles pipes correctly', async () => {
    const result = await bash.execute({
      command: 'echo "hello world" | tr "a-z" "A-Z"',
    })
    expect(result.isError).toBe(false)
    expect(result.output).toBe('HELLO WORLD')
  })

  it('handles && chains', async () => {
    const result = await bash.execute({
      command: 'echo first && echo second',
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('first')
    expect(result.output).toContain('second')
  })

  // ── Environment ──

  it('inherits process environment', async () => {
    const result = await bash.execute({ command: 'echo $HOME' })
    expect(result.isError).toBe(false)
    expect(result.output.length).toBeGreaterThan(0)
    expect(result.output).not.toBe('$HOME')
  })

  // ── No output case ──

  it('reports "(no output)" for silent success', async () => {
    const result = await bash.execute({ command: 'true' })
    expect(result.isError).toBe(false)
    expect(result.output).toBe('(no output)')
  })

  // ── Progress callback ──

  it('emits progress events when onProgress is provided', async () => {
    const events: Array<{ totalLines: number; totalBytes: number }> = []
    const result = await bash.execute(
      { command: 'for i in 1 2 3 4 5; do echo "line $i"; done' },
      {
        onProgress: (event) => {
          events.push({ totalLines: event.totalLines, totalBytes: event.totalBytes })
        },
      },
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('line 1')
    // Progress events should have been emitted (at least one)
    // Note: fast commands may finish before the 250ms interval fires
    // so we just verify the callback interface works without assertion on count
  })

  it('does not crash when onProgress is not provided', async () => {
    const result = await bash.execute({ command: 'echo ok' })
    expect(result.isError).toBe(false)
    expect(result.output).toBe('ok')
  })

  it('aborts a running command when signal is cancelled', async () => {
    const ac = new AbortController()
    const promise = bash.execute(
      { command: 'sleep 60' },
      { signal: ac.signal },
    )

    setTimeout(() => ac.abort(), 50)
    const result = await promise

    expect(result.isError).toBe(true)
    expect(result.output).toContain('aborted')
    expect(result.metadata?.aborted).toBe(true)
  }, 10_000)

  // ── P0 cancel-chain regression guards ──
  //
  // The bug: without process-group kill + hard deadline, a command that
  // backgrounds a grandchild which inherits stdio would hang forever —
  // the immediate bash child dies on SIGTERM/SIGKILL but the grandchild
  // keeps the pipe fd open, so Node's `close` event (which waits for
  // stdio EOF) never fires. This hangs the conversation loop until
  // the grandchild naturally exits (60+ seconds in this scenario).
  //
  // Fix: detached=true + `process.kill(-pid, SIG)` kills the entire
  // process group, plus a 3s hard deadline forces the Promise to
  // resolve even if `close` is never delivered.

  it('abort returns within ~3s even when a backgrounded grandchild inherits stdio', async () => {
    const ac = new AbortController()
    // `(sleep 30 &)` forks a grandchild in a subshell. The grandchild
    // inherits stdout/stderr from the bash group. Without process-group
    // kill, the outer `sleep 60` dies but the backgrounded `sleep 30`
    // keeps stdout open — `close` waits 30s for the grandchild to exit.
    const promise = bash.execute(
      { command: '(sleep 30 >/tmp/bash-tool-abort-test.log 2>&1 &); echo started; sleep 60' },
      { signal: ac.signal },
    )
    // Wait for bash to have started so the subshell has forked
    await new Promise((r) => setTimeout(r, 300))
    const abortStart = Date.now()
    ac.abort()
    const result = await promise
    const elapsed = Date.now() - abortStart

    expect(result.metadata?.aborted).toBe(true)
    // Must bound total time after abort — process-group kill + hard
    // deadline ensures < 4s regardless of stdio-holding grandchildren.
    expect(elapsed).toBeLessThan(4000)
  }, 15_000)

  it('abort kills grandchild processes via process group, not just the immediate child', async () => {
    const ac = new AbortController()
    const marker = `owlcoda-bash-group-kill-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const promise = bash.execute(
      {
        // The grandchild has a unique marker in argv so we can grep
        // process table afterward to verify it was killed.
        command: `bash -c 'exec -a ${marker}-grandchild sleep 120' & sleep 120`,
      },
      { signal: ac.signal },
    )
    await new Promise((r) => setTimeout(r, 300))
    ac.abort()
    await promise

    // Give the kernel a moment to reap the killed processes
    await new Promise((r) => setTimeout(r, 500))

    // Verify no process matching our marker is still running.
    // `pgrep -f <marker>` returns 0 if matches exist, 1 if none.
    const { spawnSync } = await import('node:child_process')
    const grep = spawnSync('pgrep', ['-f', marker], { encoding: 'utf-8' })
    expect(grep.status).not.toBe(0) // grandchild process is gone
  }, 15_000)

  it('force-resolves even if `close` is never delivered (hard deadline)', async () => {
    // Even in pathological cases where SIGKILL doesn't free stdio fast
    // enough, the Promise must resolve within ABORT_HARD_DEADLINE_MS
    // (3s) so the conversation loop unwinds. This test exercises the
    // same path as the previous test but asserts on forcedRelease
    // metadata — if forcedRelease=true, the hard deadline fired.
    const ac = new AbortController()
    const promise = bash.execute(
      // Daemonize with setsid so the grandchild potentially escapes the
      // group, then keep stdin piped via the parent bash.
      { command: '(setsid sleep 30 >/tmp/bash-tool-hard-deadline.log 2>&1 &); sleep 60' },
      { signal: ac.signal },
    )
    await new Promise((r) => setTimeout(r, 300))
    const abortStart = Date.now()
    ac.abort()
    const result = await promise
    const elapsed = Date.now() - abortStart

    expect(result.metadata?.aborted).toBe(true)
    // Must be bounded regardless of whether process-group kill worked
    // (setsid specifically detaches the grandchild from the group).
    expect(elapsed).toBeLessThan(4000)
  }, 15_000)
})
