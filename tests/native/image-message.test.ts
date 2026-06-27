import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addUserMessage, createConversation } from '../../src/native/conversation.js'
import {
  createUserMessageBlocksFromInput,
  isSupportedImagePath,
  routeUserMessageImages,
} from '../../src/native/image-message.js'

describe('native image message input', () => {
  it('detects supported image path extensions', () => {
    expect(isSupportedImagePath('/tmp/screen.png')).toBe(true)
    expect(isSupportedImagePath('/tmp/photo.jpeg')).toBe(true)
    expect(isSupportedImagePath('/tmp/clip.webp')).toBe(true)
    expect(isSupportedImagePath('/tmp/file.txt')).toBe(false)
  })

  it('turns pasted image paths into text plus image content blocks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-image-message-'))
    const imagePath = join(dir, 'shot.png')
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const blocks = createUserMessageBlocksFromInput(`please inspect ${imagePath}`)

    expect(blocks).toEqual([
      { type: 'text', text: `please inspect ${imagePath}` },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
        },
      },
    ])
  })

  it('supports relative Markdown image references', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-image-markdown-'))
    await writeFile(join(dir, 'diagram.webp'), Buffer.from('webp-bytes'))

    const blocks = createUserMessageBlocksFromInput('看一下这张图 ![diagram](./diagram.webp)', { cwd: dir })

    expect(blocks).toEqual([
      { type: 'text', text: '看一下这张图 ![diagram](./diagram.webp)' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/webp',
          data: Buffer.from('webp-bytes').toString('base64'),
        },
      },
    ])
  })

  it('supports @ file references inserted by the TUI picker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-image-at-ref-'))
    await writeFile(join(dir, 'chart.jpg'), Buffer.from('jpeg-bytes'))

    const blocks = createUserMessageBlocksFromInput('解释 @chart.jpg', { cwd: dir })

    expect(blocks[1]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: Buffer.from('jpeg-bytes').toString('base64'),
      },
    })
  })

  it('routes images for a non-Kimi model that declares vision support', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-image-custom-vision-'))
    const imagePath = join(dir, 'custom.png')
    await writeFile(imagePath, Buffer.from('custom-vision-bytes'))

    const routed = routeUserMessageImages(`inspect ${imagePath}`, {
      model: {
        id: 'private-vl-model',
        backendModel: 'private-vl-model',
        provider: 'openai-compat',
        supportsImages: true,
      },
    })

    expect(routed.capability).toMatchObject({
      status: 'supported',
      source: 'configured',
      inputImages: true,
    })
    expect(routed.attachments).toEqual([
      expect.objectContaining({
        path: imagePath,
        mediaType: 'image/png',
        status: 'attached',
      }),
    ])
    expect(routed.blocks).toEqual([
      { type: 'text', text: `inspect ${imagePath}` },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: Buffer.from('custom-vision-bytes').toString('base64'),
        },
      },
    ])
  })

  it('blocks image attachment with an explicit warning for unsupported models', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-image-unsupported-'))
    const imagePath = join(dir, 'diagram.png')
    await writeFile(imagePath, Buffer.from('diagram-bytes'))

    const routed = routeUserMessageImages(`inspect ${imagePath}`, {
      model: {
        id: 'text-only-model',
        backendModel: 'text-only-model',
        supportsImages: false,
      },
    })

    expect(routed.capability).toMatchObject({
      status: 'unsupported',
      source: 'configured',
      inputImages: false,
    })
    expect(routed.attachments).toEqual([
      expect.objectContaining({
        path: imagePath,
        mediaType: 'image/png',
        status: 'blocked',
        reason: 'model_vision_unsupported',
      }),
    ])
    expect(routed.blocks).toHaveLength(2)
    expect(routed.blocks[0]).toEqual({ type: 'text', text: `inspect ${imagePath}` })
    expect(routed.blocks[1]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('vision=unsupported'),
    })
    expect(routed.blocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image' }),
    ]))
  })

  it('blocks image attachment with an explicit warning for unknown model vision capability', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-image-unknown-'))
    const imagePath = join(dir, 'unknown.webp')
    await writeFile(imagePath, Buffer.from('unknown-bytes'))

    const routed = routeUserMessageImages(`inspect ${imagePath}`, {
      model: {
        id: 'unverified-model',
        backendModel: 'unverified-model',
      },
    })

    expect(routed.capability).toMatchObject({
      status: 'unknown',
      source: 'unknown',
      inputImages: false,
    })
    expect(routed.attachments[0]).toMatchObject({
      status: 'blocked',
      reason: 'model_vision_unknown',
    })
    expect(routed.blocks[1]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Do not claim to have inspected these images'),
    })
  })

  it('lets addUserMessage attach images from pasted text paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-image-add-user-'))
    const imagePath = join(dir, 'paste.gif')
    await writeFile(imagePath, Buffer.from('gif-bytes'))
    const conversation = createConversation({ model: 'kimi-k2.7-code' })

    addUserMessage(conversation, `识别 ${imagePath}`)

    expect(conversation.turns.at(-1)?.content).toEqual([
      { type: 'text', text: `识别 ${imagePath}` },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/gif',
          data: Buffer.from('gif-bytes').toString('base64'),
        },
      },
    ])
  })

  it('lets addUserMessage attach images for configured non-Kimi vision models and records runtime truth', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-image-add-custom-'))
    const imagePath = join(dir, 'paste.png')
    await writeFile(imagePath, Buffer.from('custom-add-bytes'))
    const conversation = createConversation({
      model: 'private-vl-model',
      modelIdentity: {
        id: 'private-vl-model',
        backendModel: 'private-vl-model',
        supportsImages: true,
      },
    })

    addUserMessage(conversation, `识别 ${imagePath}`)

    expect(conversation.turns.at(-1)?.content).toEqual([
      { type: 'text', text: `识别 ${imagePath}` },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: Buffer.from('custom-add-bytes').toString('base64'),
        },
      },
    ])
    expect(conversation.options?.runtimeEventLog?.events.at(-1)).toMatchObject({
      kind: 'runtime_intervention',
      threadId: conversation.id,
      payload: {
        intervention_kind: 'image_input_routed',
        model: 'private-vl-model',
        vision_status: 'supported',
        vision_source: 'configured',
        attached_count: 1,
        blocked_count: 0,
      },
    })
  })

  it('lets addUserMessage block unknown model images without pretending they were seen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-image-add-unknown-'))
    const imagePath = join(dir, 'paste.png')
    await writeFile(imagePath, Buffer.from('unknown-add-bytes'))
    const conversation = createConversation({ model: 'unknown-text-model' })

    addUserMessage(conversation, `识别 ${imagePath}`)

    expect(conversation.turns.at(-1)?.content).toEqual([
      { type: 'text', text: `识别 ${imagePath}` },
      {
        type: 'text',
        text: expect.stringContaining('vision=unknown'),
      },
    ])
    expect(conversation.turns.at(-1)?.content).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image' }),
    ]))
    expect(conversation.options?.runtimeEventLog?.events.at(-1)).toMatchObject({
      kind: 'runtime_intervention',
      payload: {
        intervention_kind: 'image_input_routed',
        model: 'unknown-text-model',
        vision_status: 'unknown',
        vision_source: 'unknown',
        attached_count: 0,
        blocked_count: 1,
      },
    })
  })

  it('lets addUserMessage persist explicit image content blocks', () => {
    const conversation = createConversation({ model: 'kimi-k2.7-code' })
    const blocks = [
      { type: 'text' as const, text: 'what is in this image?' },
      {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: 'image/png',
          data: 'aW1hZ2U=',
        },
      },
    ]

    addUserMessage(conversation, blocks)

    expect(conversation.turns.at(-1)?.content).toEqual(blocks)
  })
})
