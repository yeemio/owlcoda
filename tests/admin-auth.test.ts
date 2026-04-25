import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverSource = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf-8')

describe('Admin endpoint auth', () => {
  // Post-0.12.16 the admin gate is:
  //   - always-on for every /admin/* data route (static assets already
  //     short-circuited earlier by handleAdminStatic)
  //   - delegates to AdminAuthManager.authenticate(), which accepts an
  //     explicit Authorization: Bearer <adminToken>, the deterministic
  //     fallback bearer `owlcoda-local-key-${port}`, OR a session cookie
  //     minted via one-shot-token exchange
  //   - returns 401/403 with the manager's reported {status, code, message}
  // The "if (config.adminToken) { Bearer check }" pattern this test suite
  // used to pin against has been deleted — it was the bug (open access
  // when adminToken was unset). Tests updated to pin the new contract.

  it('guards /admin/ prefix', () => {
    expect(serverSource).toContain("url.startsWith('/admin/')")
  })

  it('delegates to AdminAuthManager rather than inline Bearer-string compare', () => {
    expect(serverSource).toContain('adminApiDeps.auth.authenticate(req)')
  })

  it('always runs the auth gate for /admin/ routes', () => {
    // Regression: the old `if (config.adminToken) {...}` pattern silently
    // bypassed auth when no token was configured. The new gate must run
    // unconditionally; assert the config.adminToken-gated branch is gone.
    expect(serverSource).not.toMatch(/if \(config\.adminToken\) \{\s*\n\s*const auth = req\.headers\['authorization'\]/)
  })

  it('surfaces 401 / authentication_error on failure', () => {
    expect(serverSource).toContain('401')
    expect(serverSource).toContain('authentication_error')
  })
})
