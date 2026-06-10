import { describe, it, expect } from 'vitest'
import { formatBenchmarkReport, type BenchmarkReport, type BenchmarkResult } from '../src/benchmark.js'

describe('benchmark', () => {
  it('formats successful results', () => {
    const report: BenchmarkReport = {
      proxyUrl: 'http://localhost:8019',
      timestamp: '2025-01-01T00:00:00.000Z',
      results: [
        { modelId: 'qwen2.5-32b', success: true, ttftMs: 120, totalMs: 2500, outputTokens: 30, tps: 12 },
        { modelId: 'llama-3.1-8b', success: true, ttftMs: 80, totalMs: 1200, outputTokens: 25, tps: 20.8 },
      ],
    }
    const out = formatBenchmarkReport(report)
    expect(out).toContain('Model Benchmark')
    expect(out).toContain('qwen2.5-32b')
    expect(out).toContain('120ms')
    expect(out).toContain('2500ms')
    expect(out).toContain('12')
    expect(out).toContain('✅')
    expect(out).toContain('2/2 models responded')
  })

  it('formats failed results', () => {
    const report: BenchmarkReport = {
      proxyUrl: 'http://localhost:8019',
      timestamp: '2025-01-01T00:00:00.000Z',
      results: [
        { modelId: 'broken-model', success: false, error: 'Connection refused' },
      ],
    }
    const out = formatBenchmarkReport(report)
    expect(out).toContain('❌')
    expect(out).toContain('Connection refused')
    expect(out).toContain('0/1 models responded')
  })

  it('formats mixed results', () => {
    const report: BenchmarkReport = {
      proxyUrl: 'http://localhost:8019',
      timestamp: '2025-01-01T00:00:00.000Z',
      results: [
        { modelId: 'good-model', success: true, ttftMs: 100, totalMs: 1000, outputTokens: 20, tps: 20 },
        { modelId: 'bad-model', success: false, error: 'Timeout' },
      ],
    }
    const out = formatBenchmarkReport(report)
    expect(out).toContain('1/2 models responded')
    expect(out).toContain('Avg TTFT: 100ms')
  })

  it('truncates long model names', () => {
    const report: BenchmarkReport = {
      proxyUrl: 'http://localhost:8019',
      timestamp: '2025-01-01T00:00:00.000Z',
      results: [
        { modelId: 'super-long-model-name-that-is-definitely-way-too-long', success: true, ttftMs: 50, totalMs: 500, outputTokens: 10, tps: 20 },
      ],
    }
    const out = formatBenchmarkReport(report)
    expect(out).toContain('...')
  })

  it('benchmark command is wired into parseArgs', async () => {
    const { parseArgs } = await import('../src/cli-core.js')
    const result = parseArgs(['node', 'owlcoda', 'benchmark'])
    expect(result.command).toBe('benchmark')
  })
})
