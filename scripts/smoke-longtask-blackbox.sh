#!/usr/bin/env bash
# OwlCoda long-task black-box QA driver.
#
# Focus:
# - long tool-heavy / bash-heavy task behavior
# - busy / queued visibility
# - idle-stall heartbeat truth
# - Ctrl+C true cancel
# - post-cancel recovery
# - /clear + tmux history cleanup
#
# This script intentionally does not read or mutate repo files other than
# using the compiled dist entrypoint. It drives a real PTY through tmux and
# captures pane snapshots as ground-truth artifacts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

MODEL="${OWLCODA_QA_MODEL:-minimax-m27}"
PORT="${OWLCODA_QA_PORT:-19920}"
COLS="${OWLCODA_QA_COLS:-120}"
ROWS="${OWLCODA_QA_ROWS:-40}"
BUILD_FIRST="${OWLCODA_QA_BUILD:-0}"
SESSION="owlcoda-lt-$PORT"

RUN_ID="$(date '+%Y%m%d-%H%M%S')"
LOG_DIR="${OWLCODA_QA_LOG_DIR:-/tmp/owlcoda-longtask-$RUN_ID}"
OWLCODA_HOME_DIR="$LOG_DIR/home"
SESSION_LOG="$LOG_DIR/session.log"
STALL_LOG="$LOG_DIR/stalls.log"
REPORT="$LOG_DIR/report.md"
LATEST="$LOG_DIR/latest.txt"

PASS=0
FAIL=0

mkdir -p "$LOG_DIR" "$OWLCODA_HOME_DIR"
: > "$STALL_LOG"

now_s() {
  date '+%s'
}

ts() {
  date '+%H:%M:%S'
}

note() {
  printf '[%s] %s\n' "$(ts)" "$*"
}

capture_current() {
  tmux capture-pane -pt "$SESSION:0" > "$LATEST"
}

capture_history() {
  local label=$1
  tmux capture-pane -pt "$SESSION:0" -S -300 > "$LOG_DIR/${label}.history.txt"
}

snapshot() {
  local label=$1
  capture_current
  cp "$LATEST" "$LOG_DIR/${label}.txt"
}

log_stall() {
  local scenario=$1
  local stage=$2
  local seconds=$3
  local summary=$4
  printf '[%s] scenario=%s stage=%s duration=%ss summary=%s\n' \
    "$(ts)" "$scenario" "$stage" "$seconds" "$summary" >> "$STALL_LOG"
}

record_pass() {
  local msg=$1
  PASS=$((PASS + 1))
  printf 'PASS: %s\n' "$msg" >> "$LOG_DIR/results.txt"
}

record_fail() {
  local msg=$1
  FAIL=$((FAIL + 1))
  printf 'FAIL: %s\n' "$msg" >> "$LOG_DIR/results.txt"
}

wait_for_regex() {
  local regex=$1
  local timeout_s=$2
  local start
  start="$(now_s)"
  while true; do
    capture_current
    if grep -Eq "$regex" "$LATEST"; then
      printf '%s\n' $(( $(now_s) - start ))
      return 0
    fi
    if [ $(( $(now_s) - start )) -ge "$timeout_s" ]; then
      return 1
    fi
    sleep 1
  done
}

wait_for_quiet_regex() {
  local regex=$1
  local timeout_s=$2
  local start
  start="$(now_s)"
  while true; do
    capture_current
    if ! grep -Eq "$regex" "$LATEST"; then
      printf '%s\n' $(( $(now_s) - start ))
      return 0
    fi
    if [ $(( $(now_s) - start )) -ge "$timeout_s" ]; then
      return 1
    fi
    sleep 1
  done
}

send_enter() {
  local text=$1
  tmux send-keys -t "$SESSION:0" -l -- "$text"
  tmux send-keys -t "$SESSION:0" Enter
}

cleanup() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
}

trap cleanup EXIT

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required for this script." >&2
  exit 1
fi

if [ "$BUILD_FIRST" = "1" ]; then
  note "Building project first"
  (cd "$PROJECT_DIR" && npm run build)
fi

note "Launching isolated OwlCoda session"
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x "$COLS" -y "$ROWS" \
  "cd '$PROJECT_DIR' && env OWLCODA_HOME='$OWLCODA_HOME_DIR' OWLCODA_AUTO_APPROVE=1 node dist/cli.js --port '$PORT' --model '$MODEL' 2>&1 | tee '$SESSION_LOG'"

note "Waiting for ready prompt"
if wait_for_regex 'Enter send · Shift\+Enter newline|Ctrl\+C cancels the active task' 45 >/dev/null; then
  snapshot "boot-ready"
  record_pass "boot ready"
