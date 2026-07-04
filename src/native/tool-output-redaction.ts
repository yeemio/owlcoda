const SENSITIVE_ENV_NAME_RE = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CLIENT_KEY|ACCESS_KEY|PRIVATE_KEY|KEY)(?:_|$)/

function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV_NAME_RE.test(name.toUpperCase())
}

function quoteFor(value: string): '"' | '\'' | '' {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value[0] as '"' | '\''
  }
  return ''
}

export function redactToolOutput(text: string): string {
  let out = text

  out = out.replace(
    /([?#&](?:access_token|auth_token|token|api_key|client_key|secret|password|key)=)([^&\s"'<>]+)/gi,
    '$1[REDACTED]',
  )

  out = out.replace(
    /(^|[^#?&/A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s\n]+)/g,
    (match, prefix: string, name: string, separator: string, value: string) => {
      if (!isSensitiveEnvName(name)) return match
      const quote = quoteFor(value)
      return `${prefix}${name}${separator}${quote}[REDACTED]${quote}`
    },
  )

  out = out.replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]{20,}={0,2}/gi, '$1[REDACTED]')
  out = out.replace(/\bsk-[A-Za-z0-9._-]{16,}\b/g, 'sk-[REDACTED]')
  out = out.replace(/\b(?:ghp_|gho_|glpat-|github_pat_)[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_TOKEN]')
  out = out.replace(/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]')
  out = out.replace(/\beyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\b/g, '[REDACTED_JWT]')
  out = out.replace(/\b[0-9a-f]{48,}\b/gi, '[REDACTED_TOKEN]')

  out = out.replace(/"(thinking|reasoning_content)"\s*:\s*"(?:[^"\\]|\\.)*"/g, '"$1":"[REDACTED]"')
  out = out.replace(/'(thinking|reasoning_content)'\s*:\s*'(?:[^'\\]|\\.)*'/g, "'$1':'[REDACTED]'")

  return out
}
