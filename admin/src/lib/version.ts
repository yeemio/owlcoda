/**
 * Admin display version surfaced in the header chrome.
 *
 * Hardcoded to keep the admin bundle decoupled from package.json reads at
 * runtime. The companion test `admin/tests/version-sync.test.ts` asserts this
 * literal equals the root `package.json#version` on every CI run, so a forgotten
 * bump can't silently ship a stale version label to Admin users.
 */
export const ADMIN_DISPLAY_VERSION = '0.15.0'
