import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
const MEDIA_EXTENSIONS = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
])

export interface StoredAttachment {
  id: string
  name: string
  mediaType: string
  size: number
  path: string
}

export interface PublicStoredAttachment {
  id: string
  name: string
  mediaType: string
  size: number
}

export function storeAttachment(input: {
  projectRoot: string
  name: string
  mediaType: string
  dataBase64: string
}): StoredAttachment {
  const extension = MEDIA_EXTENSIONS.get(input.mediaType)
  if (!extension) throw new Error('Unsupported attachment media type')
  if (!isBase64(input.dataBase64)) throw new Error('Attachment data is not valid base64')
  const data = Buffer.from(input.dataBase64, 'base64')
  if (data.length === 0 || data.length > MAX_ATTACHMENT_BYTES) throw new Error('Attachment size is outside the supported range')
  const digest = createHash('sha256').update(input.mediaType).update('\0').update(data).digest('hex').slice(0, 24)
  const id = `attachment-${digest}`
  const directory = attachmentDirectory(input.projectRoot)
  const path = join(directory, `${id}${extension}`)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (!existsSync(path)) writeFileSync(path, data, { mode: 0o600 })
  return { id, name: safeName(input.name, extension), mediaType: input.mediaType, size: data.length, path }
}

export function loadAttachment(projectRoot: string, attachmentId: string): Omit<StoredAttachment, 'name'> | null {
  if (!/^attachment-[a-f0-9]{24}$/.test(attachmentId)) return null
  for (const [mediaType, extension] of MEDIA_EXTENSIONS) {
    const path = join(attachmentDirectory(projectRoot), `${attachmentId}${extension}`)
    if (!existsSync(path)) continue
    const stat = statSync(path)
    if (!stat.isFile()) return null
    return { id: attachmentId, mediaType, size: stat.size, path }
  }
  return null
}

export function publicAttachment(attachment: StoredAttachment): PublicStoredAttachment {
  return { id: attachment.id, name: attachment.name, mediaType: attachment.mediaType, size: attachment.size }
}

function isBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
}

function safeName(name: string, extension: string): string {
  const trimmed = name.trim().split(/[\\/]/).at(-1)?.slice(0, 160)
  return trimmed || `attachment${extension}`
}

function attachmentDirectory(projectRoot: string): string {
  const root = process.env['OWLCODA_HOME'] ?? join(homedir(), '.owlcoda')
  const workspace = createHash('sha256').update(realpathSync(projectRoot)).digest('hex').slice(0, 20)
  return join(root, 'app-server', 'attachments', workspace)
}
