#!/usr/bin/env bash
# Deterministic interactive Runtime Truth smoke.
#
# Drives the real OwlCoda interactive REPL through tmux, forces an
# empty-provider-response via a local fake router, exits the REPL, then audits
# the saved session for runtime_auto_retry_suppression with the interactive
# surface. This is dogfood-shaped without depending on a random upstream outage.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

MODEL="${OWLCODA_QA_MODEL:-mimo-v2.5-pro}"
COLS="${OWLCODA_QA_COLS:-120}"
ROWS="${OWLCODA_QA_ROWS:-36}"
RUN_ID="$(date '+%Y%m%d-%H%M%S')"
LOG_DIR="${OWLCODA_QA_LOG_DIR:-/tmp/owlcoda-interactive-retry-suppression-$RUN_ID}"
OWLCODA_HOME_DIR="$LOG_DIR/home"
CONFIG_PATH="$LOG_DIR/config.json"
SESSION="owlcoda-retry-suppression-$RUN_ID"
SESSION_LOG="$LOG_DIR/session.log"
LATEST="$LOG_DIR/latest.txt"
EVENT_JSON="$LOG_DIR/event.json"
ROUTER_LOG="$LOG_DIR/router-requests.jsonl"

ROUTER_PID=""

mkdir -p "$LOG_DIR" "$OWLCODA_HOME_DIR"

note() {
  printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

get_free_port() {
  node -e "const net=require('node:net'); const s=net.createServer(); s.listen(0,'127.0.0.1',()=>{const p=s.address().port; s.close(()=>console.log(p));});"
}

capture_current() {
  tmux capture-pane -pt "$SESSION:0" > "$LATEST"
}

wait_for_regex() {
  local regex=$1
  local timeout_s=$2
  local start
  start="$(date '+%s')"
  while true; do
    capture_current || true
    if [ -f "$LATEST" ] && grep -Eq "$regex" "$LATEST"; then
      return 0
    fi
    if [ $(( $(date '+%s') - start )) -ge "$timeout_s" ]; then
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
  if [ -n "$ROUTER_PID" ]; then
    kill "$ROUTER_PID" 2>/dev/null || true
  fi
  if [ -f "$OWLCODA_HOME_DIR/owlcoda.pid" ]; then
    local pid
    pid="$(cat "$OWLCODA_HOME_DIR/owlcoda.pid" 2>/dev/null || true)"
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
    fi
  fi
}

trap cleanup EXIT

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required for this smoke." >&2
  exit 2
fi

ROUTER_PORT="${OWLCODA_QA_ROUTER_PORT:-$(get_free_port)}"
PROXY_PORT="${OWLCODA_QA_PROXY_PORT:-$(get_free_port)}"

cat > "$CONFIG_PATH" <<JSON
{
  "host": "127.0.0.1",
  "port": $PROXY_PORT,
  "routerUrl": "http://127.0.0.1:$ROUTER_PORT",
  "models": [
    {
      "id": "$MODEL",
      "label": "$MODEL",
      "backendModel": "$MODEL",
      "aliases": ["mimo"],
      "tier": "production",
      "default": true
    }
  ]
}
JSON

node - "$ROUTER_PORT" "$ROUTER_LOG" "$MODEL" <<'NODE' &
const http = require('node:http')
const fs = require('node:fs')

const port = Number(process.argv[2])
const logPath = process.argv[3]
const model = process.argv[4]

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    json(res, 200, { status: 'ok' })
    return
  }
  if (req.url === '/v1/models') {
    json(res, 200, { data: [{ id: model }] })
    return
  }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      fs.appendFileSync(logPath, raw + '\n')
      let body = {}
      try { body = JSON.parse(raw) } catch {}
      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({
          id: 'empty-stream-1',
          object: 'chat.completion.chunk',
          model: body.model ?? model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        })}\n\n`)
        res.write(`data: ${JSON.stringify({
          id: 'empty-stream-1',
          object: 'chat.completion.chunk',
          model: body.model ?? model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12 },
        })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      json(res, 200, {
        id: 'empty-non-stream-1',
        object: 'chat.completion',
        model: body.model ?? model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12 },
      })
    })
    return
  }
  json(res, 404, { error: 'not_found' })
})

server.listen(port, '127.0.0.1')
NODE
ROUTER_PID=$!

note "Launching interactive OwlCoda in tmux"
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x "$COLS" -y "$ROWS" \
  "cd '$PROJECT_DIR' && env OWLCODA_HOME='$OWLCODA_HOME_DIR' OWLCODA_AUTO_APPROVE=1 node --import tsx src/cli.ts --config '$CONFIG_PATH' --model '$MODEL' 2>&1 | tee '$SESSION_LOG'"

note "Waiting for REPL readiness"
if ! wait_for_regex '● ready|ready[[:space:]]*│|▎ ›' 45; then
  capture_current || true
  echo "REPL did not become ready. See $LATEST and $SESSION_LOG" >&2
  exit 1
fi

note "Sending prompt that the fake router will answer with an empty response"
send_enter "Trigger the interactive runtime retry suppression smoke. Reply with any non-empty text."

if ! wait_for_regex 'HTTP 200 but no content|auto-continue is suppressed|No response from' 45; then
  capture_current || true
  echo "Did not observe empty-response suppression wording. See $LATEST and $SESSION_LOG" >&2
  exit 1
fi

note "Exiting REPL so the session is flushed"
send_enter "/exit"
wait_for_regex 'Goodbye!' 20 >/dev/null || true
sleep 1

node - "$OWLCODA_HOME_DIR" "$EVENT_JSON" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')

const home = process.argv[2]
const out = process.argv[3]
const sessionsDir = path.join(home, 'sessions')
const files = fs.existsSync(sessionsDir)
  ? fs.readdirSync(sessionsDir).filter(file => file.endsWith('.json'))
  : []

if (files.length === 0) {
  throw new Error(`No saved sessions found in ${sessionsDir}`)
}

const sessions = files
  .map(file => {
    const fullPath = path.join(sessionsDir, file)
    return { file, fullPath, data: JSON.parse(fs.readFileSync(fullPath, 'utf8')) }
  })
  .sort((a, b) => (b.data.updatedAt ?? 0) - (a.data.updatedAt ?? 0))

const match = sessions
  .flatMap(session => (session.data.runtimeEventLog?.events ?? []).map(event => ({ session, event })))
  .find(({ event }) =>
    event.kind === 'runtime_intervention'
    && event.payload?.intervention_kind === 'runtime_auto_retry_suppression'
    && event.payload?.auto_retry_surface === 'interactive_repl_auto_retry'
  )

if (!match) {
  throw new Error('No interactive runtime_auto_retry_suppression event found in saved sessions')
}

const payload = match.event.payload
if (payload.failure_kind !== 'empty_provider_response') {
  throw new Error(`Expected failure_kind empty_provider_response, got ${payload.failure_kind}`)
}
if (payload.suppression_reason !== 'failure_kind_suppressed') {
  throw new Error(`Expected suppression_reason failure_kind_suppressed, got ${payload.suppression_reason}`)
}

const result = {
  session_id: match.session.data.id,
  session_file: match.session.fullPath,
  event_id: match.event.id,
  seq: match.event.seq,
  payload,
}
fs.writeFileSync(out, JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
NODE

note "PASS interactive retry suppression event recorded"
note "Evidence: $EVENT_JSON"
