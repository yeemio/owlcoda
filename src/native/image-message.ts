import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  extname,
  isAbsolute,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveVisionCapability, type ModelIdentity, type ModelVisionCapability } from '../model-capabilities.js'
import type { AnthropicContentBlock, AnthropicImageBlock } from '../types.js'

export interface UserMessageImageOptions {
  cwd?: string
}

export interface UserMessageImageRoutingOptions extends UserMessageImageOptions {
  model?: ModelIdentity
  threadId?: string
  runId?: string
}

export type UserImageAttachmentStatus = 'attached' | 'blocked'

export interface UserImageAttachment {
  artifactId: string
  path: string
  mediaType: string
  size: number
  status: UserImageAttachmentStatus
  reason?: string
}

export interface UserMessageImageRoutingResult {
  blocks: AnthropicContentBlock[]
  attachments: UserImageAttachment[]
  capability?: ModelVisionCapability
}

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const SUPPORTED_IMAGE_EXTENSIONS = Object.keys(IMAGE_MEDIA_TYPES)

export function isSupportedImagePath(value: string): boolean {
  return SUPPORTED_IMAGE_EXTENSIONS.includes(extname(value).toLowerCase())
}

export function createUserMessageBlocksFromInput(
  text: string,
  options: UserMessageImageOptions = {},
): AnthropicContentBlock[] {
  return routeUserMessageImages(text, options).blocks
}

export function routeUserMessageImages(
  text: string,
  options: UserMessageImageRoutingOptions = {},
): UserMessageImageRoutingResult {
  const blocks: AnthropicContentBlock[] = [{ type: 'text', text }]
  const imagePaths = extractLocalImageReferences(text, options.cwd ?? process.cwd())
  if (imagePaths.length === 0) {
    return { blocks, attachments: [] }
  }

  const capability = options.model ? resolveVisionCapability(options.model) : undefined
  const canAttachImages = capability ? capability.inputImages : true
  const attachments = imagePaths.map((imagePath): UserImageAttachment => {
    const mediaType = mediaTypeForImagePath(imagePath)
    const size = statSync(imagePath).size
    return {
      artifactId: artifactIdForImagePath(imagePath),
      path: imagePath,
      mediaType,
      size,
      status: canAttachImages ? 'attached' : 'blocked',
      ...(canAttachImages ? {} : { reason: imageRoutingBlockReason(capability) }),
    }
  })

  if (canAttachImages) {
    for (const attachment of attachments) {
      blocks.push(createImageBlockFromPath(attachment.path))
    }
    return { blocks, attachments, capability }
  }

  blocks.push({
    type: 'text',
    text: formatImageRoutingWarning(attachments, capability, options.model),
  })
  return { blocks, attachments, capability }
}

export function createImageBlockFromPath(imagePath: string): AnthropicImageBlock {
  const mediaType = mediaTypeForImagePath(imagePath)
  const data = readFileSync(imagePath).toString('base64')
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType,
      data,
    },
  }
}

export function extractLocalImageReferences(text: string, cwd: string): string[] {
  const refs = new Set<string>()
  const add = (raw: string): void => {
    const imagePath = resolveLocalImageReference(raw, cwd)
    if (imagePath) refs.add(imagePath)
  }

  for (const match of text.matchAll(/!\[[^\]]*]\(([^)\n]+)\)/g)) {
    add(match[1] ?? '')
  }
  for (const match of text.matchAll(/\bfile:\/\/[^\s)\]}>"']+/g)) {
    add(match[0] ?? '')
  }
  for (const match of text.matchAll(/(["'`])([^"'`\n]+?\.(?:png|jpe?g|webp|gif))\1/gi)) {
    add(match[2] ?? '')
  }
  for (const match of text.matchAll(/(?:^|\s)@([^\s)\]}>,;:!?'"`]+?\.(?:png|jpe?g|webp|gif))(?=$|[\s)\]}>,;:!?])/gi)) {
    add(match[1] ?? '')
  }
  for (const match of text.matchAll(/(?:^|[\s([{<])((?:~|\.{1,2}|\/)[^\s)\]}>,;:!?'"`]+?\.(?:png|jpe?g|webp|gif))(?=$|[\s)\]}>,;:!?])/gi)) {
    add(match[1] ?? '')
  }

  return [...refs]
}

function mediaTypeForImagePath(imagePath: string): string {
  const ext = extname(imagePath).toLowerCase()
  const mediaType = IMAGE_MEDIA_TYPES[ext]
  if (!mediaType) {
    throw new Error(`Unsupported image type: ${imagePath}`)
  }
  return mediaType
}

function artifactIdForImagePath(imagePath: string): string {
  const stat = statSync(imagePath)
  const digest = createHash('sha1')
    .update(`${imagePath}\n${stat.size}\n${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 12)
  return `image-${digest}`
}

function imageRoutingBlockReason(capability: ModelVisionCapability | undefined): string {
  if (!capability) return 'model_capability_unavailable'
  if (capability.status === 'unsupported') return 'model_vision_unsupported'
  return 'model_vision_unknown'
}

function formatImageRoutingWarning(
  attachments: UserImageAttachment[],
  capability: ModelVisionCapability | undefined,
  model: ModelIdentity | undefined,
): string {
  const modelLabel = model?.id ?? model?.backendModel ?? model?.label ?? 'current model'
  const status = capability?.status ?? 'unknown'
  const source = capability?.source ?? 'unknown'
  const reason = capability?.reason ?? 'OwlCoda has not received a model capability declaration for image input.'
  const paths = attachments.map((attachment) => `- ${attachment.artifactId}: ${attachment.path}`).join('\n')
  return [
    '[OwlCoda image input not attached]',
    `Detected ${attachments.length} local image reference(s), but model "${modelLabel}" has vision=${status} (source=${source}).`,
    reason,
    'Switch to a vision-capable model or set supportsImages=true after a successful vision probe. Do not claim to have inspected these images in the final answer.',
    paths,
  ].join('\n')
}

function resolveLocalImageReference(raw: string, cwd: string): string | null {
  let value = raw.trim()
  if (!value) return null
  value = stripWrapping(value)
  if (/^https?:\/\//i.test(value)) return null

  let candidate: string
  try {
    candidate = value.startsWith('file://')
      ? fileURLToPath(value)
      : value
  } catch {
    return null
  }

  candidate = candidate.replace(/\\ /g, ' ')
  if (candidate.startsWith('~')) {
    candidate = `${homedir()}${candidate.slice(1)}`
  }
  if (!isAbsolute(candidate)) {
    candidate = resolve(cwd, candidate)
  }

  if (!isSupportedImagePath(candidate)) return null
  if (!existsSync(candidate)) return null

  try {
    const stat = statSync(candidate)
    if (!stat.isFile()) return null
  } catch {
    return null
  }

  return candidate
}

function stripWrapping(value: string): string {
  let out = value.trim()
  if (out.startsWith('<') && out.endsWith('>')) out = out.slice(1, -1)
  if ((out.startsWith('"') && out.endsWith('"'))
    || (out.startsWith("'") && out.endsWith("'"))
    || (out.startsWith('`') && out.endsWith('`'))) {
    out = out.slice(1, -1)
  }
  return out.trim()
}
