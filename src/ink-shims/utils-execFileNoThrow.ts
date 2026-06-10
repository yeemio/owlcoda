// Minimal execFileNoThrow — only used by termio/osc.ts for terminal queries
import { execFileSync } from 'child_process'

export async function execFileNoThrow(cmd: string, args: string[], options?: any): Promise<{ stdout: string; code: number | null }> {
  try {
    const stdout = execFileSync(cmd, args, { ...options, encoding: 'utf8', timeout: 5000 })
    return { stdout: String(stdout), code: 0 }
  } catch {
    return { stdout: '', code: 1 }
  }
}
