import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { ModelsPage } from '../src/pages/ModelsPage'
import { mkSnapshot, mkStatus } from './fixtures'

describe('ModelsPage (Phase β read-only)', () => {
  const snapshot = mkSnapshot([
    mkStatus({ id: 'model-alpha-7', label: 'Model Alpha 7', providerKind: 'cloud', isDefault: true }),
    mkStatus({
      id: 'kimi-k2',
      label: 'Kimi K2',
      providerKind: 'cloud',
      role: 'coding',
      availability: { kind: 'missing_key', envName: 'KIMI_API_KEY' },
    }),
    mkStatus({
      id: 'llama3-8b',
      label: 'Llama 3 8B',
      providerKind: 'local',
      availability: { kind: 'orphan_discovered' },
      presentIn: { config: false, router: false, discovered: true, catalog: false },
    }),
    mkStatus({
      id: 'qwen-coder',
      label: 'Qwen Coder',
      providerKind: 'local',
      availability: { kind: 'alias_conflict', with: 'model-haiku-3-5' },
    }),
  ])

  it('renders default model in overview', () => {
    render(<ModelsPage snapshot={snapshot} onRefresh={() => {}} onSnapshotUpdate={() => {}} loading={false} />)
    expect(screen.getByTestId('overview-default-label')).toHaveTextContent('Model Alpha 7')
  })

  it('renders counts (total / ok / blocked / orphan)', () => {
    render(<ModelsPage snapshot={snapshot} onRefresh={() => {}} onSnapshotUpdate={() => {}} loading={false} />)
    expect(screen.getByTestId('overview-total')).toHaveTextContent('4')
    expect(screen.getByTestId('overview-ok-count')).toHaveTextContent('1')
    expect(screen.getByTestId('overview-blocked')).toHaveTextContent('2')
    expect(screen.getByTestId('overview-orphan')).toHaveTextContent('1')
  })

  it('lists every model with provider + short status tag', () => {
    render(<ModelsPage snapshot={snapshot} onRefresh={() => {}} onSnapshotUpdate={() => {}} loading={false} />)
    const list = screen.getByTestId('model-list')
    expect(within(list).getAllByRole('listitem')).toHaveLength(4)
    const kimi = within(list).getByTestId('model-row-kimi-k2')
    expect(kimi).toHaveAttribute('data-status', 'missing_key')
    expect(kimi).toHaveTextContent('cloud')
    expect(kimi).toHaveTextContent('no key')
  })

  it('sorts default-first, then ok, then blocked, then orphan', () => {
    render(<ModelsPage snapshot={snapshot} onRefresh={() => {}} onSnapshotUpdate={() => {}} loading={false} />)
    const list = screen.getByTestId('model-list')
    const ids = within(list).getAllByRole('listitem').map(n => n.getAttribute('data-testid'))
    expect(ids).toEqual([
      'model-row-model-alpha-7', // default
      'model-row-kimi-k2',    // blocked
      'model-row-qwen-coder', // blocked
      'model-row-llama3-8b',  // orphan
    ])
  })

  it('Issues filter narrows to non-ok only', () => {
    render(<ModelsPage snapshot={snapshot} onRefresh={() => {}} onSnapshotUpdate={() => {}} loading={false} />)
    fireEvent.click(screen.getByTestId('filter-issues'))
    const list = screen.getByTestId('model-list')
    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
    expect(within(list).queryByTestId('model-row-model-alpha-7')).toBeNull()
    expect(screen.getByTestId('visible-count')).toHaveTextContent('3')
  })

  it('Clicking a row opens the drawer with presence + fix hints', () => {
    render(<ModelsPage snapshot={snapshot} onRefresh={() => {}} onSnapshotUpdate={() => {}} loading={false} />)
    fireEvent.click(screen.getByTestId('model-row-kimi-k2'))
    expect(screen.getByTestId('drawer-label')).toHaveTextContent('Kimi K2')
    expect(screen.getByTestId('drawer-id')).toHaveTextContent('kimi-k2')
    expect(screen.getByTestId('drawer-phrase')).toHaveTextContent('KIMI_API_KEY')
    expect(screen.getByTestId('presence-config')).toHaveTextContent('config ✓')
    const hints = screen.getByTestId('fix-hints')
    expect(hints).toHaveTextContent('KIMI_API_KEY')
  })

  it('Auto-selects the default model on mount', () => {
    render(<ModelsPage snapshot={snapshot} onRefresh={() => {}} onSnapshotUpdate={() => {}} loading={false} />)
    expect(screen.getByTestId('drawer-label')).toHaveTextContent('Model Alpha 7')
    expect(screen.getByTestId('drawer-id')).toHaveTextContent('model-alpha-7')
  })

  it('Falls back to first visible item when no default exists', () => {
    const snap = mkSnapshot([
      mkStatus({ id: 'zzz', label: 'Zee', availability: { kind: 'missing_key' } }),
      mkStatus({ id: 'aaa', label: 'Alpha' }),
    ])
    render(<ModelsPage snapshot={snap} onRefresh={() => {}} onSnapshotUpdate={() => {}} loading={false} />)
    // After sort: aaa (ok) before zzz (blocked). No default → pick first visible.
    expect(screen.getByTestId('drawer-id')).toHaveTextContent('aaa')
  })

  it('Reconciles selection when filter hides the current selection', () => {
    render(<ModelsPage snapshot={snapshot} onRefresh={() => {}} onSnapshotUpdate={() => {}} loading={false} />)
    // Default auto-selected model-alpha-7 (ok). Switch to Issues — it disappears.
    expect(screen.getByTestId('drawer-id')).toHaveTextContent('model-alpha-7')
    fireEvent.click(screen.getByTestId('filter-issues'))
    // Drawer must NOT keep showing model-alpha-7; it must switch to something visible.
    const stillVisibleId = screen.getByTestId('drawer-id').textContent
    expect(stillVisibleId).not.toContain('model-alpha-7')
    // And the new selection must be one of the visible (issues) rows.
    const list = screen.getByTestId('model-list')
    expect(within(list).queryByTestId(`model-row-${stillVisibleId}`)).not.toBeNull()
  })

  it('Shows empty drawer when snapshot has zero models', () => {
    const empty = mkSnapshot([])
    render(<ModelsPage snapshot={empty} onRefresh={() => {}} onSnapshotUpdate={() => {}} loading={false} />)
    expect(screen.queryByTestId('drawer-empty')).not.toBeNull()
    expect(screen.queryByTestId('drawer-label')).toBeNull()
  })

  it('Actions rendered by data-testid (Phase γ live; exact labels vary by state)', () => {
    render(<ModelsPage snapshot={snapshot} onRefresh={() => {}} onSnapshotUpdate={() => {}} loading={false} />)
    fireEvent.click(screen.getByTestId('model-row-kimi-k2'))
    for (const id of ['action-set-default', 'action-key', 'action-edit', 'action-test', 'action-delete']) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
  })

  it('Initial filter "issues" honoured', () => {
    render(<ModelsPage snapshot={snapshot} onRefresh={() => {}} onSnapshotUpdate={() => {}} loading={false} initialFilter="issues" />)
    expect(screen.getByTestId('visible-count')).toHaveTextContent('3')
    expect(screen.getByTestId('filter-issues')).toHaveClass('active')
  })

  it('Refresh button calls onRefresh', () => {
    const onRefresh = vi.fn()
    render(<ModelsPage snapshot={snapshot} onRefresh={onRefresh} onSnapshotUpdate={() => {}} loading={false} />)
    fireEvent.click(screen.getByTestId('refresh'))
    expect(onRefresh).toHaveBeenCalledOnce()
  })
})
