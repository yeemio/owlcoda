import { afterEach, describe, it, expect } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { buildBashExecutionEnv, createBashTool, resolveInterpreterFallback } from '../../../src/native/tools/bash.js'

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

  it('treats a clean git diff --no-index --check difference as semantic success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-bash-diff-check-'))
    temporaryRoots.push(root)
    writeFileSync(join(root, 'empty'), '')
    writeFileSync(join(root, 'artifact.md'), '# clean\n')

    const result = await bash.execute({
      command: 'git diff --no-index --check empty artifact.md',
      cwd: root,
    })

    expect(result.isError).toBe(false)
    expect(result.metadata).toMatchObject({
      exitCode: 1,
      semanticSuccess: true,
      commandResultSemantics: 'git_diff_no_index_check',
    })
    expect(result.output).toContain('[semantic success: no whitespace errors]')
  })

  it('keeps git diff --no-index --check whitespace diagnostics as a failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-bash-diff-check-bad-'))
    temporaryRoots.push(root)
    writeFileSync(join(root, 'empty'), '')
    writeFileSync(join(root, 'artifact.md'), '# bad  \n')

    const result = await bash.execute({
      command: 'git diff --no-index --check empty artifact.md',
      cwd: root,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('trailing whitespace')
    expect(result.metadata?.semanticSuccess).not.toBe(true)
  })

  it('does not apply diff-check semantic success to compound shell commands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-bash-diff-check-compound-'))
    temporaryRoots.push(root)
    writeFileSync(join(root, 'empty'), '')
    writeFileSync(join(root, 'artifact.md'), '# clean\n')

    const result = await bash.execute({
      command: 'false; git diff --no-index --check empty artifact.md',
      cwd: root,
    })

    expect(result.isError).toBe(true)
    expect(result.metadata?.semanticSuccess).not.toBe(true)
  })

  it('does not accept diff-check semantic success when quiet mode suppresses diagnostics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-bash-diff-check-quiet-'))
    temporaryRoots.push(root)
    writeFileSync(join(root, 'empty'), '')
    writeFileSync(join(root, 'artifact.md'), '# bad  \n')

    const result = await bash.execute({
      command: 'git diff --no-index --check --quiet empty artifact.md',
      cwd: root,
    })

    expect(result.isError).toBe(true)
    expect(result.metadata?.semanticSuccess).not.toBe(true)
  })

  it('falls back only for a leading python command when python is absent and python3 is executable', () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-python-fallback-'))
    temporaryRoots.push(root)
    const python3 = join(root, 'python3')
    writeFileSync(python3, '#!/bin/sh\nexit 0\n')
    chmodSync(python3, 0o755)

    expect(resolveInterpreterFallback('python -m pytest', { PATH: root })).toEqual({
      command: 'python3 -m pytest',
      fallback: { requested: 'python', applied: 'python3' },
    })
    expect(resolveInterpreterFallback('echo python', { PATH: root })).toEqual({ command: 'echo python' })
  })

  it('records requested and applied commands when Bash uses python3 fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-python-fallback-run-'))
    temporaryRoots.push(root)
    const bin = join(root, 'bin')
    mkdirSync(bin)
    symlinkSync('/bin/bash', join(bin, 'bash'))
    writeFileSync(join(bin, 'python3'), '#!/bin/sh\necho fallback-ran\n')
    chmodSync(join(bin, 'python3'), 0o755)
    const previousPath = process.env.PATH
    process.env.PATH = bin
    try {
      const result = await bash.execute({ command: 'python --version', cwd: root })
      expect(result.isError).toBe(false)
      expect(result.output).toContain('fallback-ran')
      expect(result.metadata).toMatchObject({
        interpreterFallback: { requested: 'python', applied: 'python3' },
        requestedCommand: 'python --version',
        appliedCommand: 'python3 --version',
      })
    } finally {
      process.env.PATH = previousPath
    }
  })

  it('quarantines every incompatible CommonJS .js file created in one Bash call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-module-quarantine-'))
    temporaryRoots.push(root)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    const previousRecovery = process.env.OWLCODA_RECOVERY_DIR
    process.env.OWLCODA_RECOVERY_DIR = join(root, 'recovery')
    try {
      const result = await bash.execute({
        command: "printf 'module.exports = {};\\n' > first.js; printf 'const x = require(\\\"x\\\");\\n' > second.js",
        cwd: root,
      })

      expect(result.isError).toBe(true)
      expect(existsSync(join(root, 'first.js'))).toBe(false)
      expect(existsSync(join(root, 'second.js'))).toBe(false)
      const mismatches = result.metadata?.scriptModuleMismatches as Array<Record<string, string>>
      expect(mismatches).toHaveLength(2)
      expect(mismatches.every(item => existsSync(item.quarantinePath))).toBe(true)
    } finally {
      if (previousRecovery === undefined) delete process.env.OWLCODA_RECOVERY_DIR
      else process.env.OWLCODA_RECOVERY_DIR = previousRecovery
    }
  })

  it('reports failure for command not found', async () => {
    const result = await bash.execute({
      command: 'nonexistent_command_xyz_123',
    })
    expect(result.isError).toBe(true)
    expect(result.metadata?.exitCode).not.toBe(0)
    expect(result.metadata?.commandNotFound).toBe(true)
    expect(result.metadata?.missingCommand).toBe('nonexistent_command_xyz_123')
    expect(result.output).toContain('[command not found]')
    expect(result.output).toContain('Use an installed fallback')
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

  it('does not label a zero-exit background-shaped timeout as process killed', async () => {
    const result = await bash.execute({
      command: "trap 'echo ready; exit 0' TERM; sleep 1 >/tmp/owlcoda-bash-background-timeout.log 2>&1 & echo started; wait",
      timeoutMs: 250,
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

  it('adds existing bundled tool directories to PATH without dropping the original PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-bash-env-'))
    temporaryRoots.push(root)
    const env = buildBashExecutionEnv({ PATH: '/usr/bin', HOME: '/tmp' }, [root, join(root, 'missing')])
    const entries = env.PATH?.split(delimiter) ?? []
    expect(entries).toContain('/usr/bin')
    expect(entries).toContain(root)
    expect(entries).not.toContain(join(root, 'missing'))
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

  it('refuses cross-workspace node_modules symlink creation by default', async () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-bash-symlink-root-'))
    const outsideRoot = mkdtempSync(join(tmpdir(), 'owlcoda-bash-symlink-outside-'))
    temporaryRoots.push(root, outsideRoot)
    const outsideNodeModules = join(outsideRoot, 'node_modules')
    mkdirSync(outsideNodeModules)

    const result = await bash.execute({
      command: `ln -s ${outsideNodeModules} node_modules`,
      cwd: root,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('cross-workspace symlink')
    expect(result.metadata).toMatchObject({
      symlinkPolicyDenied: true,
      failureCategory: 'bash:cross_workspace_symlink',
    })
    expect(existsSync(join(root, 'node_modules'))).toBe(false)
  })

  it.each([
    ['pipeline stage', (source: string) => `printf x | ln -s ${source} node_modules`],
    ['command wrapper', (source: string) => `command ln -s ${source} node_modules`],
    ['GNU long option', (source: string) => `ln --symbolic ${source} node_modules`],
    ['env wrapper', (source: string) => `env ln -s ${source} node_modules`],
    ['env unset wrapper', (source: string) => `env -u PWD ln -s ${source} node_modules`],
    ['GNU env long option', (source: string) => `env --ignore-environment ln -s ${source} node_modules`],
    ['leading environment assignment', (source: string) => `OWLCODA_TEST=1 ln -s ${source} node_modules`],
    ['newline-separated stage', (source: string) => `printf x\nln -s ${source} node_modules`],
    ['nested bash command', (source: string) => `bash -c 'ln -s ${source} node_modules'`],
    ['nested sh login command', (source: string) => `sh -lc 'ln -s ${source} node_modules'`],
  ])('refuses a cross-workspace node_modules symlink behind a %s', async (_label, commandForSource) => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-bash-symlink-bypass-root-'))
    const outsideRoot = mkdtempSync(join(tmpdir(), 'owlcoda-bash-symlink-bypass-outside-'))
    temporaryRoots.push(root, outsideRoot)
    const outsideNodeModules = join(outsideRoot, 'node_modules')
    mkdirSync(outsideNodeModules)

    const result = await bash.execute({
      command: commandForSource(outsideNodeModules),
      cwd: root,
    })

    expect(result.isError).toBe(true)
    expect(result.metadata).toMatchObject({
      symlinkPolicyDenied: true,
      failureCategory: 'bash:cross_workspace_symlink',
    })
    expect(existsSync(join(root, 'node_modules'))).toBe(false)
  })

  it('allows symlinks whose source and destination are both inside the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-bash-symlink-local-'))
    temporaryRoots.push(root)
    mkdirSync(join(root, 'packages', 'shared'), { recursive: true })

    const result = await bash.execute({
      command: 'ln -s packages/shared node_modules',
      cwd: root,
    })

    expect(result.isError).toBe(false)
    expect(realpathSync(join(root, 'node_modules'))).toBe(realpathSync(join(root, 'packages', 'shared')))
  })

  it('fails closed when a symlink operand uses shell expansion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-bash-symlink-expansion-'))
    temporaryRoots.push(root)

    const result = await bash.execute({
      command: 'ln -s "$HOME/node_modules" node_modules',
      cwd: root,
    })

    expect(result.isError).toBe(true)
    expect(result.metadata).toMatchObject({
      symlinkPolicyDenied: true,
      failureCategory: 'bash:cross_workspace_symlink',
    })
    expect(existsSync(join(root, 'node_modules'))).toBe(false)
  })

  it('allows append redirects without destructive overwrite approval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-bash-append-'))
    temporaryRoots.push(root)
    const targetPath = join(root, 'target.txt')
    writeFileSync(targetPath, `${'before\n'.repeat(200)}`, 'utf8')

    const result = await bash.execute({ command: 'printf "after\\n" >> target.txt', cwd: root })

    expect(result.isError).toBe(false)
    expect(readFileSync(targetPath, 'utf8')).toContain('after\n')
  })

  it.each([
    ['ordinary redirect', 'printf "short\\n" > target.txt'],
    ['force redirect', 'printf "short\\n" >| target.txt'],
    ['heredoc redirect', 'cat <<EOF > target.txt\nshort\nEOF'],
  ])('refuses a destructive %s before executing', async (_label, command) => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-bash-destructive-'))
    temporaryRoots.push(root)
    const targetPath = join(root, 'target.txt')
    const original = 'before\n'.repeat(3000)
    writeFileSync(targetPath, original, 'utf8')

    const result = await bash.execute({ command, cwd: root })

    expect(result.isError).toBe(true)
    expect(result.metadata?.destructiveOverwriteDenied).toBe(true)
    expect(readFileSync(targetPath, 'utf8')).toBe(original)
  })

  it('refuses truncating a high-line-count text file even when it is below the byte threshold', async () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-bash-lines-'))
    temporaryRoots.push(root)
    const targetPath = join(root, 'target.txt')
    const original = 'x\n'.repeat(120)
    writeFileSync(targetPath, original, 'utf8')

    const result = await bash.execute({ command: 'printf "short\\n" > target.txt', cwd: root })

    expect(result.isError).toBe(true)
    expect(readFileSync(targetPath, 'utf8')).toBe(original)
  })

  it('snapshots an allowed Bash overwrite as exact raw bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-bash-snapshot-'))
    temporaryRoots.push(root)
    const targetPath = join(root, 'target.bin')
    const recoveryRoot = join(root, 'recovery')
    const original = Buffer.concat([Buffer.from([0xff, 0x00, 0xfe]), Buffer.alloc(20 * 1024, 0x91)])
    writeFileSync(targetPath, original)
    const previousRecovery = process.env['OWLCODA_RECOVERY_DIR']
    process.env['OWLCODA_RECOVERY_DIR'] = recoveryRoot
    try {
      const result = await bash.execute({
        command: 'printf "replacement\\n" > target.bin',
        cwd: root,
        allowDestructiveOverwrite: true,
      })

      expect(result.isError).toBe(false)
      const snapshots = result.metadata?.recoverySnapshots as Array<{ snapshotPath: string }>
      expect(snapshots).toHaveLength(1)
      expect(readFileSync(snapshots[0].snapshotPath)).toEqual(original)
    } finally {
      if (previousRecovery === undefined) delete process.env['OWLCODA_RECOVERY_DIR']
      else process.env['OWLCODA_RECOVERY_DIR'] = previousRecovery
    }
  })

  it('does not treat a literal greater-than sign in a heredoc body as another target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-bash-heredoc-body-'))
    temporaryRoots.push(root)
    const result = await bash.execute({
      command: 'cat <<EOF > output.txt\nbody > not-a-target.txt\nEOF',
      cwd: root,
    })

    expect(result.isError).toBe(false)
    expect(readFileSync(join(root, 'output.txt'), 'utf8')).toBe('body > not-a-target.txt\n')
    expect(result.metadata?.writeCaptures).toHaveLength(1)
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
