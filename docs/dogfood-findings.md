# Install dogfood findings (2026-06)

Consolidated report from real **Windows + macOS/Linux-applicable** installs.
Documentation fixes are in this PR; **npm package** behavior changes are tracked
in [Issue #2](https://github.com/yeemio/owlcoda/issues/2).

Contact for this dogfood: **owlclaw@163.com**

## Summary table

| # | Finding | User impact | In this PR (docs) | Product (npm) |
|---|---------|-------------|-------------------|---------------|
| 1 | npm mirror lags behind registry.npmjs.org | Installs old `owlcoda` (e.g. 0.14.49 vs .52) | [troubleshooting.md](troubleshooting.md#npm-registry-mirror-lag-common-in-china) | `doctor` compare registry latest |
| 2 | Orphan daemon on 8019, no PID file | “non-OwlCoda process”; `stop` useless | [troubleshooting.md](troubleshooting.md#port-8019-already-in-use) | healthz-aware stop / message |
| 3 | Fresh install, empty `models[]` | “No usable model” | [install.md](install.md), troubleshooting | First-run wizard copy |
| 4 | `routerUrl` with trailing `/v1` | Local runtime “unreachable” | [install.md](install.md), troubleshooting | Normalize URL in code |
| 5 | Sub-8B / no-tools models in REPL | `400 does not support tools` | [model-requirements.md](model-requirements.md) | Warn/block in Admin/doctor |
| 6 | Agent payload vs `ollama run` chat | “Ollama fast, OwlCoda broken” | [model-requirements.md](model-requirements.md) | Set expectations in UI |
| 7 | **30s streaming headers timeout** | `headers timeout after 30000ms` on CPU | [troubleshooting.md](troubleshooting.md#agent-timeouts-or-400-with-small-local-models-all-platforms) | Raise for local / tool-heavy |
| 8 | Default **model fallback** chain | 30s + 30s trying heavier model | troubleshooting, below | Single-local-model UX |
| 9 | Admin adds model as `endpoint: …/v1` “cloud” | Wrong route, double `/v1`, fallback chaos | [troubleshooting.md](troubleshooting.md#admin-local-model-misconfiguration) | Local vs cloud form |
| 10 | Deleting clone ≠ uninstall | Leftover global npm + `~/.owlcoda` | [troubleshooting.md](troubleshooting.md#clean-reinstall-global-npm-package) | — |
| 11 | `owlcoda init` when Ollama down → empty models | Silent empty config | install.md | Probe or warn |
| 12 | **≥8B policy** for tool agent | Wrong product expectation for 1.5B/4B | [model-requirements.md](model-requirements.md) | Enforce at configure time |

## Detail: 30s headers timeout (finding 7)

**Observed:** `audit.jsonl` shows `headers timeout after 30000ms` with
`durationMs` ≈ 60000 when fallback is enabled.

**Mechanism (0.14.52):** streaming upstream fetch in the proxy uses a **hardcoded
30s** headers phase timeout while the native REPL sends **~47 tool definitions**
per turn. On CPU, Ollama can take **35–40s+** to first byte for that payload —
within Ollama’s limits but **over OwlCoda’s 30s guard**.

**Not the same as:** `routerTimeoutMs` (default 600000) or a broken Ollama install.

**Workarounds:** ≥8B on GPU; cloud provider; `"middleware": { "fallbackEnabled": false }` when testing one local model.

**Product ask:** scale headers timeout for local router / tool-heavy requests; document env override if one exists.

## Detail: fallback chain (finding 8)

**Observed:** Request for `qwen2.5:1.5b` times out at 30s, then fallback tries
`qwen3:4b` (audit: `servedBy` differs from requested `model`, `fallbackUsed: true`).

**User sees:** ~60s then failure — feels like “OwlCoda is broken”, not “model too small”.

**Workaround:** `"middleware": { "fallbackEnabled": false }` in `~/.owlcoda/config.json`.

**Product ask:** do not fallback from small local to larger local on headers timeout;
or surface “primary model too slow for agent tools” explicitly.

## Detail: Admin misconfiguration (finding 9)

**Observed:** Model entry with:

```json
{
  "id": "q",
  "endpoint": "http://localhost:11434/v1",
  "provider": "openai-compat",
  "backendModel": "qwen2.5:1.5b"
}
```

while `routerUrl` is also set — mixes **direct endpoint** routing with **local
runtime** routing. Easy to misconfigure after UI setup.

**Correct local pattern:**

```json
{
  "routerUrl": "http://127.0.0.1:11434",
  "models": [
    {
      "id": "qwen25-1.5b",
      "backendModel": "qwen2.5:1.5b",
      "default": true
    }
  ]
}
```

(No per-model `endpoint` for standard Ollama — let `routerUrl` + `backendModel` apply.)

## Related PR / issues

- **PR #1** — documentation for all rows marked “In this PR”
- **Issue #2** — product tracking for npm package changes
