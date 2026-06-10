import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pexec = promisify(execFile)

/** Injectable git runner — returns stdout. Default shells out to `git`. */
export type GitRunner = (args: string[]) => Promise<string>

export const defaultGitRunner: GitRunner = async (args) => {
  const { stdout } = await pexec('git', args, { maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

export interface FetchSpec { url: string; ref: string; dest: string }
export interface FetchResult { pinnedRef: string }

/** Resolve `ref` to a commit SHA, then fetch that commit into `dest`. */
export async function resolveAndFetch(spec: FetchSpec, run: GitRunner = defaultGitRunner): Promise<FetchResult> {
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
