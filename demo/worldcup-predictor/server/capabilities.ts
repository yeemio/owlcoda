// T1: probe each model for vision capability with a 1px image request.
// Results cached in-process (TTL 1h). A probe failure marks vision=false
// when the upstream clearly rejects images, null when inconclusive.
import { listModels } from './owlcoda.js'

// 1x1 red PNG
const PROBE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

export interface ModelCapability {
  vision: boolean | null
  checkedAt: string
}

const cache = new Map<string, { caps: ModelCapability; expires: number }>()
const TTL_MS = 60 * 60 * 1000

async function probeVision(baseUrl: string, model: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'local', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '这张图片的主色是什么?只回答颜色名,例如:红色。看不到图片就回答:无图。' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PROBE_PNG } },
            ],
          },
        ],
      }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      // Upstreams reject vision in many shapes: "image input", "must not be
      // empty" (image block stripped leaving nothing), 404 "no endpoints".
      if (/image|vision|multimodal|empty|endpoint/i.test(detail)) return false
      return null
    }
    // A 200 alone is not proof — some endpoints silently strip image blocks.
    // Only count it as vision if the model actually perceived the red pixel.
    const body = (await res.json().catch(() => null)) as {
      content?: Array<{ type: string; text?: string; thinking?: string }>
    } | null
    // thinking models may spend the budget reasoning — count those blocks too
    const answer = (body?.content ?? []).map((b) => (b.text ?? '') + (b.thinking ?? '')).join('')
    if (/红|red/i.test(answer)) return true
    if (/无图|看不到|没有图|cannot|unable|no image/i.test(answer)) return false
    return null
  } catch {
    return null
  }
}

export async function getCapabilities(baseUrl: string): Promise<Record<string, ModelCapability>> {
  const models = await listModels(baseUrl)
  const now = Date.now()
  const out: Record<string, ModelCapability> = {}
  await Promise.all(
    models.map(async (m) => {
      const key = `${baseUrl}::${m.id}`
      const hit = cache.get(key)
      if (hit && hit.expires > now) {
        out[m.id] = hit.caps
        return
      }
      const vision = await probeVision(baseUrl, m.id)
      const caps: ModelCapability = { vision, checkedAt: new Date().toISOString() }
      // don't cache inconclusive results so transient errors retry
      if (vision !== null) cache.set(key, { caps, expires: now + TTL_MS })
      out[m.id] = caps
    }),
  )
  return out
}
