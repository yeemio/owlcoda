import { describe, it, expect } from 'vitest'
import { parseDdgResults, formatSearchResults, createWebSearchTool } from '../../src/native/tools/web-search.js'
import type { SearchResult } from '../../src/native/tools/web-search.js'

describe('parseDdgResults', () => {
  it('parses result-link class pattern', () => {
    const html = `
      <a rel="nofollow" href="https://example.com" class="result-link">Example</a>
      <td class="result-snippet">This is a snippet</td>
      <a rel="nofollow" href="https://test.org" class="result-link">Test</a>
      <td class="result-snippet">Another snippet</td>
    `
    const results = parseDdgResults(html, 10)
    expect(results.length).toBe(2)
    expect(results[0]!.title).toBe('Example')
    expect(results[0]!.url).toBe('https://example.com')
    expect(results[0]!.snippet).toBe('This is a snippet')
    expect(results[1]!.title).toBe('Test')
    expect(results[1]!.url).toBe('https://test.org')
  })

  it('parses live DDG lite single-quoted classes and unwraps uddg redirect URLs', () => {
    const html = `
      <tr>
        <td>
          <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc%3Fa%3D1%26b%3D2&amp;rut=abc" class='result-link'>
            Example <b>Documentation</b>
          </a>
        </td>
      </tr>
      <tr>
        <td class='result-snippet'>
          Example &amp; docs with <b>markup</b>.
        </td>
      </tr>
    `
    const results = parseDdgResults(html, 10)
    expect(results).toHaveLength(1)
    expect(results[0]!.title).toBe('Example Documentation')
    expect(results[0]!.url).toBe('https://example.com/doc?a=1&b=2')
    expect(results[0]!.snippet).toBe('Example & docs with markup.')
  })

  it('matches result-link when class is not the first attribute and has multiple classes', () => {
    const html = `
      <a data-testid="x" class='foo result-link bar' href='https://example.org/a'>A &amp; B</a>
      <td data-testid="s" class="x result-snippet y">Snippet &quot;text&quot;</td>
    `
    const results = parseDdgResults(html, 10)
    expect(results).toEqual([{ title: 'A & B', url: 'https://example.org/a', snippet: 'Snippet "text"' }])
  })

  it('respects maxResults', () => {
    const html = `
      <a rel="nofollow" href="https://a.com" class="result-link">A</a>
      <td class="result-snippet">Snippet A</td>
      <a rel="nofollow" href="https://b.com" class="result-link">B</a>
      <td class="result-snippet">Snippet B</td>
      <a rel="nofollow" href="https://c.com" class="result-link">C</a>
      <td class="result-snippet">Snippet C</td>
    `
    const results = parseDdgResults(html, 2)
    expect(results.length).toBe(2)
  })

  it('falls back to generic link parsing', () => {
    const html = `
      <a href="https://example.com/page">Example Page Title</a>
      <a href="https://test.org/doc">Test Documentation</a>
      <a href="https://duckduckgo.com/about">DDG Internal</a>
    `
    const results = parseDdgResults(html, 10)
    // Should find the non-DDG links
    expect(results.some(r => r.url.includes('example.com'))).toBe(true)
    expect(results.some(r => r.url.includes('test.org'))).toBe(true)
    // Should skip DDG internal links
    expect(results.some(r => r.url.includes('duckduckgo.com'))).toBe(false)
  })

  it('handles empty HTML', () => {
    expect(parseDdgResults('', 10)).toEqual([])
  })

  it('decodes &amp; in URLs', () => {
    const html = '<a href="https://example.com?a=1&amp;b=2" class="result-link">Test</a>'
    const results = parseDdgResults(html, 10)
    expect(results[0]!.url).toBe('https://example.com?a=1&b=2')
  })
})

describe('formatSearchResults', () => {
  it('formats results with numbered list', () => {
    const results: SearchResult[] = [
      { title: 'Test Page', url: 'https://test.com', snippet: 'A test snippet' },
      { title: 'Other Page', url: 'https://other.com', snippet: 'Another snippet' },
    ]
    const output = formatSearchResults('test query', results)
    expect(output).toContain('Search: "test query"')
    expect(output).toContain('Results: 2')
    expect(output).toContain('1. Test Page')
    expect(output).toContain('https://test.com')
    expect(output).toContain('A test snippet')
    expect(output).toContain('2. Other Page')
  })

  it('shows no results message', () => {
    const output = formatSearchResults('nothing', [])
    expect(output).toContain('No results found')
  })

  it('handles results without snippets', () => {
    const results: SearchResult[] = [
      { title: 'No Snippet', url: 'https://x.com', snippet: '' },
    ]
    const output = formatSearchResults('query', results)
    expect(output).toContain('1. No Snippet')
    expect(output).toContain('https://x.com')
  })
})

describe('createWebSearchTool', () => {
  const tool = createWebSearchTool()

  it('has correct name and description', () => {
    expect(tool.name).toBe('WebSearch')
    expect(tool.description).toContain('Search')
  })

  it('rejects empty query', async () => {
    const result = await tool.execute({ query: '' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('at least 2 characters')
  })

  it('rejects too-short query', async () => {
    const result = await tool.execute({ query: 'a' })
    expect(result.isError).toBe(true)
  })

  // Note: actual search tests require network — these are unit tests for input validation
})
