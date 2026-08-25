#!/bin/bash
# Shared harness for tests/test-*.sh — source after setting $HOOK. One copy so
# a harness fix (like the $((PASS+1)) set -e workaround) lands once, not per suite.

PASS=0
FAIL=0

# $((...)) assignment, not ((PASS++)): the latter returns 1 when the old value
# is 0, which aborts under set -e and falls through && chains into fail()
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1: $2"; }

assert_file() {
  [ -f "$1" ] && pass "$2" || fail "$2" "file not found: $1"
}

assert_no_file() {
  [ ! -f "$1" ] && pass "$2" || fail "$2" "file should not exist: $1"
}

# Fold JSONL last-key-wins, mirroring the server's readAgentJsonl.
# Also valid for single-object .json files (jq -s slurps either).
fold_json() {
  jq -s 'reduce .[] as $e ({}; . + $e)' "$1" 2>/dev/null || true
}

assert_json() {
  local file="$1" key="$2" expected="$3" label="$4"
  local actual
  actual=$(fold_json "$file" | jq -r "$key" 2>/dev/null || true)
  if [ "$actual" = "$expected" ]; then
    pass "$label"
  else
    fail "$label" "expected '$expected', got '$actual'"
  fi
}

assert_eq() {
  [ "$1" = "$2" ] && pass "$3" || fail "$3" "expected '$2', got '$1'"
}

run_hook() {
  echo "$1" | bash "$HOOK"
}
