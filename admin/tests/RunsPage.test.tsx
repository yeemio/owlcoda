import { describe, expect, it, beforeEach } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { RunsPage } from '../src/pages/RunsPage'
import { I18nProvider } from '../src/i18n'

beforeEach(() => {
  // Each test gets a clean DOM.
  window.localStorage.clear()
})

describe('RunsPage', () => {
  it('renders the Lane A header, hero strip, and both run cards', () => {
    render(<RunsPage />)

    expect(screen.getByTestId('run-title')).toHaveTextContent(/minimax-m27 \+ kimi-code/i)
    expect(screen.getByTestId('run-hero-verdict')).toHaveTextContent(/Kimi provider-side passed/)
    expect(screen.getByText('HISTORICAL REPORT PACKAGE · DAEMON')).toBeInTheDocument()

    const minimax = screen.getByTestId('run-card-minimax-m27')
    expect(within(minimax).getByText(/served by/i)).toBeInTheDocument()
    expect(within(minimax).getByText(/MiniMax-M2.7-highspeed/)).toBeInTheDocument()
    expect(within(minimax).getByText('PASS')).toBeInTheDocument()
    expect(within(minimax).getByText('21')).toBeInTheDocument()
    expect(within(minimax).getByText('21/21')).toBeInTheDocument()

    const kimi = screen.getByTestId('run-card-kimi-code')
    expect(within(kimi).getByText('PARTIAL')).toBeInTheDocument()
    expect(within(kimi).getByText('66/66')).toBeInTheDocument()
    expect(within(kimi).getByText('10.6 min')).toBeInTheDocument()
    expect(within(kimi).getByText(/completion guard drifted/i)).toBeInTheDocument()
  })

  it('switches the tool coverage tab between minimax-m27 and kimi-code without losing the grid', () => {
    render(<RunsPage />)

    // Default tab is the last run (kimi-code). Verify by tile count for the active grid.
    const kimiGrid = screen.getByTestId('tool-coverage-grid-kimi-code')
    expect(within(kimiGrid).getByTestId('tool-tile-bash')).toHaveTextContent('9')
    expect(within(kimiGrid).getByTestId('tool-tile-LSP')).toHaveTextContent('0')

    fireEvent.click(screen.getByTestId('tool-coverage-tab-minimax-m27'))
    const mGrid = screen.getByTestId('tool-coverage-grid-minimax-m27')
    expect(within(mGrid).getByTestId('tool-tile-bash')).toHaveTextContent('12')
    expect(within(mGrid).getByTestId('tool-tile-LSP')).toHaveTextContent('0')
  })

  it('renders all blockers under ALL filter and only open ones under OPEN', () => {
    render(<RunsPage />)

    expect(screen.getByTestId('blocker-0')).toBeInTheDocument()
    expect(screen.getByTestId('blocker-1')).toBeInTheDocument()
    expect(screen.getByTestId('blocker-2')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('blockers-filter-resolved'))
    expect(screen.getByText('Kimi 10-minute parity comparison')).toBeInTheDocument()
    expect(screen.queryByText('cmux CLI control surface unhealthy')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('blockers-filter-open'))
    expect(screen.getByTestId('blocker-0')).toBeInTheDocument()
    expect(screen.queryByText('Kimi 10-minute parity comparison')).not.toBeInTheDocument()
  })

  it('surfaces all four runtime failure verdicts including the truthful PARTIAL on cmux CLI', () => {
    render(<RunsPage />)

    const list = screen.getByTestId('runtime-failures')
    expect(within(list).getByText('Provider request paths (minimax / kimi)')).toBeInTheDocument()
    expect(within(list).getByText(/cmux CLI/)).toBeInTheDocument()
    expect(within(list).getByText(/Broken pipe/)).toBeInTheDocument()
  })

  it('renders the captured terminal output with timestamps and the 546,674-byte file size', () => {
    render(<RunsPage />)

    const term = screen.getByTestId('run-terminal')
    expect(within(term).getByText('546,674 bytes')).toBeInTheDocument()
    expect(within(term).getByText(/Nothing remaining\. Task done\./)).toBeInTheDocument()
  })

  it('renders the report shell in Chinese when admin language is zh', () => {
    window.localStorage.setItem('owlcoda.admin.lang', 'zh')
    render(
      <I18nProvider>
        <RunsPage />
      </I18nProvider>,
    )

    expect(screen.getByTestId('run-title')).toHaveTextContent('压力运行')
    expect(screen.getByTestId('run-hero-verdict')).toHaveTextContent('Kimi provider 侧已通过')
    expect(screen.getByText('历史报告包版本 · Daemon')).toBeInTheDocument()
    expect(screen.getByText('运行记录')).toBeInTheDocument()
    expect(screen.getByText('审计 · 请求时间线')).toBeInTheDocument()
    expect(screen.getByText('运行时失败判定')).toBeInTheDocument()
    expect(screen.getByText('剩余阻塞项')).toBeInTheDocument()
    expect(screen.getAllByText('签收中跟踪')).toHaveLength(3)
  })
})