else
  snapshot "boot-timeout"
  record_fail "boot did not reach ready prompt"
  cat > "$REPORT" <<EOF
# OwlCoda Long-Task Black-Box Report

- Environment: model=$MODEL port=$PORT cols=$COLS rows=$ROWS
- Verdict: failed to boot into ready prompt
- Artifacts: $LOG_DIR
EOF
  exit 1
fi

SHORT_PROMPT='1+1等于几？只回复 2。'
LONG_PROMPT='Use bash to run exactly: sleep 60; echo done. After it finishes, reply with DONE only.'
QUEUE_PROMPT='After cancellation, reply with QUEUE_OK only.'

note "Scenario 1: short reply"
short_start="$(now_s)"
send_enter "$SHORT_PROMPT"
if short_feedback="$(wait_for_regex 'busy|Thinking|Receiving response|⎿' 10)"; then
  :
else
  short_feedback='>10'
  snapshot "short-no-feedback"
  log_stall "short_reply" "first_feedback" "10+" "no visible feedback within 10s"
  record_fail "short reply had no visible feedback within 10s"
fi
if wait_for_regex '1 \+ 1 = 2|只回复 2|⎿  2' 20 >/dev/null; then
  short_total=$(( $(now_s) - short_start ))
  snapshot "short-reply"
  record_pass "short reply finished in ${short_total}s (first feedback ${short_feedback}s)"
else
  short_total=$(( $(now_s) - short_start ))
  snapshot "short-timeout"
  log_stall "short_reply" "completion" "$short_total" "did not observe final answer"
  record_fail "short reply did not finish cleanly"
fi

note "Scenario 2: long bash task"
long_start="$(now_s)"
send_enter "$LONG_PROMPT"
if long_feedback="$(wait_for_regex 'Running…|Running bash|Bash \(sleep 60; echo done\)|Thinking|Receiving response' 15)"; then
  :
else
  long_feedback='>15'
  snapshot "long-no-feedback"
  log_stall "long_task" "first_feedback" "15+" "no visible feedback within 15s"
  record_fail "long task had no visible feedback within 15s"
fi

if wait_for_regex 'Bash \(sleep 60; echo done\)' 30 >/dev/null; then
  :
else
  snapshot "long-bash-not-started"
  log_stall "long_task" "bash_start" "30+" "model did not start the requested long bash command"
  record_fail "long bash command did not start within 30s"
fi

sleep 6
snapshot "long-after-6s"
if grep -Eq 'idle [0-9]+s' "$LATEST"; then
  record_pass "idle heartbeat visible during long task"
else
  log_stall "long_task" "idle_truth" "6+" "still busy/running without idle suffix"
  record_fail "idle heartbeat missing during long task"
fi

note "Scenario 3: queue while busy"
send_enter "$QUEUE_PROMPT"
sleep 1
snapshot "queue-while-busy"
if grep -Eq 'queued 1|queue on send' "$LATEST"; then
  record_pass "queued state visible while busy"
else
  log_stall "queue" "visibility" "1+" "queued state not visible"
  record_fail "queued state not visible while busy"
fi

note "Scenario 4: Ctrl+C cancel"
cancel_start="$(now_s)"
tmux send-keys -t "$SESSION:0" C-c
sleep 1
snapshot "cancel-after-1s"
if grep -Eq 'Interrupt requested|Cancelling current task|interrupting' "$LATEST"; then
  record_pass "Ctrl+C produced immediate visible feedback"
else
  log_stall "ctrl_c" "ack" "1+" "no immediate cancel feedback"
  record_fail "Ctrl+C lacked immediate visible feedback"
fi

if cancel_elapsed="$(wait_for_regex '· ready ·|Enter send · Shift\+Enter newline' 8)"; then
  snapshot "cancel-ready"
  if [ "$cancel_elapsed" -le 3 ]; then
    record_pass "Ctrl+C returned to ready in ${cancel_elapsed}s"
  else
    log_stall "ctrl_c" "unwind" "$cancel_elapsed" "returned to ready but exceeded 3s target"
    record_fail "Ctrl+C unwind took ${cancel_elapsed}s (>3s target)"
  fi
else
  snapshot "cancel-timeout"
  log_stall "ctrl_c" "unwind" "8+" "did not return to ready within 8s"
  record_fail "Ctrl+C did not return to ready within 8s"
fi

