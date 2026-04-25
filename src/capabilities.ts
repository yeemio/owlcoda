/**
 * OwlCoda capability declarations — honest about what works and what doesn't.
 * Source of truth for supported/partial/unsupported feature tracking.
 */

export type CapabilityStatus = 'supported' | 'partial' | 'best_effort' | 'manual-only' | 'blocked' | 'unsupported'

export interface Capability {
  name: string
  status: CapabilityStatus
  detail: string
}

export const CAPABILITIES: Capability[] = [
  // ── Supported ──
  { name: 'Text chat (streaming)', status: 'supported', detail: 'Full Anthropic SSE stream translation' },
  { name: 'Text chat (non-streaming)', status: 'supported', detail: 'Full request/response translation' },
  { name: 'Multi-turn conversation', status: 'supported', detail: 'Conversation history maintained in REPL' },
  { name: 'Tool use protocol', status: 'supported', detail: 'Anthropic tool_use ↔ OpenAI function_calling translation' },
  { name: 'Platform model registry', status: 'supported', detail: 'Catalog-driven model surface with real platform IDs' },
  { name: 'Model alias resolution', status: 'supported', detail: 'Platform aliases + legacy compatibility aliases' },
  { name: 'Local platform preflight', status: 'supported', detail: 'Local runtime + backend health check before launch, with owlmlx /v1/openai/models as the primary visibility source and old router truth downgraded to deprecated fallback' },
  { name: 'Isolated runtime profile', status: 'supported', detail: 'Dedicated OwlCoda runtime profile in ~/.owlcoda/runtime-profile' },
  { name: 'Native REPL frontend', status: 'supported', detail: 'Default interactive path — native REPL with 42+ tools, 69+ commands, session persistence' },
  { name: 'Native terminal interface', status: 'supported', detail: 'Interactive terminal UI with OwlCoda themes, command shell, and session-aware status bar' },
  { name: 'Selection-first transcript interaction', status: 'supported', detail: 'Main REPL stays on the primary screen so terminal-native drag-select and copy remain available.' },
  { name: 'Daemon lifecycle', status: 'supported', detail: 'start/stop/status with identity verification, live-client-aware refusal, and force-stop that only detaches matching runtime clients' },
  { name: 'Multi-client live REPL', status: 'supported', detail: 'Multiple live REPL clients can share one daemon; registry tracks clientId, PID, runtime token, and session affinity' },
  { name: 'Live client control plane', status: 'supported', detail: 'owlcoda clients lists active clients and supports detach / force-detach without stopping the daemon' },
  { name: 'Live client registry safety', status: 'supported', detail: 'Registry mutations use a lock + atomic rename to avoid concurrent last-writer-wins corruption' },
  { name: 'Tool execution (local)', status: 'supported', detail: 'Bash, Read, Write, Glob with safety approval + workspace boundary' },
  { name: 'Session persistence', status: 'supported', detail: 'Conversation history saved to ~/.owlcoda/sessions/' },
  { name: 'Non-interactive mode', status: 'supported', detail: 'owlcoda run --prompt with auto preflight + proxy ensure' },
  { name: 'Session resume', status: 'supported', detail: '/resume or --resume restores session model + full message history; --resume last skips sessions actively owned by other live REPL clients' },
  { name: 'JSON output', status: 'supported', detail: 'owlcoda run --json outputs {text, model, session_id, resumed, exit_code, tool_calls}' },
  { name: 'Workspace boundary', status: 'supported', detail: 'Read/Glob/Write outside cwd requires explicit approval' },
  { name: 'Transcript integrity', status: 'supported', detail: 'Session files include all messages: user, assistant, tool_use, tool_result' },
  { name: 'CLI --model flag', status: 'supported', detail: 'Select model in launch, run, or REPL by platform ID, alias, or partial match' },
  { name: 'Headless mode (-p)', status: 'supported', detail: 'node dist/cli.js -p "prompt" returns LLM response end-to-end' },
  { name: 'Interactive terminal chat', status: 'supported', detail: 'Single-turn, multi-turn, and slash-command chat in the native terminal UI' },
  { name: '/model picker & switching', status: 'supported', detail: 'Picker shows OwlCoda models; switching changes subsequent API requests (verified e2e)' },

  // ── Partial / Best-effort / Manual-only ──
  { name: '/cost display', status: 'partial', detail: 'Token counts real; durations real; USD uses Anthropic cloud pricing — not meaningful for local models. Warning displayed.' },
  { name: 'Wheel / trackpad transcript scroll', status: 'partial', detail: 'Terminal.app direct terminal-owned scrollback path verified. Real tmux wheel passthrough is not guaranteed in selection-first mode; use PgUp/PgDn, Ctrl+↓, or tmux scrollback. iTerm2 verification pending.' },
  { name: 'Image input', status: 'best_effort', detail: 'Protocol supports it; requires multimodal backend model' },
  { name: 'Model availability', status: 'supported', detail: 'Live runtime probe at startup; owlmlx direct path uses /v1/openai/models for visibility, /v1/runtime/model-visibility for diagnostics, and treats /v1/models as loaded inventory only' },
  { name: 'LSP tool', status: 'manual-only', detail: 'Tool registered (ENABLE_LSP_TOOL=1); requires plugin with lspServers config. Install typescript-language-server globally, then configure a plugin.' },

  // ── MCP (unstubbed Round 3) ──
  { name: 'MCP server support', status: 'supported', detail: 'MCP client unstubbed (Round 3). Stdio MCP servers connect via .mcp.json. 14 tools registered and callable in headless/TUI. Tested with @modelcontextprotocol/server-filesystem.' },

  // ── DX / Debug ──
  { name: 'Request/response tracing', status: 'supported', detail: 'OWLCODA_TRACE=1 or /trace command writes JSON to ~/.owlcoda/trace/' },
  { name: '/tokens usage display', status: 'supported', detail: '/tokens shows cumulative input/output/total token counts for session' },
  { name: '/budget context window', status: 'supported', detail: '/budget shows used vs estimated context window with percentage' },
  { name: '/config runtime view', status: 'supported', detail: '/config shows active model, proxy, router, flags, session info' },
  { name: 'Plugin system', status: 'supported', detail: 'Plugins in ~/.owlcoda/plugins/<name>/index.js. Hooks: onRequest, onResponse, onToolCall, onError, onLoad, onUnload. /plugins to list/reload.' },
  { name: 'Session export', status: 'supported', detail: '/export [markdown] writes session to ~/.owlcoda/exports/ as JSON or markdown' },
  { name: 'Error diagnostics', status: 'supported', detail: '/doctor shows recent errors, uptime, trace status, token summary' },

  // ── Session Intelligence ──
  { name: '/sessions browser', status: 'supported', detail: '/sessions lists recent sessions, /sessions search, /sessions info, /sessions delete' },
  { name: '/tag session tagging', status: 'supported', detail: '/tag add|remove|list|search — tags persist in session JSON' },
  { name: '/compress session', status: 'supported', detail: '/compress --trim N trims messages; LLM summary mode available if proxy is running' },
  { name: 'Session content search', status: 'supported', detail: '/sessions search <query> — full-text search across all session content' },

  // ── Session Branching & Catalog ──
  { name: '/history message viewer', status: 'supported', detail: '/history [N] — view recent messages from current or specified session' },
  { name: '/branch session fork', status: 'supported', detail: '/branch [name] — deep copy session with parent link for exploratory conversations' },
  { name: '/branches list', status: 'supported', detail: '/branches — list all branches of current session' },
  { name: 'Session catalog index', status: 'supported', detail: 'Persistent metadata index at ~/.owlcoda/sessions/.index.json for faster search' },

  // ── Serve Mode ──
  { name: 'owlcoda serve', status: 'supported', detail: 'Standalone HTTP API server: owlcoda serve [--port N]. No TUI, no upstream. Preflight + structured output.' },
  { name: '/health endpoint', status: 'supported', detail: 'GET /health — status, version, uptime, model list' },
  { name: '/v1/api-info endpoint', status: 'supported', detail: 'GET /v1/api-info — API discovery with endpoint list' },

  // ── Unsupported (cloud-only) ──
  { name: 'Hosted OAuth', status: 'unsupported', detail: 'Cloud-only. OwlCoda uses local API key approval' },
  { name: 'Extended thinking', status: 'unsupported', detail: 'Stripped during translation — local models do not support' },
  { name: 'Prompt caching', status: 'unsupported', detail: 'Hosted-provider feature, not applicable locally' },
  { name: 'Computer use', status: 'unsupported', detail: 'Not supported by local models' },
  { name: 'GrowthBook feature flags', status: 'unsupported', detail: 'Cloud analytics — disabled locally' },
  { name: 'Remote managed settings', status: 'unsupported', detail: 'Org policy from cloud — not applicable' },
  { name: 'Usage / subscription tracking', status: 'unsupported', detail: 'Cloud billing — stub returns zero' },
  { name: 'Analytics / telemetry', status: 'unsupported', detail: 'All telemetry disabled in local mode' },
  { name: 'Hosted login UI', status: 'unsupported', detail: 'OAuth flow not applicable in native mode — use /login to set API keys directly' },

  // ── Phase 4: Middleware & Observability ──
  { name: 'Request ID tracing', status: 'supported', detail: 'UUID per request, x-request-id header on every response' },
  { name: 'Per-model rate limiting', status: 'supported', detail: 'Token bucket 60 RPM per model, enforced on /v1/messages with 429 + Retry-After' },
  { name: 'Retry with backoff', status: 'supported', detail: 'Exponential backoff on 5xx/timeout wired into both streaming and non-streaming fetch paths' },
  { name: 'Observability dashboard', status: 'supported', detail: 'GET /dashboard — requests, errors, duration, token usage, rate limits' },
  { name: 'Graceful shutdown drain', status: 'supported', detail: 'Stop accepting → drain 30s → force exit' },
  { name: '/cost command', status: 'supported', detail: 'Token usage breakdown in TUI' },
  { name: '/dashboard command', status: 'supported', detail: 'Observability metrics (requests, errors, duration, tokens) in TUI' },
  { name: '/ratelimit command', status: 'supported', detail: 'Per-model rate limit bucket status in TUI' },

  // ── Phase 4: Production Hardening (Round 16) ──
  { name: 'Model fallback chain', status: 'supported', detail: 'API middleware can auto-fallback on 5xx/connection failure; interactive REPL keeps the selected model unless the user switches it' },
  { name: 'Config hot-reload', status: 'supported', detail: 'Watch config.json for changes, validate and apply without restart' },
  { name: 'Persistent audit log', status: 'supported', detail: 'Append-only JSONL at ~/.owlcoda/audit.jsonl with auto-rotation at 10MB' },
  { name: 'Background health monitor', status: 'supported', detail: 'Proactive model health checks every 60s, cached results' },
  { name: 'x-owlcoda-served-by header', status: 'supported', detail: 'Every response identifies which backend model served the request' },

  // ── Phase 4: Circuit Breaker & Fallback (Round 17) ──
  { name: 'Circuit breaker', status: 'supported', detail: 'Auto-disable models after 5 consecutive failures, 60s cooldown, half-open probe' },
  { name: 'Full fallback routing', status: 'supported', detail: 'Non-streaming: auto-fallback to next model via withFallback + health filter + circuit breaker' },
  { name: 'Streaming circuit tracking', status: 'supported', detail: 'Streaming: recordSuccess/recordFailure but no cross-model fallback (deferred)' },
  { name: 'Configurable middleware', status: 'supported', detail: 'config.json middleware section: rateLimitRpm, retryMaxAttempts, fallbackEnabled, etc.' },
  { name: '/audit command', status: 'supported', detail: 'View recent audit log entries with token counts and fallback status' },
  { name: '/health command', status: 'supported', detail: 'View model health + circuit breaker state per model' },

  // ── Phase 4: Config-driven middleware, validation, error budget (Round 18) ──
  { name: 'Config-driven middleware', status: 'supported', detail: 'config.json middleware values consumed by rate-limit, retry, circuit breaker, fallback' },
  { name: 'Request body validation', status: 'supported', detail: 'validateMessagesBody: model, messages, max_tokens, stream checked before routing' },
  { name: 'Error budget tracking', status: 'supported', detail: 'Per-model rolling-window success rate with configurable SLO target' },
  { name: '/slo command', status: 'supported', detail: 'View per-model error budget, success rate, and SLO compliance' },
  { name: 'SLO in dashboard', status: 'supported', detail: 'Error budgets surfaced in /dashboard REPL and GET /dashboard endpoint' },
  { name: 'Config-driven SLO target', status: 'supported', detail: 'sloTargetPercent in middleware config, hot-reloadable' },

  // ── Phase 4: OpenAPI, Tracing, Timeout Resilience (Round 19) ──
  { name: 'OpenAPI 3.0 spec', status: 'supported', detail: 'GET /openapi.json — machine-readable API documentation' },
  { name: 'Request tracing', status: 'supported', detail: 'Per-request timing waterfall with phase marks, circular buffer of last 50' },
  { name: 'x-owlcoda-duration-ms header', status: 'supported', detail: 'Total request duration in every non-streaming response' },
  { name: 'Overall request timeout', status: 'supported', detail: 'requestTimeoutMs in config (default 120s), returns 504 on exceeded' },
  { name: 'Request size limits', status: 'supported', detail: 'maxRequestBodyBytes in config (default 10MB), returns 413 on exceeded' },
  { name: '/traces command', status: 'supported', detail: 'View recent request timing waterfalls' },

  // Round 20 — structured logging, streaming tracing, admin API
  { name: 'Structured JSON logging', status: 'supported', detail: 'All proxy log output as JSON on stderr with ts/level/component/msg/data fields' },
  { name: 'Configurable log level', status: 'supported', detail: 'logLevel in config (debug/info/warn/error), hot-reloadable' },
  { name: 'Streaming request tracing', status: 'supported', detail: 'Full trace marks in streaming path: received→routed→fetch_start→fetch_end→stream_start→stream_end' },
  { name: 'Admin API: reset circuit breakers', status: 'supported', detail: 'POST /admin/reset-circuit-breakers — reset all circuit breakers to closed' },
  { name: 'Admin API: reset budgets', status: 'supported', detail: 'POST /admin/reset-budgets — reset all error budget windows' },
  { name: 'Admin API: reload config', status: 'supported', detail: 'POST /admin/reload-config — reload safe fields from config.json' },
  { name: 'Admin API: view config', status: 'supported', detail: 'GET /admin/config — current effective config (apiKeys redacted)' },
  { name: 'Admin API: request traces', status: 'supported', detail: 'GET /admin/requests?count=N — recent request traces' },
  { name: 'Admin API: audit log', status: 'supported', detail: 'GET /admin/audit?count=N — recent audit log entries' },
  { name: '/reset-circuits command', status: 'supported', detail: 'Reset all circuit breakers from REPL' },
  { name: '/reset-budgets command', status: 'supported', detail: 'Reset all error budget windows from REPL' },

  // Round 21 — Prometheus metrics, log file rotation, admin auth, deep healthz, config validation
  { name: 'Prometheus /metrics endpoint', status: 'supported', detail: 'OpenMetrics text format with 11 metric families: uptime, requests, by-model, by-status, duration, tokens, rate-limits, circuits, budgets, errors' },
  { name: 'Log file output with rotation', status: 'supported', detail: 'Sync append to logFilePath, auto-rotate at logFileMaxBytes, keep logFileKeep rotated files' },
  { name: 'Admin auth (Bearer token)', status: 'supported', detail: 'Optional adminToken protects /admin/* endpoints; backward compatible (no token = open access)' },
  { name: 'Deep health probe', status: 'supported', detail: '/healthz returns router reachability/latency/modelCount, circuit breaker states, error budgets, overall status (healthy/degraded/unhealthy)' },
  { name: 'Config schema validation', status: 'supported', detail: 'Validates types, ranges, enum values for all config fields; warns on load + hot-reload + admin reload' },
  { name: '/metrics REPL command', status: 'supported', detail: 'Display Prometheus metrics in REPL' },
  { name: 'Health status levels', status: 'supported', detail: 'Three-level health: healthy (all good), degraded (some circuits open), unhealthy (router down / all circuits open)' },
  { name: 'Configurable log file retention', status: 'supported', detail: 'logFileMaxBytes (default 10MB) and logFileKeep (default 3) in config' },

  // Round 22 — model config hardening, degradation testing
  { name: 'Model config normalization', status: 'supported', detail: 'Crash-proof defaults for all ConfiguredModel fields; aliases never undefined' },
  { name: 'Degradation mode e2e verified', status: 'supported', detail: 'Deep healthz three-level status tested; identity matching accepts all health states' },
  { name: 'Config watcher model normalization', status: 'supported', detail: 'Hot-reload normalizes models with safe defaults, never crashes on malformed definitions' },

  // Round 23 — CLI module split, SSE live metrics, cost honesty
  { name: 'CLI module split', status: 'supported', detail: 'cli-core.ts split into healthz-client.ts (HTTP health checking) and daemon.ts (process lifecycle); backward-compatible re-exports' },
  { name: 'SSE live metrics stream', status: 'supported', detail: 'GET /events/metrics pushes metrics JSON every 2s via text/event-stream; initial snapshot on connect' },
  { name: 'Cost display honesty', status: 'supported', detail: '/v1/usage includes pricingNote: estimated_cloud_rates — local inference costs zero, displayed rates are for comparison only' },

  // Round 24 — admin route extraction, OpenAPI completeness
  { name: 'Admin route module', status: 'supported', detail: 'Admin handlers extracted to src/routes/admin.ts; testable in isolation with mock deps' },
  { name: 'OpenAPI completeness', status: 'supported', detail: 'OpenAPI spec covers all endpoints including /events/metrics SSE, /v1/usage, /v1/api-info, all admin routes' },

  // Round 25 — model registry extraction, resilience tests
  { name: 'Model registry module', status: 'supported', detail: 'Model types and resolution extracted to src/model-registry.ts; config.ts now ≤314 lines' },
  { name: 'Error budget edge coverage', status: 'supported', detail: 'Exhaustion, recovery, concurrent models, rolling window cap, SLO clamping all tested' },
  { name: 'Circuit breaker edge coverage', status: 'supported', detail: 'Open/half-open/closed transitions, independence, reset, threshold boundary all tested' },
  { name: 'Model resolution edge coverage', status: 'supported', detail: 'Alias collision, date stripping, substring match, empty config, cloud endpoint routing all tested' },
]

export function getCapabilitiesByStatus(status: CapabilityStatus): Capability[] {
  return CAPABILITIES.filter(c => c.status === status)
}

export function getSupportedCapabilities(): Capability[] {
  return CAPABILITIES.filter(c => c.status === 'supported')
}

export function getUnsupportedCapabilities(): Capability[] {
  return CAPABILITIES.filter(c => c.status === 'unsupported')
}

export function getCapabilitySummary(): string {
  const supported = CAPABILITIES.filter(c => c.status === 'supported').length
  const partial = CAPABILITIES.filter(c => c.status === 'partial' || c.status === 'best_effort' || c.status === 'manual-only').length
  const blocked = CAPABILITIES.filter(c => c.status === 'blocked').length
  const unsupported = CAPABILITIES.filter(c => c.status === 'unsupported').length
  return `${supported} supported, ${partial} partial/manual, ${blocked} blocked, ${unsupported} unsupported (cloud-only)`
}
