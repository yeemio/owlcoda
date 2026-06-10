import { describe, expect, it } from 'vitest'
import {
  classifySemanticToolFailure,
  applyToolFailurePolicy,
  classifyToolFailurePolicy,
} from '../../../src/native/tools/semantic-failure.js'

describe('semantic tool failure classifier', () => {
  it('promotes curl JSON invalid client key output to a terminal semantic failure', () => {
    const result = applyToolFailurePolicy('bash', {
      command: 'curl -sS "http://8.130.50.168:3000/mes/customer/page?current=1&size=5&key=x"',
    }, {
      output: '[stdout]\n{"detail":"无效的客户端 Key"}\n\n[exit code: 0]',
      isError: false,
      metadata: { exitCode: 0 },
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('[Runtime failure-policy guard]')
    expect(result.output).toContain('无效的客户端 Key')
    expect(result.metadata).toMatchObject({
      failurePolicyApplied: true,
      semanticFailure: true,
      failureCategory: 'remote:auth_or_permission',
      failureRetryable: false,
      failureTerminal: true,
      terminalToolFailure: true,
    })
  })

  it('classifies WebFetch JSON auth payloads the same way', () => {
    const failure = classifySemanticToolFailure('WebFetch', {
      url: 'https://example.test/api',
    }, {
      output: 'URL: https://example.test/api\nContent-Type: application/json\nLength: 36 chars\n\n{"error":"invalid_api_key"}',
      isError: false,
    })

    expect(failure).toMatchObject({
      category: 'remote:auth_or_permission',
      terminal: true,
    })
  })

  it('does not fire on local echo text that merely mentions unauthorized', () => {
    const result = applyToolFailurePolicy('bash', {
      command: 'echo "docs mention Unauthorized status handling"',
    }, {
      output: '[stdout]\ndocs mention Unauthorized status handling\n\n[exit code: 0]',
      isError: false,
      metadata: { exitCode: 0 },
    })

    expect(result.isError).toBe(false)
    expect(result.metadata?.['semanticFailure']).toBeUndefined()
  })

  it('does not treat no-data responses as terminal auth/config failures', () => {
    const failure = classifySemanticToolFailure('bash', {
      command: 'curl -sS https://example.test/search',
    }, {
      output: '[stdout]\n{"success":false,"message":"无数据"}\n\n[exit code: 0]',
      isError: false,
      metadata: { exitCode: 0 },
    })

    expect(failure).toBeNull()
  })

  it('promotes remote rate-limit payloads to terminal but retryable failures', () => {
    const result = applyToolFailurePolicy('bash', {
      command: 'curl -sS https://example.test/search',
    }, {
      output: '[stdout]\n{"error":"rate_limit_error","message":"too many requests"}\n\n[exit code: 0]',
      isError: false,
      metadata: { exitCode: 0 },
    })

    expect(result.isError).toBe(true)
    expect(result.metadata).toMatchObject({
      failureCategory: 'remote:rate_limit',
      failureRetryable: true,
      terminalToolFailure: true,
    })
  })

  it('classifies remote 5xx error objects as retryable terminal API failures', () => {
    const failure = classifyToolFailurePolicy('MCPTool', {
      server_name: 'mes',
      tool_name: 'customer_page',
    }, {
      output: '{"success":false,"status":502,"message":"bad gateway"}',
      isError: false,
    })

    expect(failure).toMatchObject({
      category: 'remote:api_error',
      terminal: true,
      retryable: true,
    })
  })

  it('adds policy metadata to deterministic tool guard failures without making them terminal', () => {
    const result = applyToolFailurePolicy('write', {
      path: '/etc/passwd',
    }, {
      output: 'Write denied by filesystem policy: sensitive location /etc',
      isError: true,
      metadata: { fsPolicyDenied: true, attemptedPath: '/etc/passwd' },
    })

    expect(result.isError).toBe(true)
    expect(result.output).not.toContain('[Runtime failure-policy guard]')
    expect(result.metadata).toMatchObject({
      failurePolicyApplied: true,
      failureCategory: 'tool:fs_policy_denied',
      failureRetryable: false,
      failureTerminal: false,
    })
    expect(result.metadata?.['terminalToolFailure']).toBeUndefined()
  })
})
