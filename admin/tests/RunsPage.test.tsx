import { describe, expect, it, beforeEach } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { RunsPage } from '../src/pages/RunsPage'
import { I18nProvider } from '../src/i18n'

beforeEach(() => {
  // Each test gets a clean DOM.
  window.localStorage.clear()
})

describe('RunsPage', () => {
  it('does not expose internal QA snapshot labels in the public admin UI', () => {
    render(<RunsPage />)

    const internalLane = new RegExp(['Lane', 'A'].join(' '), 'i')
    const internalReportWord = new RegExp(['sign', 'off'].join(''), 'i')
    const internalBlockers = new RegExp(['remaining', 'blockers'].join(' '), 'i')
    const internalGuardFix = new RegExp(['guard', 'fix'].join(' '), 'i')
    const internalRerun = new RegExp(['rerun', 'still', 'required'].join(' '), 'i')

    expect(screen.queryByText(internalLane)).not.toBeInTheDocument()
    expect(screen.queryByText(internalReportWord)).not.toBeInTheDocument()
    expect(screen.queryByText(internalBlockers)).not.toBeInTheDocument()
    expect(screen.queryByText(internalGuardFix)).not.toBeInTheDocument()
    expect(screen.queryByText(internalRerun)).not.toBeInTheDocument()
  })

  it('renders the public demo header, hero strip, and both run cards', () => {
    render(<RunsPage />)

    expect(screen.getByTestId('run-title')).toHaveTextContent(/cloud-primary \+ local-runtime/i)
    expect(screen.getByTestId('run-hero-verdict')).toHaveTextContent(/Demo run healthy/)
    expect(screen.getByText('DEMO PACKAGE · DAEMON')).toBeInTheDocument()

    const cloud = screen.getByTestId('run-card-cloud-primary')
    expect(within(cloud).getByText(/served by/i)).toBeInTheDocument()
    expect(within(cloud).getByText(/cloud demo backend/)).toBeInTheDocument()
    expect(within(cloud).getByText('PASS')).toBeInTheDocument()
    expect(within(cloud).getByText('12')).toBeInTheDocument()
    expect(within(cloud).getByText('12/12')).toBeInTheDocument()

    const local = screen.getByTestId('run-card-local-runtime')
    expect(within(local).getByText('PARTIAL')).toBeInTheDocument()
    expect(within(local).getByText('18/18')).toBeInTheDocument()
    expect(within(local).getByText('8.4 min')).toBeInTheDocument()
    expect(within(local).getByText(/live audit-log endpoint/i)).toBeInTheDocument()
  })

  it('switches the tool coverage tab between cloud-primary and local-runtime without losing the grid', () => {
    render(<RunsPage />)

    // Default tab is the last run (local-runtime). Verify by tile count for the active grid.
    const localGrid = screen.getByTestId('tool-coverage-grid-local-runtime')
    expect(within(localGrid).getByTestId('tool-tile-bash')).toHaveTextContent('9')
    expect(within(localGrid).getByTestId('tool-tile-LSP')).toHaveTextContent('0')

    fireEvent.click(screen.getByTestId('tool-coverage-tab-cloud-primary'))
    const cloudGrid = screen.getByTestId('tool-coverage-grid-cloud-primary')
    expect(within(cloudGrid).getByTestId('tool-tile-bash')).toHaveTextContent('7')
    expect(within(cloudGrid).getByTestId('tool-tile-LSP')).toHaveTextContent('0')
  })

  it('renders all blockers under ALL filter and only open ones under OPEN', () => {
    render(<RunsPage />)

    expect(screen.getByTestId('blocker-0')).toBeInTheDocument()
    expect(screen.getByTestId('blocker-1')).toBeInTheDocument()
    expect(screen.getByTestId('blocker-2')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('blockers-filter-resolved'))
    expect(screen.getByText('Export run packet')).toBeInTheDocument()
    expect(screen.queryByText('Connect live audit-log feed')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('blockers-filter-open'))
    expect(screen.getByTestId('blocker-0')).toBeInTheDocument()
    expect(screen.queryByText('Export run packet')).not.toBeInTheDocument()
  })

  it('surfaces all four runtime failure verdicts including terminal control status', () => {
    render(<RunsPage />)

    const list = screen.getByTestId('runtime-failures')
    expect(within(list).getByText('Provider request paths')).toBeInTheDocument()
    expect(within(list).getByText(/Terminal control/)).toBeInTheDocument()
    expect(within(list).getByText(/No terminal-control defect/)).toBeInTheDocument()
  })

  it('renders the captured terminal output with timestamps and the demo file size', () => {
    render(<RunsPage />)

    const term = screen.getByTestId('run-terminal')
    expect(within(term).getByText('128,024 bytes')).toBeInTheDocument()
    expect(within(term).getByText(/Nothing remaining\. Task done\./)).toBeInTheDocument()
  })

  it('renders the report shell in Chinese when admin language is zh', () => {
    window.localStorage.setItem('owlcoda.admin.lang', 'zh')
    render(
      <I18nProvider>
        <RunsPage />
      </I18nProvider>,
    )

    expect(screen.getByTestId('run-title')).toHaveTextContent('可靠性演示')
    expect(screen.getByTestId('run-hero-verdict')).toHaveTextContent('演示运行健康')
    expect(screen.getByText('演示包版本 · Daemon')).toBeInTheDocument()
    expect(screen.getByText('运行记录')).toBeInTheDocument()
    expect(screen.getByText('审计 · 请求时间线')).toBeInTheDocument()
    expect(screen.getByText('运行时失败判定')).toBeInTheDocument()
    expect(screen.getByText('跟进项')).toBeInTheDocument()
    expect(screen.getAllByText('报告中跟踪')).toHaveLength(3)
  })
})
