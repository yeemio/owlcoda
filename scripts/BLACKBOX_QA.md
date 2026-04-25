# Black-box QA Harness

A tmux-driven smoke driver that reproduces the high-churn user-experience
paths end-to-end against a real compiled `dist/cli.js`. Turns the
manually-QA'd regressions of the last few rounds into repeatable artifacts.

## What it covers

| # | Scenario | What it asserts |
|---|----------|-----------------|
| 1 | Boot | Ready prompt visible within 45s |
| 2 | Short reply | First feedback ≤10s, answer ≤20s |
| 3 | Long bash (`sleep 60; echo done`) | Busy feedback ≤15s; idle heartbeat (`idle Xs`) appears within 6s |
| 4 | Queue while busy | Rail shows `queued 1` or `queue on send` within 1s |
| 5 | Ctrl+C cancel | Immediate `Interrupt requested` ack; returns to ready within 3s |
| 6 | Post-cancel recovery | Queued message executes; **no `Conversation repair` warning, no old tool replay** |
| 7 | `/clear` + scrollback | Message confirmation; tmux history cleared too |
| 8 | Multi-line paste + newest-turn visibility | First authored line (`mline-1`) visible after submit; ▎ accent bars present |
| 9 | Content hygiene audit (runs last) | Across every snapshot captured by 1-8: no pseudo-tool-call markers, no raw `tool_result` JSON, no bare workflow-phase labels leaking as transcript content |

Scenario 6 is the direct regression check for the cancel→recovery closure
work — the real-machine bug where cancel triggered `⚠ Conversation
repair: cleaned orphaned tool calls` and re-ran the cancelled bash.

Scenario 8 is the regression check for the newest-turn-atomic visibility
policy — the bug where long user blocks got top-sliced and only their
tail was visible after submit.

Scenario 9 (content hygiene) is a *cross-snapshot* assertion that runs
after every other scenario has captured pane output. It is
deterministic regardless of model behavior — given the same
snapshots, the same verdict — so it's the most reliable regression
guard against raw runtime plumbing (pseudo tool-call markers,
raw JSON dumps, unrendered workflow-phase labels) slipping into the
visible transcript.

## Running

```bash
# Preconditions:
#   - dist/ must be up to date (npm run build)
#   - a model proxy must be listening on the target port (default 19920)
#   - tmux must be installed
#   - $OWLCODA_QA_MODEL must be a model the proxy serves (default minimax-m27)

npm run blackbox              # reuses existing dist/
npm run blackbox:build        # forces a fresh `npm run build` first
```

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `OWLCODA_QA_MODEL` | `minimax-m27` | Model to drive scenarios |
| `OWLCODA_QA_PORT` | `19920` | Proxy port |
| `OWLCODA_QA_COLS` | `120` | tmux pane width |
| `OWLCODA_QA_ROWS` | `40` | tmux pane height |
| `OWLCODA_QA_BUILD` | `0` | Set `1` to force `npm run build` before running |
| `OWLCODA_QA_LOG_DIR` | `/tmp/owlcoda-longtask-<TIMESTAMP>` | Artifact root |

## Artifacts per run

Under `$OWLCODA_QA_LOG_DIR/`:

- `report.md` — pass/fail summary with first-feedback latencies and stall log
- `results.txt` — `PASS: …` / `FAIL: …` per assertion
- `stalls.log` — structured stall records (scenario, stage, duration, summary)
- `session.log` — full stdio of the driven owlcoda process
- `<scenario-label>.txt` — pane snapshot at the moment of each assertion
- `<scenario-label>.history.txt` — extended scrollback capture (select scenarios)
- `home/` — isolated `OWLCODA_HOME` dir for the test run (sessions, configs)

Exit code: `0` if all assertions pass, `1` otherwise. CI-friendly.

## Adding scenarios

1. Append a new `note "Scenario N: <title>"` block to
   `scripts/smoke-longtask-blackbox.sh` after the existing ones.
2. Use `send_enter "<text>"` to drive a single-turn submit,
   `tmux paste-buffer -p` with `tmux load-buffer -b` for multi-line
   pastes, and `tmux send-keys -t "$SESSION:0" C-c` for Ctrl+C.
3. Use `snapshot "<label>"` to dump a pane capture, then grep the
   `$LATEST` pane file. Pair `record_pass "..."` / `record_fail "..."`
   with `log_stall "..."` for anomaly timing.
4. Keep scenarios independent where possible — the driver runs them
   sequentially in one tmux session so earlier failures don't abort
   later coverage.

## Known gaps

- **Final-answer contract validator path** (synthesis / fallback /
  hard-stop transitions) isn't exercised with a deterministic
  trigger yet — the content-hygiene audit (Scenario 9) catches the
  *symptoms* of bad routing but not the state-machine transitions
  themselves. That would need model-input determinism we don't have.
- **Cross-terminal variance** (Terminal.app / iTerm2 vs tmux) isn't
  covered here — tmux is the primary substrate for automation; native
  terminal checks remain manual.
- **Ink Static race** cases (long footer + resize + dense notices)
  aren't easily reproducible through the harness; watermark-v2 +
  the scrollback CSI K padding close the documented source, but
  pathological interleaving under heavy resize + stream load would
  need the deferred Ink-fork round to fully prove absent.
