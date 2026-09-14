#!/bin/bash
# Tests for plugin/scripts/approval-gate.sh
# Run: bash tests/test-approval-gate.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$SCRIPT_DIR/plugin/plugins/claude-code-kanban/scripts/approval-gate.sh"
TMPDIR=$(mktemp -d)
export HOME="$TMPDIR"
# The gate is on by default, so a leaked CLAUDE_CONFIG_DIR would make it wait
# on the real board instead of the fixture dir
unset CLAUDE_CONFIG_DIR
CCK_DIR="$TMPDIR/.claude/.cck"
ACTIVITY_DIR="$CCK_DIR/agent-activity"

source "$SCRIPT_DIR/tests/helpers.sh"

# Runs the hook while a background helper waits for the marker and answers it
# with the given decision payload — simulates the server's respond route.
run_hook_with_decision() {
  local input="$1" marker="$2" decision_payload="$3"
  (
    for _ in $(seq 1 40); do
      if [ -f "$marker" ]; then
        id=$(jq -r '.id' "$marker" 2>/dev/null)
        if [ -n "$id" ] && [ "$id" != "null" ]; then
          echo "$decision_payload" > "$(dirname "$marker")/_decision-$id.json"
          exit 0
        fi
      fi
      sleep 0.25
    done
  ) &
  local helper=$!
  echo "$input" | bash "$HOOK"
  wait "$helper" 2>/dev/null || true
}

write_config() {
  echo "{\"approvals\":$1}" > "$CCK_DIR/config.json"
}

# Liveness is a TCP connect to server.json's port — hold a real listener open
# for the whole suite so "board up" scenarios pass the probe
LIVE_PORT=3979
node -e "require('net').createServer(() => {}).listen($LIVE_PORT, '127.0.0.1')" &
LISTENER=$!
live_server() {
  echo "{\"port\":$LIVE_PORT,\"pid\":$LISTENER}" > "$CCK_DIR/server.json"
}

