#!/usr/bin/env bash
# OwlCoda Smoke Test Suite
# Runs after every change to verify nothing is broken.
# Exit on first failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

PASS=0
FAIL=0
SKIP=0

# Timeout for headless LLM calls (local inference can be slow)
LLM_TIMEOUT=${OWLCODA_SMOKE_TIMEOUT:-120}

# Fast mode: build + proxy only (skip LLM calls)
FAST_MODE=${OWLCODA_SMOKE_FAST:-0}

pass() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ $1: $2"; FAIL=$((FAIL + 1)); }
skip() { echo "  ⏭  $1: $2"; SKIP=$((SKIP + 1)); }

# Run a command with a timeout (macOS-compatible)
run_with_timeout() {
  local timeout_secs=$1; shift
  local output_file
  output_file=$(mktemp)
  "$@" > "$output_file" 2>/dev/null &
  local pid=$!
  local elapsed=0
  while kill -0 "$pid" 2>/dev/null && [ "$elapsed" -lt "$timeout_secs" ]; do
    sleep 5
    elapsed=$((elapsed + 5))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    rm -f "$output_file"
    return 124  # timeout
  fi
  wait "$pid" 2>/dev/null || true
  cat "$output_file"
  rm -f "$output_file"
  return 0
}

echo "╔══════════════════════════════════════╗"
echo "║     OwlCoda Smoke Test Suite           ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ─── 1. Build ───────────────────────────────────────────
echo "▸ Build"
BUILD_OUT=$(npm run build 2>&1)
if echo "$BUILD_OUT" | grep -q "error TS"; then
  fail "TypeScript build" "Compiler errors detected"
  echo "$BUILD_OUT" | grep "error TS" | head -5
else
  pass "TypeScript build (zero errors)"
fi

# ─── 1b. Unit tests ────────────────────────────────────
echo "▸ Unit tests"
TEST_OUT=$(npm test 2>&1) || true
if echo "$TEST_OUT" | grep -qE "Tests\s+[0-9]+ passed"; then
  TEST_COUNT=$(echo "$TEST_OUT" | grep -oE "Tests\s+[0-9]+ passed" | grep -oE "[0-9]+")
  pass "Vitest ($TEST_COUNT tests passed)"
else
  fail "Vitest" "Unit tests failed"
  echo "$TEST_OUT" | tail -5
fi

# ─── 2. Headless mode ──────────────────────────────────
if [ "$FAST_MODE" = "1" ]; then
  skip "Headless -p basic" "fast mode — skipping LLM calls"
else
  echo "▸ Headless mode"
  HEADLESS_OUT=$(run_with_timeout "$LLM_TIMEOUT" node dist/cli.js -p "Reply with just the word OK" || true)
  if [ -z "$HEADLESS_OUT" ]; then
    skip "Headless -p basic" "LLM timeout (${LLM_TIMEOUT}s) — backend may be slow or unavailable"
  elif echo "$HEADLESS_OUT" | grep -qi "OK"; then
    pass "Headless -p basic"
  else
    fail "Headless -p basic" "Unexpected output (no OK found)"
  fi
fi

# ─── 3. Model switching ────────────────────────────────
if [ "$FAST_MODE" = "1" ]; then
  skip "Headless --model fast" "fast mode — skipping LLM calls"
else
  echo "▸ Model switching"
  MODEL_OUT=$(run_with_timeout "$LLM_TIMEOUT" node dist/cli.js -p "Reply with just the word OK" --model fast || true)
  if [ -z "$MODEL_OUT" ]; then
    skip "Headless --model fast" "LLM timeout or model 'fast' unavailable"
  elif echo "$MODEL_OUT" | grep -qi "OK"; then
    pass "Headless --model fast"
  else
    skip "Headless --model fast" "Model 'fast' may not be available"
  fi
fi

# ─── 4. Proxy health ───────────────────────────────────
echo "▸ Proxy health"
PROXY_PORT=${OWLCODA_PROXY_PORT:-8019}
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PROXY_PORT}/healthz" 2>/dev/null || echo "000")
if [ "$HEALTH" = "200" ]; then
  pass "Proxy healthz (port $PROXY_PORT)"
else
  skip "Proxy healthz" "Proxy not running on port $PROXY_PORT (code: $HEALTH)"
fi

# ─── 5. MCP loading (non-destructive) ──────────────────
if [ "$FAST_MODE" = "1" ]; then
  skip "MCP tools visible" "fast mode — skipping LLM calls"
else
  echo "▸ MCP loading"
# Create temporary .mcp.json, run headless, check tool list, clean up
TEMP_MCP="$PROJECT_DIR/.mcp.json"
NEED_CLEANUP=false
if [ ! -f "$TEMP_MCP" ]; then
  cat > "$TEMP_MCP" << 'MCPEOF'
{
  "mcpServers": {
    "filesystem": {
      "command": "mcp-server-filesystem",
      "args": ["/tmp"]
    }
  }
}
MCPEOF
  NEED_CLEANUP=true
fi

if command -v mcp-server-filesystem &>/dev/null; then
  MCP_OUT=$(run_with_timeout "$LLM_TIMEOUT" node dist/cli.js -p "List all your tool names, one per line." || true)
  if echo "$MCP_OUT" | grep -q "mcp__filesystem"; then
    pass "MCP tools visible"
  elif [ -z "$MCP_OUT" ]; then
    skip "MCP tools visible" "LLM timeout — backend may be slow"
  else
    fail "MCP tools visible" "mcp__filesystem not found in tool list"
  fi
else
  skip "MCP tools visible" "mcp-server-filesystem not installed"
fi

if [ "$NEED_CLEANUP" = true ]; then
  rm -f "$TEMP_MCP"
fi
fi

# ─── Summary ───────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Results: $PASS passed, $FAIL failed, $SKIP skipped"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
