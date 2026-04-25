import { describe, it, expect } from 'vitest'
import { htmlToText, createWebFetchTool } from '../../src/native/tools/web-fetch.js'

describe('htmlToText', () => {
  it('strips simple HTML tags', () => {
    expect(htmlToText('<p>Hello <b>world</b></p>')).toBe('Hello world')
  })

  it('removes script and style blocks', () => {
    const html = '<p>text</p><script>alert(1)</script><style>body{}</style><p>more</p>'
    const result = htmlToText(html)
    expect(result).toContain('text')
    expect(result).toContain('more')
    expect(result).not.toContain('alert')
    expect(result).not.toContain('body{}')
  })

  it('decodes HTML entities', () => {
    expect(htmlToText('&amp; &lt; &gt; &quot; &#39;')).toBe('& < > " \'')
  })

  it('converts block elements to newlines', () => {
    const html = '<p>first</p><p>second</p>'
    const result = htmlToText(html)
    expect(result).toContain('first')
    expect(result).toContain('second')
    expect(result.split('\n').length).toBeGreaterThanOrEqual(2)
  })

  it('handles <br> tags', () => {
    const html = 'line1<br/>line2<br>line3'
    const result = htmlToText(html)
    expect(result).toContain('line1')
    expect(result).toContain('line2')
    expect(result).toContain('line3')
  })

  it('collapses excess whitespace', () => {
    const html = '  lots   of    spaces  '
    expect(htmlToText(html)).toBe('lots of spaces')
  })

  it('handles empty input', () => {
    expect(htmlToText('')).toBe('')
  })

  it('decodes numeric entities', () => {
    expect(htmlToText('&#65;&#66;&#67;')).toBe('ABC')
  })
})

describe('createWebFetchTool', () => {
  const tool = createWebFetchTool()

  it('has correct name and description', () => {
    expect(tool.name).toBe('WebFetch')
    expect(tool.description).toContain('Fetch')
  })

  it('rejects empty url', async () => {
    const result = await tool.execute({ url: '' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('url is required')
  })

  it('rejects invalid url', async () => {
    const result = await tool.execute({ url: 'not-a-url' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('invalid URL')
  })

  it('rejects non-HTTP protocols', async () => {
    const result = await tool.execute({ url: 'ftp://example.com/file' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('HTTP/HTTPS')
  })

  // Note: actual fetch tests require network — these are unit tests for input validation
})