cleanup() {
  kill "$LISTENER" 2>/dev/null
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

mkdir -p "$CCK_DIR"

PERM_INPUT='{"session_id":"SID","agent_id":"","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"npm install"},"cwd":"C:/Users/user/dev/app","permission_suggestions":[{"type":"rule","behavior":"allow"}]}'
Q_INPUT='{"session_id":"SID","agent_id":"","hook_event_name":"PermissionRequest","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Which?","options":[{"label":"A"},{"label":"B"}]}]},"cwd":"C:/Users/user/dev/app"}'
PLAN_INPUT='{"session_id":"SID","agent_id":"","hook_event_name":"PermissionRequest","tool_name":"ExitPlanMode","tool_input":{"plan":"# The Plan\n\ndo things"},"cwd":"C:/Users/user/dev/app"}'

marker() { echo "$ACTIVITY_DIR/$1/_waiting.json"; }
reset_session() { rm -rf "$ACTIVITY_DIR/$1"; }

# ─── Default on: no config, no board ─────────────────────────────
echo "Default on (no config, no server.json):"

OUT=$(run_hook "${PERM_INPUT/SID/s-noconf}")
assert_eq "$OUT" "" "no output without a board"
assert_file "$(marker s-noconf)" "marker still written"
assert_json "$(marker s-noconf)" ".kind" "permission" "kind=permission"
assert_json "$(marker s-noconf)" ".toolName" "Bash" "toolName recorded"
assert_json "$(marker s-noconf)" ".cwd" "C:/Users/user/dev/app" "cwd recorded (D8)"
assert_json "$(marker s-noconf)" ".permissionSuggestions[0].behavior" "allow" "permissionSuggestions recorded (D8)"
ID=$(jq -r '.id' "$(marker s-noconf)")
[ -n "$ID" ] && [ "$ID" != "null" ] && pass "marker has an id (D8)" || fail "marker id" "got '$ID'"

# ─── Corrupt config = defaults, still fail-open without a board ──
echo "Corrupt config:"

write_config 'not json {'
OUT=$(run_hook "${PERM_INPUT/SID/s-corrupt}")
assert_eq "$OUT" "" "no output on corrupt config without a board"

# ─── Liveness gate ───────────────────────────────────────────────
echo "Liveness gate (D1):"

write_config '{"enabled":true,"waitSeconds":5}'
rm -f "$CCK_DIR/server.json"
START=$(date +%s)
OUT=$(run_hook "${PERM_INPUT/SID/s-nosrv}")
ELAPSED=$(( $(date +%s) - START ))
assert_eq "$OUT" "" "no output without server.json"
[ "$ELAPSED" -le 2 ] && pass "instant exit without server.json" || fail "instant exit" "took ${ELAPSED}s"

# A port nothing listens on = the board is restarting (the server deletes its own
# beacon on the way out), so the gate holds for the grace and gives up at the
# deadline — waitSeconds=5 here, well inside BOARD_GRACE_SECONDS.
echo '{"port":39799,"pid":999999}' > "$CCK_DIR/server.json"
START=$(date +%s)
OUT=$(run_hook "${PERM_INPUT/SID/s-deadsrv}")
ELAPSED=$(( $(date +%s) - START ))
assert_eq "$OUT" "" "no output with dead server port"
[ "$ELAPSED" -ge 4 ] && [ "$ELAPSED" -le 8 ] && pass "waits out the grace on a dead port" || fail "dead-port grace" "took ${ELAPSED}s"

# ─── Approve from the board ──────────────────────────────────────
echo "Permission allow:"

write_config '{"enabled":true,"waitSeconds":10}'
live_server
OUT=$(run_hook_with_decision "${PERM_INPUT/SID/s-allow}" "$(marker s-allow)" '{"kind":"permission","behavior":"allow"}')
assert_eq "$(echo "$OUT" | jq -r '.hookSpecificOutput.decision.behavior')" "allow" "emits decision.behavior=allow"
assert_no_file "$(marker s-allow)" "marker cleaned up after decision"
[ -z "$(ls "$ACTIVITY_DIR/s-allow" 2>/dev/null | grep _decision)" ] && pass "decision file consumed" || fail "decision consumed" "file remains"

# ─── Allow with updatedPermissions ───────────────────────────────
echo "Permission allow + updatedPermissions:"

OUT=$(run_hook_with_decision "${PERM_INPUT/SID/s-allowp}" "$(marker s-allowp)" '{"behavior":"allow","updatedPermissions":[{"type":"addRules","rules":[{"toolName":"Bash"}],"behavior":"allow","destination":"session"}]}')
assert_eq "$(echo "$OUT" | jq -r '.hookSpecificOutput.decision.updatedPermissions[0].type')" "addRules" "updatedPermissions passed through"

# ─── Deny from the board ─────────────────────────────────────────
echo "Permission deny:"

OUT=$(run_hook_with_decision "${PERM_INPUT/SID/s-deny}" "$(marker s-deny)" '{"behavior":"deny","message":"not on my watch"}')
assert_eq "$(echo "$OUT" | jq -r '.hookSpecificOutput.decision.behavior')" "deny" "emits decision.behavior=deny"
assert_eq "$(echo "$OUT" | jq -r '.hookSpecificOutput.decision.message')" "not on my watch" "deny message passed through"

# ─── Question answered from the board ────────────────────────────
echo "AskUserQuestion (D6):"

write_config '{"enabled":true,"mode":"permission+question","waitSeconds":10}'
OUT=$(run_hook_with_decision "${Q_INPUT/SID/s-q}" "$(marker s-q)" '{"kind":"question","answers":{"0":"A"}}')
assert_eq "$(echo "$OUT" | jq -r '.hookSpecificOutput.decision.behavior')" "allow" "decision.behavior=allow"
assert_eq "$(echo "$OUT" | jq -r '.hookSpecificOutput.decision.updatedInput.answers["0"]')" "A" "answers injected"
assert_eq "$(echo "$OUT" | jq -r '.hookSpecificOutput.decision.updatedInput.questions[0].question')" "Which?" "full input echoed back"

# ─── Question marker kind ────────────────────────────────────────
echo "Question marker:"

reset_session s-q2
write_config '{"enabled":false}'
run_hook "${Q_INPUT/SID/s-q2}" > /dev/null
assert_json "$(marker s-q2)" ".kind" "question" "kind=question for AskUserQuestion on PermissionRequest"

# ─── mode=permission does not gate questions ─────────────────────
echo "Mode gating:"

write_config '{"enabled":true,"mode":"permission","waitSeconds":5}'
live_server
START=$(date +%s)
OUT=$(run_hook "${Q_INPUT/SID/s-qskip}")
ELAPSED=$(( $(date +%s) - START ))
assert_eq "$OUT" "" "question not gated in mode=permission"
[ "$ELAPSED" -le 2 ] && pass "no wait for ungated question" || fail "no wait" "took ${ELAPSED}s"
assert_file "$(marker s-qskip)" "marker still written for badge"

# ─── Default on: no config.json gates permissions and questions ──
echo "Default on (no config.json, live board):"

rm -f "$CCK_DIR/config.json"
live_server
OUT=$(run_hook_with_decision "${PERM_INPUT/SID/s-defperm}" "$(marker s-defperm)" '{"behavior":"allow"}')
assert_eq "$(echo "$OUT" | jq -r '.hookSpecificOutput.decision.behavior')" "allow" "permission gated without config"
OUT=$(run_hook_with_decision "${Q_INPUT/SID/s-defq}" "$(marker s-defq)" '{"answers":{"0":"A"}}')
assert_eq "$(echo "$OUT" | jq -r '.hookSpecificOutput.decision.updatedInput.answers["0"]')" "A" "question gated without config (default mode=permission+question)"

# `{}` and a config without an approvals section are the defaults too
echo '{}' > "$CCK_DIR/config.json"
OUT=$(run_hook_with_decision "${PERM_INPUT/SID/s-defempty}" "$(marker s-defempty)" '{"behavior":"deny"}')
assert_eq "$(echo "$OUT" | jq -r '.hookSpecificOutput.decision.behavior')" "deny" "empty config.json = defaults"

# ─── Opt-out with a live board exits at once ─────────────────────
echo "Opt-out (enabled=false, live board):"

write_config '{"enabled":false}'
START=$(date +%s)
OUT=$(run_hook "${PERM_INPUT/SID/s-offlive}")
ELAPSED=$(( $(date +%s) - START ))
assert_eq "$OUT" "" "no output when opted out"
[ "$ELAPSED" -le 2 ] && pass "instant exit when opted out" || fail "instant exit opted out" "took ${ELAPSED}s"
assert_file "$(marker s-offlive)" "marker still written for badge"

# ─── Double-fire suppression (D9) ────────────────────────────────
echo "Double-fire suppression:"

reset_session s-dbl
run_hook '{"session_id":"s-dbl","hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{}}' > /dev/null
assert_no_file "$(marker s-dbl)" "PreToolUse(AskUserQuestion) suppressed"
run_hook '{"session_id":"s-dbl","hook_event_name":"PreToolUse","tool_name":"ExitPlanMode","tool_input":{}}' > /dev/null
assert_no_file "$(marker s-dbl)" "PreToolUse(ExitPlanMode) suppressed"

# ─── ExitPlanMode: plan approval on PermissionRequest (#40) ──────
echo "ExitPlanMode plan approval:"

write_config '{"enabled":true,"mode":"permission","waitSeconds":10}'
live_server
OUT=$(run_hook_with_decision "${PLAN_INPUT/SID/s-plan}" "$(marker s-plan)" '{"behavior":"allow"}')
assert_eq "$(echo "$OUT" | jq -r '.hookSpecificOutput.decision.behavior')" "allow" "plan allow emitted"
assert_eq "$(echo "$OUT" | jq -c '.hookSpecificOutput.decision.updatedInput.plan')" '"# The Plan\n\ndo things"' "tool_input echoed as updatedInput (required for ExitPlanMode allow)"

OUT=$(run_hook_with_decision "${PLAN_INPUT/SID/s-planp}" "$(marker s-planp)" '{"behavior":"allow","updatedPermissions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}')
assert_eq "$(echo "$OUT" | jq -r '.hookSpecificOutput.decision.updatedPermissions[0].mode')" "acceptEdits" "plan allow passes updatedPermissions through"

OUT=$(run_hook_with_decision "${PLAN_INPUT/SID/s-pland}" "$(marker s-pland)" '{"behavior":"deny","message":"tighten phase 2"}')
assert_eq "$(echo "$OUT" | jq -r '.hookSpecificOutput.decision.behavior')" "deny" "plan deny emitted"
assert_eq "$(echo "$OUT" | jq -r '.hookSpecificOutput.decision.message')" "tighten phase 2" "plan deny feedback passed through"
assert_eq "$(echo "$OUT" | jq -r '.hookSpecificOutput.decision.updatedInput // "absent"')" "absent" "plan deny carries no updatedInput"

reset_session s-plank
write_config '{"enabled":false}'
run_hook "${PLAN_INPUT/SID/s-plank}" > /dev/null
assert_json "$(marker s-plank)" ".kind" "plan" "ExitPlanMode marker kind=plan"

# ─── Terminal answered first: marker delete aborts wait (D5) ─────
echo "Marker delete aborts (D5):"

write_config '{"enabled":true,"waitSeconds":10}'
reset_session s-term
(
  M="$(marker s-term)"
  for _ in $(seq 1 40); do
    [ -f "$M" ] && { sleep 0.3; rm -f "$M"; exit 0; }
    sleep 0.25
  done
) &
HELPER=$!
START=$(date +%s)
OUT=$(run_hook "${PERM_INPUT/SID/s-term}")
ELAPSED=$(( $(date +%s) - START ))
wait "$HELPER" 2>/dev/null || true
assert_eq "$OUT" "" "no output when marker deleted"
[ "$ELAPSED" -le 5 ] && pass "exits promptly on marker delete" || fail "marker delete exit" "took ${ELAPSED}s"

# ─── Displacement: id change aborts wait (D8) ────────────────────
echo "Displacement aborts (D8):"

reset_session s-disp
(
  M="$(marker s-disp)"
  for _ in $(seq 1 40); do
    if [ -f "$M" ]; then
      sleep 0.3
      jq -c '.id = "someone-else"' "$M" > "$M.tmp" && mv "$M.tmp" "$M"
      exit 0
    fi
    sleep 0.25
  done
) &
HELPER=$!
START=$(date +%s)
OUT=$(run_hook "${PERM_INPUT/SID/s-disp}")
ELAPSED=$(( $(date +%s) - START ))
wait "$HELPER" 2>/dev/null || true
assert_eq "$OUT" "" "no output when displaced"
[ "$ELAPSED" -le 5 ] && pass "exits promptly on id change" || fail "displacement exit" "took ${ELAPSED}s"

# ─── waitSeconds lapse ───────────────────────────────────────────
echo "waitSeconds lapse (D4):"

write_config '{"enabled":true,"waitSeconds":2}'
reset_session s-lapse
START=$(date +%s)
OUT=$(run_hook "${PERM_INPUT/SID/s-lapse}")
ELAPSED=$(( $(date +%s) - START ))
assert_eq "$OUT" "" "no output on lapse"
# Windows process spawns (~280 ms each) make one loop iteration ~2 s, so the
# deadline overshoots by up to one iteration — bound is waitSeconds + slack
[ "$ELAPSED" -ge 2 ] && [ "$ELAPSED" -le 9 ] && pass "waited ~waitSeconds then gave up" || fail "lapse timing" "took ${ELAPSED}s"
assert_file "$(marker s-lapse)" "marker left for badge after lapse"

# ─── Corrupt decision file: fail-open, no output ─────────────────
echo "Corrupt decision:"

write_config '{"enabled":true,"waitSeconds":10}'
OUT=$(run_hook_with_decision "${PERM_INPUT/SID/s-bad}" "$(marker s-bad)" 'not json {')
assert_eq "$OUT" "" "no output on corrupt decision payload"
assert_no_file "$(marker s-bad)" "marker cleaned up anyway"

# ─── Empty session_id ────────────────────────────────────────────
echo "Edge cases:"

OUT=$(run_hook '{"session_id":"","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{}}')
assert_eq "$OUT" "" "empty session_id exits silently"

# ─── Summary ─────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
