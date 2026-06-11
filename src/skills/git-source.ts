import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pexec = promisify(execFile)

/** Injectable git runner — returns stdout. Default shells out to `git`. */
export type GitRunner = (args: string[]) => Promise<string>

export const defaultGitRunner: GitRunner = async (args) => {
  const { stdout } = await pexec('git', args, {
    maxBuffer: 64 * 1024 * 1024,
    // Defence-in-depth behind assertSafeGitUrl: restrict git to network
    // transports so remote-helper transports (ext::, fd::) can never run a
    // command even if a URL slips past the scheme check. Never prompt for
    // credentials — a third-party fetch must not hang waiting on a TTY.
    env: { ...process.env, GIT_ALLOW_PROTOCOL: 'https:http:ssh:git', GIT_TERMINAL_PROMPT: '0' },
  })
  return stdout
}

// git remote-helper transports `<transport>::<address>` (ext::, fd::, …) run
// arbitrary commands; a leading `-` is CLI-option injection. A third-party skill
// source must be a plain network URL — reject everything else before git runs.
const REMOTE_HELPER_TRANSPORT = /^[a-z][a-z0-9+.-]*::/i
const ALLOWED_URL_SCHEME = /^(https?|ssh|git):\/\//i
const SCP_LIKE_SSH = /^[^/@:]+@[^/@:]+:.+/

/** Throw if `url` is not a plain network git URL (blocks ext::/fd::/file://, flag injection). */
export function assertSafeGitUrl(url: string): void {
  const u = (url ?? '').trim()
  if (!u) throw new Error('git source URL is empty')
  if (u.startsWith('-')) throw new Error(`refusing git source URL that looks like a CLI flag: ${url}`)
  if (REMOTE_HELPER_TRANSPORT.test(u)) {
    throw new Error(`refusing git remote-helper transport (arbitrary-command risk): ${url}`)
  }
  if (!ALLOWED_URL_SCHEME.test(u) && !SCP_LIKE_SSH.test(u)) {
    throw new Error(`refusing git source URL with a disallowed scheme (allowed: https, http, ssh, git): ${url}`)
  }
}

export interface FetchSpec { url: string; ref: string; dest: string }
export interface FetchResult { pinnedRef: string }

/** Resolve `ref` to a commit SHA, then fetch that commit into `dest`. */
export async function resolveAndFetch(spec: FetchSpec, run: GitRunner = defaultGitRunner): Promise<FetchResult> {
  assertSafeGitUrl(spec.url)
  let pinnedRef = spec.ref
  if (!/^[0-9a-f]{40}$/i.test(spec.ref)) {
    const out = await run(['ls-remote', spec.url, spec.ref])
    const sha = out.split('\n').map(l => l.trim()).filter(Boolean)[0]?.split('\t')[0]
    if (!sha) throw new Error(`Could not resolve ref "${spec.ref}" at ${spec.url}`)
    pinnedRef = sha
  }
  await run(['clone', '--filter=blob:none', '--no-checkout', spec.url, spec.dest])
  await run(['-C', spec.dest, 'fetch', '--depth', '1', 'origin', pinnedRef])
  await run(['-C', spec.dest, 'checkout', pinnedRef])
  return { pinnedRef }
}
