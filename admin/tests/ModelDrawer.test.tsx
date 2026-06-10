import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ModelDrawer } from '../src/components/ModelDrawer'
import { mkStatus } from './fixtures'
import type { EndpointHealthResponse } from '../src/api/types'

vi.mock('../src/api/client', () => ({
  fetchEndpointHealth: vi.fn(),
  fetchLocalRuntimes: vi.fn(),
}))

const { fetchEndpointHealth, fetchLocalRuntimes } = await import('../src/api/client')
const mockFetchEndpointHealth = fetchEndpointHealth as ReturnType<typeof vi.fn>
const mockFetchLocalRuntimes = fetchLocalRuntimes as ReturnType<typeof vi.fn>

const noop = vi.fn()
const mutationIdle = { submitting: false, error: null }

function renderDrawer(status: ReturnType<typeof mkStatus> | null) {
  return render(
    <ModelDrawer
      status={status}
      setDefaultState={mutationIdle}
      editState={mutationIdle}
      keyState={mutationIdle}
      deleteState={mutationIdle}
      testResult={null}
      testSubmitting={false}
      testError={null}
      onSetDefault={noop}
      onUpdateFields={noop as never}
      onReplaceKey={noop as never}
      onTestSaved={noop as never}
      onDelete={noop as never}
      runtimeOk={false}
      routerUrl=""
      onConnectRuntime={noop as never}
    />,
  )
}

function emptyHealth(): EndpointHealthResponse {
  return { schemaVersion: 1, samples: [] }
}

describe('ModelDrawer · S2.C + S2.D facts', () => {
  beforeEach(() => {
    mockFetchEndpointHealth.mockReset()
    mockFetchLocalRuntimes.mockResolvedValue({ schemaVersion: 1, runtimes: [] })
  })

  it('shows credentialSource row when sanitized config carries apiKeySource', () => {
    mockFetchEndpointHealth.mockResolvedValue(emptyHealth())
    renderDrawer(mkStatus({
      id: 'gpt-cloud',
      raw: {
        config: {
          id: 'gpt-cloud',
          label: 'GPT',
          backendModel: 'gpt-4',
          aliases: [],
          endpoint: 'https://api.openai.com/v1',
          apiKeyEnv: 'OPENAI_API_KEY',
          apiKeySource: 'env',
        },
      },
    }))
    expect(screen.getByTestId('fact-credentialSource')).toHaveTextContent('env')
  })

  it('omits credentialSource row when sanitized config does not carry apiKeySource', () => {
    mockFetchEndpointHealth.mockResolvedValue(emptyHealth())
    renderDrawer(mkStatus({
      id: 'gpt-cloud',
      raw: {
        config: {
          id: 'gpt-cloud',
          label: 'GPT',
          backendModel: 'gpt-4',
          aliases: [],
          endpoint: 'https://api.openai.com/v1',
        },
      },
    }))
    expect(screen.queryByTestId('fact-credentialSource')).toBeNull()
  })

  it('shows endpointHealth row when /admin/api/endpoint-health has a matching sample', async () => {
    mockFetchEndpointHealth.mockResolvedValue({
      schemaVersion: 1,
      samples: [{
        endpoint: 'https://api.openai.com/v1',
        ok: true,
        latencyMs: 87,
        status: 200,
        detail: 'reachable',
        credentialSource: 'env',
        observedAt: Date.now() - 5_000,
      }],
    })
    renderDrawer(mkStatus({
      id: 'gpt-cloud',
      raw: {
        config: {
          id: 'gpt-cloud',
          label: 'GPT',
          backendModel: 'gpt-4',
          aliases: [],
          endpoint: 'https://api.openai.com/v1',
        },
      },
    }))
    const row = await screen.findByTestId('fact-endpointHealth')
    expect(row).toHaveTextContent(/87ms/)
    expect(row).toHaveTextContent(/✓/)
  })

  it('omits endpointHealth row when no sample matches the current endpoint', async () => {
    mockFetchEndpointHealth.mockResolvedValue({
      schemaVersion: 1,
      samples: [{
        endpoint: 'https://different.example.com',
        ok: true,
        latencyMs: 5,
        status: 200,
        detail: 'reachable',
        observedAt: Date.now(),
      }],
    })
    renderDrawer(mkStatus({
      id: 'gpt-cloud',
      raw: {
        config: {
          id: 'gpt-cloud',
          label: 'GPT',
          backendModel: 'gpt-4',
          aliases: [],
          endpoint: 'https://api.openai.com/v1',
        },
      },
    }))
    await waitFor(() => expect(mockFetchEndpointHealth).toHaveBeenCalled())
    expect(screen.queryByTestId('fact-endpointHealth')).toBeNull()
  })

  it('silently degrades when fetchEndpointHealth rejects', async () => {
    mockFetchEndpointHealth.mockRejectedValue(new Error('offline'))
    renderDrawer(mkStatus({
      id: 'gpt-cloud',
      raw: {
        config: {
          id: 'gpt-cloud',
          label: 'GPT',
          backendModel: 'gpt-4',
          aliases: [],
          endpoint: 'https://api.openai.com/v1',
        },
      },
    }))
    await waitFor(() => expect(mockFetchEndpointHealth).toHaveBeenCalled())
    expect(screen.queryByTestId('fact-endpointHealth')).toBeNull()
  })

  it('does not fetch endpoint-health when the current model has no endpoint', () => {
    mockFetchEndpointHealth.mockResolvedValue(emptyHealth())
    renderDrawer(mkStatus({
      id: 'local-model',
      providerKind: 'local',
      raw: {
        config: {
          id: 'local-model',
          label: 'local-model',
          backendModel: 'local-model',
          aliases: [],
        },
      },
    }))
    expect(mockFetchEndpointHealth).not.toHaveBeenCalled()
  })
})
