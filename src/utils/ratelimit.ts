import { ServerResponse } from 'node:http'

export function setRateLimitHeaders(res: ServerResponse): void {
  const now = Math.floor(Date.now() / 1000)
  res.setHeader('anthropic-ratelimit-unified-5h-utilization', '0')
  res.setHeader('anthropic-ratelimit-unified-5h-reset', String(now + 5 * 3600))
  res.setHeader('anthropic-ratelimit-unified-7d-utilization', '0')
  res.setHeader('anthropic-ratelimit-unified-7d-reset', String(now + 7 * 86400))
  res.setHeader('anthropic-ratelimit-unified-status', 'allowed')
}
