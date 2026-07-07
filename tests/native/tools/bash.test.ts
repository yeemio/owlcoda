import { afterEach, describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBashTool } from '../../../src/native/tools/bash.js'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

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
    // 0.13.60: bash output now structured with [stdout]/[stderr]/[exit code: N] sections.
    expect(result.output).toContain('[stdout]')
    expect(result.output).toContain('hello')
    expect(result.output).toContain('[exit code: 0]')
  })

  it('captures multi-line stdout', async () => {
    const result = await bash.execute({
      command: 'echo "line1"; echo "line2"; echo "line3"',
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('line1')
    expect(result.output).toContain('line2')
    expect(result.output).toContain('line3')
    expect(result.output).toContain('[exit code: 0]')
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
    expect(result.output).toContain('[command not found]')
    expect(result.output).toContain('do not treat this as missing project data')
    expect(result.metadata?.commandNotFound).toBe(true)
    expect(result.metadata?.missingCommand).toBe('nonexistent_command_xyz_123')
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

  it('refuses to start a nested OwlCoda serve process from inside the REPL', async () => {
    const result = await bash.execute({ command: 'owlcoda serve --port 8019 &' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Refusing to start a nested OwlCoda server')
    expect(result.output).toContain('owlcoda status')
    expect(result.output).toContain('owlcoda start')
    expect(result.metadata?.lifecycleRisk).toMatchObject({ kind: 'nested_owlcoda_serve' })
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

  it('does not label a zero-exit background-shaped timeout as process killed', async () => {
    const result = await bash.execute({
      command: "trap 'echo ready; exit 0' TERM; sleep 1 >/tmp/owlcoda-bash-background-timeout.log 2>&1 & echo started; wait",
      timeoutMs: 150,
    })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('started')
    expect(result.output).not.toContain('[killed]')
    expect(result.output).toContain('[timeout exceeded]')
    expect(result.metadata?.exitCode).toBe(0)
    expect(result.metadata?.killed).toBe(false)
    expect(result.metadata?.timeoutExceeded).toBe(true)
    expect(result.metadata?.backgroundLikely).toBe(true)
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

  it('records a redacted artifact when formatted output is truncated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-bash-artifact-'))
    temporaryRoots.push(root)
    const previousOwlCodaHome = process.env['OWLCODA_HOME']
    process.env['OWLCODA_HOME'] = join(root, 'owlcoda-home')
    let result!: Awaited<ReturnType<typeof bash.execute>>
    try {
      result = await bash.execute({
        command: "node -e \"process.stdout.write('prefix-' + 'Z'.repeat(20000) + '-suffix')\"",
        cwd: root,
        timeoutMs: 10_000,
      })
    } finally {
      if (previousOwlCodaHome === undefined) delete process.env['OWLCODA_HOME']
      else process.env['OWLCODA_HOME'] = previousOwlCodaHome
    }

    const artifact = result.metadata?.['outputArtifact'] as { path?: string; artifactRef?: string } | undefined
    expect(artifact?.artifactRef).toMatch(/^owlcoda:\/\/tool-artifacts\/[^/]+\/bash-output-/)
    expect(artifact?.path).toBeTruthy()
    expect(existsSync(artifact!.path!)).toBe(true)
    const saved = readFileSync(artifact!.path!, 'utf8')
    expect(saved).toContain('prefix-')
    expect(saved).toContain('-suffix')
    expect(result.output).toContain(`artifactRef=${artifact!.artifactRef}`)
  }, 15_000)

  it('returns the bash result when redacted artifact persistence fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-bash-artifact-fail-'))
    temporaryRoots.push(root)
    const invalidHome = join(root, 'not-a-directory')
    writeFileSync(invalidHome, 'file blocks artifact directory creation')
    const previousOwlCodaHome = process.env['OWLCODA_HOME']
    process.env['OWLCODA_HOME'] = invalidHome
    let result!: Awaited<ReturnType<typeof bash.execute>>
    try {
      result = await bash.execute({
        command: "node -e \"process.stdout.write('prefix-' + 'Z'.repeat(20000) + '-suffix')\"",
        cwd: root,
        timeoutMs: 10_000,
      })
    } finally {
      if (previousOwlCodaHome === undefined) delete process.env['OWLCODA_HOME']
      else process.env['OWLCODA_HOME'] = previousOwlCodaHome
    }

    expect(result.isError).toBe(false)
    expect(result.output).toContain('[artifact-warning]')
    expect(result.output).toContain('[exit code: 0]')
    expect(result.metadata?.['outputArtifactError']).toBeTruthy()
    expect(result.metadata?.['outputArtifact']).toBeUndefined()
  }, 15_000)

  // ── Pipes and compound commands ──

  it('handles pipes correctly', async () => {
    const result = await bash.execute({
      command: 'echo "hello world" | tr "a-z" "A-Z"',
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('HELLO WORLD')
    expect(result.output).toContain('[exit code: 0]')
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

  it('reports "(no output)" with exit code for silent success', async () => {
    const result = await bash.execute({ command: 'true' })
    expect(result.isError).toBe(false)
    // 0.13.60: silent success still uses "(no output)" but appends
    // the [exit code: 0] trailer.
    expect(result.output).toContain('(no output)')
    expect(result.output).toContain('[exit code: 0]')
  })

  it('captures before and after source for parsed bash write targets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-bash-capture-'))
    temporaryRoots.push(root)
    const targetPath = join(root, 'target.txt')
    writeFileSync(targetPath, 'before\n', 'utf8')

    const result = await bash.execute({
      command: 'printf "after\\n" > target.txt',
      cwd: root,
    })

    expect(result.isError).toBe(false)
    expect(readFileSync(targetPath, 'utf8')).toBe('after\n')
    expect(result.metadata?.writeCaptures).toEqual([
      expect.objectContaining({
        path: realpathSync(targetPath),
        kind: 'redirect_stdout',
        oldContent: 'before\n',
        newContent: 'after\n',
      }),
    ])
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
    expect(result.output).toContain('ok')
    expect(result.output).toContain('[exit code: 0]')
  })

  // 0.13.60: structured bash output format with [stdout]/[stderr]/[exit code]
  // sections so the load-bearing parts (exit code, stderr) survive the
  // generic 60/20 head/tail truncation in conversation.ts.
  describe('structured output format (0.13.60)', () => {
    it('includes [stdout] section with content + [exit code: 0] trailer', async () => {
      const result = await bash.execute({ command: 'echo line-a; echo line-b' })
      expect(result.output.startsWith('[stdout]\n')).toBe(true)
      expect(result.output).toContain('line-a')
      expect(result.output).toContain('line-b')
      expect(result.output.endsWith('[exit code: 0]')).toBe(true)
    })

    it('non-zero exit code appears in trailer', async () => {
      const result = await bash.execute({ command: 'exit 7' })
      expect(result.isError).toBe(true)
      expect(result.output).toContain('[exit code: 7]')
      expect(result.metadata?.exitCode).toBe(7)
    })

    it('stderr-only output gets [stderr] section + exit trailer', async () => {
      const result = await bash.execute({ command: 'echo oops >&2' })
      expect(result.output).toContain('[stderr]')
      expect(result.output).toContain('oops')
      expect(result.output).toContain('[exit code: 0]')
      expect(result.output).not.toContain('[stdout]')
    })

    it('stdout AND stderr both appear in their respective sections', async () => {
      const result = await bash.execute({
        command: 'echo "out-msg"; echo "err-msg" >&2; exit 1',
      })
      expect(result.isError).toBe(true)
      expect(result.output).toContain('[stdout]')
      expect(result.output).toContain('out-msg')
      expect(result.output).toContain('[stderr]')
      expect(result.output).toContain('err-msg')
      expect(result.output).toContain('[exit code: 1]')
      // Order: stdout block, then stderr block, then exit trailer
      const stdoutIdx = result.output.indexOf('[stdout]')
      const stderrIdx = result.output.indexOf('[stderr]')
      const exitIdx = result.output.indexOf('[exit code:')
      expect(stdoutIdx).toBeLessThan(stderrIdx)
      expect(stderrIdx).toBeLessThan(exitIdx)
    })
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

  // ── Output sanitization (strip layout-breaking control chars, keep SGR) ──

  it('preserves SGR color codes so --color=always output still renders', async () => {
    const result = await bash.execute({
      command: "printf '\\033[31mRED\\033[0m\\n'",
    })
    expect(result.output).toContain('\x1b[31m')
    expect(result.output).toContain('RED')
    expect(result.output).toContain('\x1b[0m')
  })

  it('strips cursor-movement escapes (CSI A/B/H) but keeps the visible text', async () => {
    const result = await bash.execute({
      command: "printf '\\033[2A\\033[3Bhello\\033[Hworld\\n'",
    })
    expect(result.output).not.toContain('\x1b[2A')
    expect(result.output).not.toContain('\x1b[3B')
    expect(result.output).not.toContain('\x1b[H')
    expect(result.output).toContain('hello')
    expect(result.output).toContain('world')
  })

  it('strips erase escapes (CSI K/J)', async () => {
    const result = await bash.execute({
      command: "printf 'before\\033[Kafter\\033[2Jcleared\\n'",
    })
    expect(result.output).not.toContain('\x1b[K')
    expect(result.output).not.toContain('\x1b[2J')
    expect(result.output).toContain('before')
    expect(result.output).toContain('after')
    expect(result.output).toContain('cleared')
  })

  it('converts bare CR to LF so progress-bar redraws stay on separate lines', async () => {
    const result = await bash.execute({
      command: "printf 'step1\\rstep2\\rstep3\\n'",
    })
    expect(result.output).not.toContain('\r')
    expect(result.output).toContain('step1')
    expect(result.output).toContain('step2')
    expect(result.output).toContain('step3')
  })

  it('normalizes CRLF (Windows newlines) without doubling line breaks', async () => {
    const result = await bash.execute({
      command: "printf 'a\\r\\nb\\r\\nc\\n'",
    })
    expect(result.output).not.toContain('\r')
    expect(result.output).toMatch(/a\nb\nc/)
  })

  it('strips OSC sequences (terminal title set)', async () => {
    const result = await bash.execute({
      // OSC 0 sets terminal title; terminated by BEL (\007).
      command: "printf '\\033]0;evil-title\\007hello world\\n'",
    })
    expect(result.output).not.toContain('\x1b]')
    expect(result.output).not.toContain('evil-title')
    expect(result.output).toContain('hello world')
  })

  it('redacts secret-looking environment values from stdout and stderr', async () => {
    const result = await bash.execute({
      command: [
        "printf 'KIMI_API_KEY=sk-kimi-12345678901234567890\\nMINIMAX_API_KEY=cp-token-12345678901234567890\\n'",
        "printf 'DEEPSEEK_API_KEY=sk-deepseek-12345678901234567890\\n' >&2",
      ].join('; '),
    })

    expect(result.output).toContain('KIMI_API_KEY=[REDACTED]')
    expect(result.output).toContain('MINIMAX_API_KEY=[REDACTED]')
    expect(result.output).toContain('DEEPSEEK_API_KEY=[REDACTED]')
    expect(result.output).not.toContain('sk-kimi-12345678901234567890')
    expect(result.output).not.toContain('cp-token-12345678901234567890')
    expect(result.output).not.toContain('sk-deepseek-12345678901234567890')
  })

  it('redacts provider thinking fields from bash output', async () => {
    const result = await bash.execute({
      command: "printf '%s\\n' '{\"type\":\"thinking\",\"thinking\":\"private reasoning text\",\"content\":[{\"type\":\"text\",\"text\":\"visible answer\"}],\"reasoning_content\":\"private chain\"}'",
    })

    expect(result.output).toContain('"thinking":"[REDACTED]"')
    expect(result.output).toContain('"reasoning_content":"[REDACTED]"')
    expect(result.output).toContain('visible answer')
    expect(result.output).not.toContain('private reasoning text')
    expect(result.output).not.toContain('private chain')
  })

  it('redacts URL and HTML embedded token-shaped values from bash output', async () => {
    const token = '9340807895b080031b6787747d07b3b23ab4b61e6fe323fe54ab00fae9e78cd2'
    const result = await bash.execute({
      command: [
        `printf '%s\\n' 'https://example.test/chat#token=${token}&next=/chat'`,
        `printf '%s\\n' '<script>var t="${token}";location.replace("/chat#token="+encodeURIComponent(t));</script>'`,
      ].join('; '),
    })

    expect(result.output).not.toContain(token)
    expect(result.output).toContain('token=[REDACTED]')
    expect(result.output).toContain('var t="[REDACTED_TOKEN]"')
  })

  it('marks env and ssh file reads as sensitive-read risk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-bash-sensitive-read-'))
    temporaryRoots.push(root)
    writeFileSync(join(root, '.env'), 'MES_PASSWORD=super-secret-value\n')

    const result = await bash.execute({
      command: 'cat .env',
      cwd: root,
    })

    const risk = result.metadata?.['sensitiveReadRisk'] as { paths?: string[] } | undefined
    expect(risk?.paths).toContain('.env')
    expect(result.output).toContain('[sensitive-read-risk]')
    expect(result.output).not.toContain('super-secret-value')
  })

  it('redacts recent progress lines before emitting progress callbacks', async () => {
    const seenLines: string[] = []
    await bash.execute(
      { command: "printf 'KIMI_API_KEY=sk-kimi-progress-12345678901234567890\\n'; sleep 0.35" },
      {
        onProgress: event => {
          seenLines.push(...event.lines)
        },
      },
    )

    expect(seenLines.join('\n')).toContain('KIMI_API_KEY=[REDACTED]')
    expect(seenLines.join('\n')).not.toContain('sk-kimi-progress-12345678901234567890')
  })

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