note "Scenario 5: post-cancel recovery"
queue_answer_regex='^[[:space:]]*⎿[[:space:]]*QUEUE_OK[[:space:]]*$|^[[:space:]]{0,4}QUEUE_OK[[:space:]]*$'
if wait_for_regex "$queue_answer_regex" 12 >/dev/null; then
  snapshot "post-cancel-recovery"
  record_pass "post-cancel queued message executed correctly"
else
  snapshot "post-cancel-recovery"
  if grep -Eq 'Conversation repair' "$LATEST"; then
    log_stall "post_cancel" "recovery" "12+" "queue recovery triggered conversation repair"
    record_fail "post-cancel recovery is wrong (conversation repair)"
  else
    log_stall "post_cancel" "recovery" "12+" "queued message neither answered nor clearly failed"
    record_fail "post-cancel recovery did not produce queued answer"
  fi
fi

note "Scenario 6: clear"
send_enter "/clear"
sleep 2
snapshot "clear"
capture_history "clear"
if grep -q 'Conversation cleared\.' "$LOG_DIR/clear.txt"; then
  if grep -Eq '1\+1等于几|sleep 60; echo done|QUEUE_OK|DONE only' "$LOG_DIR/clear.history.txt"; then
    log_stall "clear" "history" "2+" "historical transcript still visible after /clear"
    record_fail "/clear did not fully clear tmux history"
  else
    record_pass "/clear removed transcript from current pane history"
  fi
else
  record_fail "/clear did not acknowledge"
fi

note "Scenario 7: newest-turn visibility with multi-line paste"
# Exercise both the newest-turn-atomic visibility policy AND the
# multi-line authoring surface. We inject an 8-line message via
# tmux bracketed paste (so the authoring layer sees a real paste
# event, not simulated keystrokes), submit with Enter, and capture
# the pane immediately — before the model response has time to
# push the user block off-screen.
#
# Pass criteria:
#   - "mline-1" (the FIRST authored line) is visible — guards
#     against the real-machine QA bug where long user blocks got
#     top-sliced and only their tail was visible.
#   - "mline-8" (the LAST authored line) is also visible OR the
#     block at least rendered in full-ish form (≥5 lines).
#   - Every visible authored line carries the ▎ accent bar —
#     multiline authoring surface integrity.
MULTILINE_CONTENT=''
for i in 1 2 3 4 5 6 7 8; do
  MULTILINE_CONTENT+="mline-$i just reply OK only\n"
done
# Drop the trailing \n — we want the final Enter to be the submit,
# not part of the paste body.
MULTILINE_CONTENT=${MULTILINE_CONTENT%\\n}

printf '%b' "$MULTILINE_CONTENT" | tmux load-buffer -b owlcoda_mline -
tmux paste-buffer -t "$SESSION:0" -b owlcoda_mline -p
sleep 1
tmux send-keys -t "$SESSION:0" Enter
sleep 2
snapshot "multiline-after-submit"

multiline_first_visible=0
multiline_last_visible=0
multiline_bar_count=0
if grep -q 'mline-1' "$LATEST"; then
  multiline_first_visible=1
fi
if grep -q 'mline-8' "$LATEST"; then
  multiline_last_visible=1
fi
multiline_bar_count=$(grep -c '▎' "$LATEST" || true)

if [ "$multiline_first_visible" = "1" ]; then
  record_pass "multiline first line (mline-1) visible after submit"
else
  log_stall "multiline" "first_visible" "2+" "first authored line not visible — newest-turn-atomic regression"
  record_fail "multiline first line (mline-1) not visible — newest-turn cut from top"
fi

if [ "$multiline_last_visible" = "1" ]; then
  record_pass "multiline last line (mline-8) visible after submit"
else
  # Not a hard fail — if block + model response overflowed budget,
  # newest-turn-atomic will show the FIRST budget lines. Record as
  # stall only, not fail.
  log_stall "multiline" "last_visible" "2+" "last authored line not in frame (may be expected under tight budget)"
fi

if [ "$multiline_bar_count" -ge 3 ]; then
  record_pass "multiline ▎ accent bars present (${multiline_bar_count}×)"
else
  log_stall "multiline" "accent_bars" "2+" "too few ▎ bars (${multiline_bar_count}×) — authoring rail broken"
  record_fail "multiline authoring ▎ accent bars missing (only ${multiline_bar_count})"
fi

