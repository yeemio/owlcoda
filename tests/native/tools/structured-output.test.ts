import { describe, it, expect } from 'vitest'
import { createStructuredOutputTool } from '../../../src/native/tools/structured-output.js'

describe('StructuredOutput tool', () => {
  const tool = createStructuredOutputTool()

  it('returns formatted JSON from input', async () => {
    const result = await tool.execute({ name: 'test', value: 42 })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('name')
    expect(result.output).toContain('42')
  })

  it('handles string-like input', async () => {
    const result = await tool.execute({ message: 'hello' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('hello')
  })

  it('includes metadata with structuredOutput', async () => {
    const result = await tool.execute({ a: 1 })
    expect(result.metadata).toBeDefined()
    expect((result.metadata as any).structuredOutput).toEqual({ a: 1 })
  })

  it('returns only the data payload when schema/data input shape is used', async () => {
    const result = await tool.execute({
      schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      data: { name: 'owl' },
    })

    expect(result.isError).toBe(false)
    expect(JSON.parse(result.output)).toEqual({ name: 'owl' })
    expect(result.output).not.toContain('"schema"')
    expect(result.metadata).toMatchObject({ structuredOutput: { name: 'owl' }, schemaValidated: true })
  })

  it('rejects schema/data payloads that are missing required fields', async () => {
    const result = await tool.execute({
      schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      data: {},
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('structured output does not match schema')
    expect(result.output).toContain('$.name is required')
  })

  it('rejects schema/data payloads with wrong primitive types', async () => {
    const result = await tool.execute({
      schema: {
        type: 'object',
        required: ['count', 'published'],
        properties: {
          count: { type: 'integer' },
          published: { type: 'boolean' },
        },
      },
      data: { count: 1.5, published: 'yes' },
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('$.count must be integer')
    expect(result.output).toContain('$.published must be boolean')
  })

  it('validates array items and enum values', async () => {
    const result = await tool.execute({
      schema: {
        type: 'object',
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['status'],
              properties: { status: { enum: ['ok', 'skip'] } },
            },
          },
        },
      },
      data: { items: [{ status: 'ok' }, { status: 'bad' }] },
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('$.items[1].status must be one of')
  })

  it('honors additionalProperties false', async () => {
    const result = await tool.execute({
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string' } },
      },
      data: { name: 'owl', extra: true },
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('$.extra is not allowed')
  })

  it('requires data when schema is provided', async () => {
    const result = await tool.execute({ schema: { type: 'object' } })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('data is required when schema is provided')
  })

  it('has correct name', () => {
    expect(tool.name).toBe('StructuredOutput')
  })
})
