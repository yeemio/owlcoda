/**
 * PII sanitizer — removes sensitive data from training content.
 *
 * Strips or replaces:
 * - API keys and tokens (Bearer, sk-*, ghp_*, etc.)
 * - Email addresses
 * - Absolute file paths containing usernames
 * - IP addresses (v4)
 * - URLs with auth tokens
 * - Environment variable values that look like secrets
 *
 * Zero external dependencies.
 */

// ─── Types ───

export interface SanitizeResult {
  text: string
  replacements: number
  types: string[]
}

export interface SanitizeOptions {
  /** Replace paths containing home dir (default: true) */
  sanitizePaths?: boolean
  /** Replace email addresses (default: true) */
  sanitizeEmails?: boolean
  /** Replace API keys/tokens (default: true) */
  sanitizeKeys?: boolean
  /** Replace IP addresses (default: true) */
  sanitizeIPs?: boolean
}

// ─── Patterns ───

// API keys and tokens — common prefixes
const KEY_PATTERNS = [
  /\b(sk-[a-zA-Z0-9]{20,})\b/g,                    // OpenAI
  /\b(ghp_[a-zA-Z0-9]{36,})\b/g,                    // GitHub PAT
  /\b(gho_[a-zA-Z0-9]{36,})\b/g,                    // GitHub OAuth
  /\b(github_pat_[a-zA-Z0-9_]{22,})\b/g,            // GitHub fine-grained
  /\b(glpat-[a-zA-Z0-9\-_]{20,})\b/g,               // GitLab
  /\b(xoxb-[a-zA-Z0-9\-]{20,})\b/g,                 // Slack bot
  /\b(xoxp-[a-zA-Z0-9\-]{20,})\b/g,                 // Slack user
  /\b(AKIA[A-Z0-9]{16})\b/g,                         // AWS access key
  /Bearer\s+([a-zA-Z0-9\-._~+\/]{20,}={0,2})/g,     // Bearer tokens
  /\b(eyJ[a-zA-Z0-9\-_]{30,}\.[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]*)\b/g, // JWT
]

// Email addresses
const EMAIL_PATTERN = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g

// IPv4 addresses (not localhost)
const IPV4_PATTERN = /\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g

// Home dir paths — /Users/xxx or /home/xxx
const HOME_PATH_PATTERN = /(?:\/Users\/|\/home\/)[a-zA-Z0-9._\-]+/g

// URLs with auth params
const AUTH_URL_PATTERN = /(?:token|key|secret|password|auth)=([a-zA-Z0-9\-._~+\/]{8,})/gi

// ─── Core ───

export function sanitizeText(text: string, options: SanitizeOptions = {}): SanitizeResult {
  const {
    sanitizePaths = true,
    sanitizeEmails = true,
    sanitizeKeys = true,
    sanitizeIPs = true,
  } = options

  let result = text
  let replacements = 0
  const types: Set<string> = new Set()

  // API keys/tokens
  if (sanitizeKeys) {
    for (const pattern of KEY_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags)
      const matches = result.match(re)
      if (matches) {
        result = result.replace(re, (match) => {
          // Keep prefix for context
          if (match.startsWith('Bearer ')) return 'Bearer [REDACTED]'
          const prefix = match.slice(0, Math.min(4, match.length))
          return `${prefix}[REDACTED]`
        })
        replacements += matches.length
        types.add('api_key')
      }
    }

    // Auth URL params
    const authMatches = result.match(AUTH_URL_PATTERN)
    if (authMatches) {
      result = result.replace(AUTH_URL_PATTERN, (match, _value) => {
        const eqIdx = match.indexOf('=')
        return match.slice(0, eqIdx + 1) + '[REDACTED]'
      })
      replacements += authMatches.length
      types.add('auth_param')
    }
  }

  // Email addresses
  if (sanitizeEmails) {
    const emailMatches = result.match(EMAIL_PATTERN)
    if (emailMatches) {
      result = result.replace(EMAIL_PATTERN, '[EMAIL]')
      replacements += emailMatches.length
      types.add('email')
    }
  }

  // Home paths
  if (sanitizePaths) {
    const pathMatches = result.match(HOME_PATH_PATTERN)
    if (pathMatches) {
      result = result.replace(HOME_PATH_PATTERN, '/home/[USER]')
      replacements += pathMatches.length
      types.add('path')
    }
  }

  // IP addresses
  if (sanitizeIPs) {
    const ipMatches = result.match(IPV4_PATTERN)
    if (ipMatches) {
      // Verify they look like real IPs (octets 0-255)
      result = result.replace(IPV4_PATTERN, (match) => {
        const parts = match.split('.').map(Number)
        if (parts.every(p => p >= 0 && p <= 255)) {
          replacements++
          types.add('ip_address')
          return '[IP]'
        }
        return match
      })
    }
  }

  return {
    text: result,
    replacements,
    types: [...types],
  }
}

/**
 * Sanitize a full JSONL messages array in place.
 */
export function sanitizeMessages(messages: Array<{ role: string; content: unknown }>): { messages: typeof messages; totalReplacements: number } {
  let total = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      const result = sanitizeText(msg.content)
      msg.content = result.text
      total += result.replacements
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (typeof block.text === 'string') {
          const result = sanitizeText(block.text)
          block.text = result.text
          total += result.replacements
        }
      }
    }
  }
  return { messages, totalReplacements: total }
}
