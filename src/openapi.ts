/**
 * OpenAPI 3.0 specification for OwlCoda Proxy API.
 * Served at GET /openapi.json.
 */

import { VERSION } from './version.js'

export function getOpenApiSpec(): object {
  return {
    openapi: '3.0.3',
    info: {
      title: 'OwlCoda Proxy API',
      description: 'Local-first LLM proxy backed by local and cloud models.',
      version: VERSION,
      license: { name: 'MIT' },
    },
    servers: [
      { url: 'http://127.0.0.1:8019', description: 'Local OwlCoda proxy' },
    ],
    paths: {
      '/v1/messages': {
        post: {
          summary: 'Create a message',
          description: 'Send a message to a model through OwlCoda messages API.',
          operationId: 'createMessage',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/MessagesRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Successful response',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/MessagesResponse' },
                },
                'text/event-stream': {
                  description: 'Streaming response (when stream: true)',
                },
              },
              headers: {
                'x-owlcoda-served-by': { schema: { type: 'string' }, description: 'Backend model that served the request' },
                'x-owlcoda-fallback': { schema: { type: 'string' }, description: 'Set to "true" if fallback model was used' },
                'x-owlcoda-duration-ms': { schema: { type: 'string' }, description: 'Total request duration in milliseconds' },
                'x-request-id': { schema: { type: 'string' }, description: 'Unique request identifier' },
              },
            },
            '400': { description: 'Invalid request', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '429': { description: 'Rate limited', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '529': { description: 'All models overloaded', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/v1/chat/completions': {
        post: {
          summary: 'OpenAI Chat Completions',
          description: 'OpenAI-compatible chat completions passthrough. Forwards to router with model resolution.',
          operationId: 'chatCompletions',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['model', 'messages'],
                  properties: {
                    model: { type: 'string' },
                    messages: { type: 'array', items: { type: 'object' } },
                    stream: { type: 'boolean' },
                    max_tokens: { type: 'integer' },
                    temperature: { type: 'number' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Chat completion response' },
            '400': { description: 'Invalid JSON' },
            '502': { description: 'Router error' },
          },
        },
      },
      '/v1/models': {
        get: {
          summary: 'List available models',
          operationId: 'listModels',
          responses: {
            '200': {
              description: 'Model list',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ModelListResponse' },
                },
              },
            },
          },
        },
      },
      '/v1/backends': {
        get: {
          summary: 'Discover local LLM backends',
          description: 'Probe Ollama, LM Studio, vLLM and other local backends. Returns reachability status and discovered models per backend.',
          operationId: 'discoverBackends',
          responses: {
            '200': {
              description: 'Backend discovery results',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      backends: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            name: { type: 'string', description: 'Backend type (ollama, lmstudio, vllm)' },
                            baseUrl: { type: 'string', description: 'Backend base URL' },
                            reachable: { type: 'boolean' },
                            models: {
                              type: 'array',
                              items: {
                                type: 'object',
                                properties: {
                                  id: { type: 'string' },
                                  label: { type: 'string' },
                                  parameterSize: { type: 'string' },
                                  quantization: { type: 'string' },
                                  contextWindow: { type: 'integer' },
                                },
                              },
                            },
                          },
                        },
                      },
                      totalModels: { type: 'integer' },
                      reachableBackends: { type: 'array', items: { type: 'string' } },
                      unreachableBackends: { type: 'array', items: { type: 'string' } },
                      durationMs: { type: 'number' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/v1/perf': {
        get: {
          summary: 'Per-model performance metrics',
          description: 'Returns real-time performance data for each model: request count, latency (avg, p50), output TPS, success rate, token totals.',
          operationId: 'getPerformanceMetrics',
          responses: {
            '200': {
              description: 'Performance metrics per model',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            model_id: { type: 'string' },
                            request_count: { type: 'integer' },
                            avg_duration_ms: { type: 'integer' },
                            p50_duration_ms: { type: 'integer' },
                            avg_output_tps: { type: 'number' },
                            success_rate: { type: 'number' },
                            total_input_tokens: { type: 'integer' },
                            total_output_tokens: { type: 'integer' },
                            first_request_at: { type: 'string', format: 'date-time' },
                            last_request_at: { type: 'string', format: 'date-time' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/v1/messages/count_tokens': {
        post: {
          summary: 'Count tokens in a message',
          operationId: 'countTokens',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MessagesRequest' } } },
          },
          responses: {
            '200': { description: 'Token count', content: { 'application/json': { schema: { type: 'object', properties: { input_tokens: { type: 'integer' } } } } } },
          },
        },
      },
      '/v1/latency': {
        get: {
          summary: 'Latency percentiles per endpoint',
          description: 'Returns p50/p90/p95/p99 latency histograms per endpoint from the last 200 requests.',
          operationId: 'getLatencyStats',
          responses: {
            '200': {
              description: 'Latency statistics',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      latency: {
                        type: 'object',
                        additionalProperties: {
                          type: 'object',
                          properties: {
                            count: { type: 'integer' },
                            min: { type: 'number' },
                            max: { type: 'number' },
                            mean: { type: 'number' },
                            p50: { type: 'number' },
                            p90: { type: 'number' },
                            p95: { type: 'number' },
                            p99: { type: 'number' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/v1/audit': {
        get: {
          summary: 'Request audit log',
          description: 'Returns recent request entries with optional filters (model, path, status, duration).',
          operationId: 'getAuditLog',
          parameters: [
            { name: 'model', in: 'query', schema: { type: 'string' }, description: 'Filter by model' },
            { name: 'path', in: 'query', schema: { type: 'string' }, description: 'Filter by path' },
            { name: 'minStatus', in: 'query', schema: { type: 'integer' }, description: 'Minimum HTTP status' },
            { name: 'limit', in: 'query', schema: { type: 'integer' }, description: 'Max entries to return' },
          ],
          responses: {
            '200': {
              description: 'Audit log entries and summary',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      entries: { type: 'array', items: { type: 'object' } },
                      summary: { type: 'object' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/v1/cache': {
        get: {
          summary: 'Response cache stats',
          description: 'Returns cache size, hit/miss counts, hit rate, and configuration.',
          operationId: 'getCacheStats',
          responses: {
            '200': {
              description: 'Cache statistics',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      size: { type: 'integer' },
                      maxEntries: { type: 'integer' },
                      maxBytes: { type: 'integer', description: 'Maximum cache size in bytes' },
                      currentBytes: { type: 'integer', description: 'Current cache size in bytes' },
                      ttlMs: { type: 'integer' },
                      enabled: { type: 'boolean' },
                      totalHits: { type: 'integer' },
                      totalMisses: { type: 'integer' },
                      hitRate: { type: 'number' },
                    },
                  },
                },
              },
            },
          },
        },
        delete: {
          summary: 'Clear response cache',
          description: 'Removes all cached entries.',
          operationId: 'clearCache',
          responses: {
            '200': {
              description: 'Cache cleared',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/v1/cost': {
        get: {
          summary: 'Session cost summary',
          description: 'Returns per-model cost breakdown with real performance data, session token totals.',
          operationId: 'getSessionCost',
          responses: {
            '200': {
              description: 'Session cost data',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            model_id: { type: 'string' },
                            input_tokens: { type: 'integer' },
                            output_tokens: { type: 'integer' },
                            request_count: { type: 'integer' },
                            cost: { type: 'number' },
                            unit: { type: 'string' },
                            source: { type: 'string' },
                            real_tps: { type: 'number' },
                          },
                        },
                      },
                      total_cost: { type: 'number' },
                      unit: { type: 'string' },
                      session: {
                        type: 'object',
                        properties: {
                          total_input_tokens: { type: 'integer' },
                          total_output_tokens: { type: 'integer' },
                          request_count: { type: 'integer' },
                          started_at: { type: 'string', format: 'date-time' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/v1/recommend': {
        get: {
          summary: 'Model recommendation',
          description: 'Recommends the best model for a given intent based on performance data, cost, and model capabilities.',
          operationId: 'recommendModel',
          parameters: [{
            name: 'intent',
            in: 'query',
            description: 'Task intent (code, analysis, search, chat, general)',
            schema: { type: 'string', enum: ['code', 'analysis', 'search', 'chat', 'general'], default: 'general' },
          }],
          responses: {
            '200': {
              description: 'Model recommendation',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      intent: { type: 'string' },
                      recommended: {
                        type: 'object',
                        properties: {
                          model_id: { type: 'string' },
                          score: { type: 'integer' },
                          reasons: { type: 'array', items: { type: 'string' } },
                        },
                      },
                      alternatives: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            model_id: { type: 'string' },
                            score: { type: 'integer' },
                            reasons: { type: 'array', items: { type: 'string' } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            '400': { description: 'Invalid intent' },
          },
        },
      },
      '/v1/search': {
        post: {
          summary: 'Local web search',
          description: 'Search the web via DuckDuckGo HTML. No API key required. Stable standing service for external consumers (e.g. vm-brand).',
          operationId: 'search',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SearchRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Search results',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SearchResponse' },
                },
              },
            },
            '400': { description: 'Invalid request', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '503': { description: 'Search unavailable', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/healthz': {
        get: {
          summary: 'Liveness probe',
          operationId: 'healthz',
          responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' } } } } } } },
        },
      },
      '/health': {
        get: {
          summary: 'Health check with model status',
          operationId: 'health',
          responses: {
            '200': {
              description: 'Health status',
              content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, version: { type: 'string' }, uptime: { type: 'number' }, models: { type: 'array', items: { type: 'object' } } } } } },
            },
          },
        },
      },
      '/dashboard': {
        get: {
          summary: 'Observability dashboard',
          operationId: 'dashboard',
          responses: {
            '200': {
              description: 'Metrics and observability data',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
      '/openapi.json': {
        get: {
          summary: 'OpenAPI specification',
          operationId: 'openapi',
          responses: { '200': { description: 'OpenAPI 3.0 spec', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/admin/reset-circuit-breakers': {
        post: { summary: 'Reset all circuit breakers', operationId: 'resetCircuitBreakers', responses: { '200': { description: 'OK' } } },
      },
      '/admin/reset-budgets': {
        post: { summary: 'Reset error budgets', operationId: 'resetBudgets', responses: { '200': { description: 'OK' } } },
      },
      '/admin/reload-config': {
        post: { summary: 'Reload config from disk', operationId: 'reloadConfig', responses: { '200': { description: 'Applied fields' } } },
      },
      '/admin/config': {
        get: { summary: 'Current effective config', operationId: 'getConfig', responses: { '200': { description: 'Config object' } } },
      },
      '/admin/model-truth': {
        get: { summary: 'Aggregated model truth snapshot', operationId: 'getModelTruth', responses: { '200': { description: 'Unified model truth snapshot' } } },
      },
      '/admin/requests': {
        get: { summary: 'Recent request traces', operationId: 'getRequests', parameters: [{ name: 'count', in: 'query', schema: { type: 'integer' } }], responses: { '200': { description: 'Trace list' } } },
      },
      '/admin/audit': {
        get: { summary: 'Recent audit entries', operationId: 'getAudit', parameters: [{ name: 'count', in: 'query', schema: { type: 'integer' } }], responses: { '200': { description: 'Audit entries' } } },
      },
      '/metrics': {
        get: { summary: 'Prometheus/OpenMetrics text format', operationId: 'metrics', responses: { '200': { description: 'OpenMetrics text', content: { 'text/plain': { schema: { type: 'string' } } } } } },
      },
      '/events/metrics': {
        get: {
          summary: 'SSE live metrics stream',
          operationId: 'eventsMetrics',
          description: 'Server-Sent Events stream pushing metrics JSON every 2 seconds',
          responses: { '200': { description: 'SSE stream', content: { 'text/event-stream': { schema: { type: 'string' } } } } },
        },
      },
      '/v1/usage': {
        get: {
          summary: 'Token usage statistics',
          operationId: 'getUsage',
          responses: { '200': { description: 'Usage data', content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              inputTokens: { type: 'integer' },
              outputTokens: { type: 'integer' },
              totalTokens: { type: 'integer' },
              elapsedSeconds: { type: 'integer' },
              pricingNote: { type: 'string' },
            },
          } } } } },
        },
      },
      '/v1/api-info': {
        get: {
          summary: 'API discovery endpoint',
          operationId: 'apiInfo',
          responses: { '200': { description: 'Endpoint catalog', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/v1/skills': {
        get: {
          summary: 'List learned skills',
          operationId: 'listSkills',
          responses: { '200': { description: 'Skill metadata list', content: { 'application/json': { schema: { type: 'object', properties: { skills: { type: 'array' }, count: { type: 'integer' } } } } } } },
        },
        post: {
          summary: 'Create or update a skill',
          operationId: 'createSkill',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'] } } } },
          responses: { '201': { description: 'Skill created', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/v1/skills/:id': {
        get: {
          summary: 'Get a specific skill',
          operationId: 'getSkill',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Skill document with markdown', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
        delete: {
          summary: 'Delete a skill',
          operationId: 'deleteSkill',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Skill deleted', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/v1/skill-stats': {
        get: {
          summary: 'Skill injection stats — hit rate, top skills, timing',
          operationId: 'getSkillStats',
          responses: {
            '200': {
              description: 'Skill injection statistics',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      totalQueries: { type: 'integer' },
                      hits: { type: 'integer' },
                      misses: { type: 'integer' },
                      hitRate: { type: 'number' },
                      avgMatchMs: { type: 'number' },
                      topSkills: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            count: { type: 'integer' },
                            lastHit: { type: 'string', format: 'date-time' },
                          },
                        },
                      },
                      lastQueryAt: { type: 'string', format: 'date-time', nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
        delete: {
          summary: 'Reset skill injection stats',
          operationId: 'resetSkillStats',
          responses: { '200': { description: 'Stats reset', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/v1/insights': {
        get: {
          summary: 'Batch session insights — summary across all sessions',
          operationId: 'getBatchInsights',
          responses: { '200': { description: 'Aggregate insight summary', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/v1/insights/:sessionId': {
        get: {
          summary: 'Session insights — trace analysis, complexity, skill matches',
          operationId: 'getSessionInsights',
          parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Session insight report', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/v1/training/status': {
        get: {
          summary: 'Training data collection status',
          operationId: 'getTrainingStatus',
          responses: { '200': { description: 'Collection manifest and stats', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/v1/training/clear': {
        post: {
          summary: 'Clear collected training data',
          operationId: 'clearTrainingData',
          responses: { '200': { description: 'Cleared', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/v1/training/export': {
        get: {
          summary: 'Download collected training JSONL',
          operationId: 'exportTrainingData',
          responses: { '200': { description: 'JSONL stream', content: { 'application/x-ndjson': { schema: { type: 'string' } } } } },
        },
      },
      '/v1/web-search': {
        get: {
          summary: 'Web search via local SearXNG instance',
          operationId: 'webSearch',
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' }, description: 'Search query' },
            { name: 'language', in: 'query', schema: { type: 'string' }, description: 'Language code (e.g. zh-CN)' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 10 }, description: 'Max results' },
            { name: 'categories', in: 'query', schema: { type: 'string' }, description: 'Search categories' },
          ],
          responses: {
            '200': { description: 'Search results', content: { 'application/json': { schema: { type: 'object' } } } },
            '502': { description: 'SearXNG unavailable' },
          },
        },
      },
      '/v1/web-search/status': {
        get: {
          summary: 'Check SearXNG availability',
          operationId: 'webSearchStatus',
          responses: {
            '200': { description: 'SearXNG reachable', content: { 'application/json': { schema: { type: 'object' } } } },
            '503': { description: 'SearXNG unreachable' },
          },
        },
      },
    },
    components: {
      schemas: {
        MessagesRequest: {
          type: 'object',
          required: ['model', 'messages', 'max_tokens'],
          properties: {
            model: { type: 'string', description: 'Model ID or alias' },
            messages: {
              type: 'array',
              items: {
                type: 'object',
                required: ['role', 'content'],
                properties: {
                  role: { type: 'string', enum: ['user', 'assistant', 'system'] },
                  content: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }] },
                },
              },
              minItems: 1,
            },
            max_tokens: { type: 'integer', minimum: 1, description: 'Maximum tokens to generate' },
            stream: { type: 'boolean', default: false },
            temperature: { type: 'number', minimum: 0, maximum: 2 },
            top_p: { type: 'number', minimum: 0, maximum: 1 },
            stop_sequences: { type: 'array', items: { type: 'string' } },
            system: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }] },
            tools: { type: 'array', items: { type: 'object' } },
            tool_choice: { type: 'object' },
          },
        },
        MessagesResponse: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            type: { type: 'string', enum: ['message'] },
            role: { type: 'string', enum: ['assistant'] },
            content: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, text: { type: 'string' } } } },
            model: { type: 'string' },
            stop_reason: { type: 'string' },
            usage: {
              type: 'object',
              properties: {
                input_tokens: { type: 'integer' },
                output_tokens: { type: 'integer' },
              },
            },
          },
        },
        ErrorResponse: {
          type: 'object',
          required: ['type', 'error'],
          properties: {
            type: { type: 'string', enum: ['error'] },
            error: {
              type: 'object',
              required: ['type', 'message'],
              properties: {
                type: { type: 'string', enum: ['invalid_request_error', 'authentication_error', 'not_found_error', 'rate_limit_error', 'api_error', 'overloaded_error'] },
                message: { type: 'string' },
              },
            },
          },
        },
        SearchRequest: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', description: 'Search query string', minLength: 1 },
            max_results: { type: 'integer', description: 'Number of results to return (1-10, default 5)', minimum: 1, maximum: 10, default: 5 },
          },
        },
        SearchResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            query: { type: 'string' },
            provider: { type: 'string', description: 'Search backend provider (e.g. duckduckgo_html)' },
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  url: { type: 'string' },
                  snippet: { type: 'string', description: 'Result snippet (empty from DuckDuckGo HTML — known limitation)' },
                },
              },
            },
            result_count: { type: 'integer' },
            warning: { type: ['string', 'null'] },
          },
        },
        ModelListResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  display_name: { type: 'string' },
                  created_at: { type: 'string' },
                  type: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }
}