note "Scenario 8: content hygiene audit across all captured snapshots"
# Runtime plumbing that should NEVER surface as visible transcript
# content. These patterns appearing in a pane snapshot is a concrete
# regression:
#
#   - Raw pseudo-tool-call markers: the model sometimes tries to emit
#     `[TOOL_CALL]{...}[/TOOL_CALL]` or XML-ish `<invoke name=...>`
#     style sequences. scrubPseudoToolCall strips these from the
#     echoed user text AND the streamed assistant text. If one shows
#     up in a rendered pane, the scrubber missed it or a new variant
#     slipped through.
#
#   - Raw JSON tool_result frame leakage: well-formed tool output
#     should be rendered via formatToolEnd / formatToolResultBox,
#     never as raw `{"type":"tool_result", ...}` objects in transcript.
#
#   - Workflow-phase labels (`Synthesis phase:`, `Targeted check:`,
#     `Fallback synthesis:`, `Hard stop:`, `Constrained continuation:`)
#     appearing as *persistent transcript rows* rather than inline
#     status. loop-noise.ts routes these to formatPlatformEvent which
#     prefixes them with `ℹ ` — a bare starting-of-line label without
#     the prefix means the transcript summary logic or rendering
#     missed the routing.
#
# This scenario runs at the END of the driver so it can audit every
# snapshot captured during scenarios 1-7. Non-deterministic by model
# input, fully deterministic given a captured snapshot.

hygiene_pseudo_fails=0
hygiene_json_leak_fails=0
hygiene_phase_leak_fails=0

for snap in "$LOG_DIR"/*.txt; do
  [ -f "$snap" ] || continue
  snapname="$(basename "$snap")"
  # Skip control files that aren't pane captures.
  case "$snapname" in
    results.txt|latest.txt) continue ;;
  esac

  if grep -qE '\[TOOL_CALL\]|\[/TOOL_CALL\]|</invoke>|<invoke name=|</antml' "$snap"; then
    log_stall "hygiene" "pseudo_tool_call_leak" "0" "raw tool-call markers in $snapname"
    hygiene_pseudo_fails=$((hygiene_pseudo_fails + 1))
  fi

  # Bare tool_result JSON leakage — at minimum the opening literal
  # on its own line strongly suggests a raw dump. formatToolEnd
  # renders as text; this pattern shouldn't appear pane-rendered.
  if grep -qE '^\{"type":"tool_result"' "$snap"; then
    log_stall "hygiene" "json_leak" "0" "raw tool_result JSON in $snapname"
    hygiene_json_leak_fails=$((hygiene_json_leak_fails + 1))
  fi

  # Workflow-phase labels at start of a line (no `ℹ ` prefix) →
  # the loop-noise formatter was bypassed. Inline-status phase
  # copy uses other strings ("Synthesizing final answer",
  # "Targeted verification" — see ink-repl.tsx phaseDetail) and
  # would not false-positive on these.
  if grep -qE '^(Synthesis phase:|Targeted check:|Fallback synthesis:|Hard stop:|Constrained continuation:) ' "$snap"; then
    log_stall "hygiene" "workflow_phase_leak" "0" "raw workflow-phase label in $snapname"
    hygiene_phase_leak_fails=$((hygiene_phase_leak_fails + 1))
  fi
done

if [ "$hygiene_pseudo_fails" = "0" ]; then
  record_pass "no pseudo-tool-call marker leaks across any snapshot"
else
  record_fail "$hygiene_pseudo_fails snapshot(s) contain pseudo-tool-call markers"
fi

if [ "$hygiene_json_leak_fails" = "0" ]; then
  record_pass "no raw tool_result JSON leaks across any snapshot"
else
  record_fail "$hygiene_json_leak_fails snapshot(s) contain raw tool_result JSON"
fi

if [ "$hygiene_phase_leak_fails" = "0" ]; then
  record_pass "no bare workflow-phase label leaks across any snapshot"
else
  record_fail "$hygiene_phase_leak_fails snapshot(s) contain bare workflow-phase labels"
fi

cat > "$REPORT" <<EOF
# OwlCoda Long-Task Black-Box Report

## Environment
- Model: $MODEL
- Port: $PORT
- Cols x Rows: ${COLS}x${ROWS}
- OWLCODA_HOME: $OWLCODA_HOME_DIR
- Session log: $SESSION_LOG

## Summary
- Pass: $PASS
- Fail: $FAIL

## Key findings
- Short reply first feedback: ${short_feedback}s
- Long-task first feedback: ${long_feedback}s
- Artifacts directory: $LOG_DIR

## Results
$(sed 's/^/- /' "$LOG_DIR/results.txt" 2>/dev/null || true)

## Stall log
$(sed 's/^/- /' "$STALL_LOG" 2>/dev/null || true)

## Snapshot files
$(cd "$LOG_DIR" && ls -1 *.txt 2>/dev/null | sed 's/^/- /')
EOF

note "Report written to $REPORT"
cat "$REPORT"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
