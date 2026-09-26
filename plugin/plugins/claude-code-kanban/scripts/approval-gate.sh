#!/bin/bash
# Blocking approval gate: lets the cck board answer a permission ask or an
# AskUserQuestion. Always writes the _waiting.json marker first (badge behavior
# is unchanged when the feature is off), then — unless config.json opts out, and
# only while the board's server is alive — waits for a decision file written by the server.
#
# Contract (_plans/cck-ui-approvals/decisions.md), rooted at <CLAUDE_CONFIG_DIR or ~/.claude>/.cck:
#   marker    agent-activity/<sid>/_waiting.json            (D8: + id, cwd, permissionSuggestions)
#   decision  agent-activity/<sid>/_decision-<id>.json      (server writes it, Phase 3)
#   config    config.json {approvals: {enabled, mode, waitSeconds}}  (on by default; absent = defaults)
#   liveness  server.json {port, pid}                       (D1: a dead board costs nothing)
#
# First writer wins (D5): a terminal answer deletes the marker (this gate, via
# the session registry, or PostToolUse) and this gate exits silently; a decision arriving after the tool already ran
# is discarded by Claude Code, so a losing write on either side is harmless.

INPUT=$(cat)

eval "$(echo "$INPUT" | jq -r '
  @sh "SESSION_ID=\(.session_id // "")",
  @sh "EVENT=\(.hook_event_name // "")",
  @sh "TOOL_NAME=\(.tool_name // "")"
')"

[ -z "$SESSION_ID" ] && exit 0

# AskUserQuestion and ExitPlanMode gate on PermissionRequest, not PreToolUse:
# the TUI question and plan dialogs render ~10 s in while a PermissionRequest
# hook blocks (first writer wins, like permissions), but stay frozen for the
# whole wait during a PreToolUse hook — measured live (#42, #40). Suppress the
# PreToolUse double-fire in case a stale hooks.json still registers it.
if [ "$EVENT" = "PreToolUse" ]; then
  exit 0
fi

KIND="permission"
[ "$TOOL_NAME" = "AskUserQuestion" ] && KIND="question"
[ "$TOOL_NAME" = "ExitPlanMode" ] && KIND="plan"

CCK_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.cck"
DIR="$CCK_DIR/agent-activity/$SESSION_ID"
MARKER="$DIR/_waiting.json"
mkdir -p "$DIR"

# uuidgen is missing on some Git Bash installs; uniqueness only has to hold
# across the asks of one session, so a timestamp compound is enough
REQ_ID=$(uuidgen 2>/dev/null) || REQ_ID="$(date +%s%N)-$$-$RANDOM"

TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "$INPUT" | jq -c --arg kind "$KIND" --arg ts "$TS" --arg id "$REQ_ID" '{
  status: "waiting",
  kind: $kind,
  id: $id,
  toolName: (.tool_name // "unknown"),
  toolInput: ((.tool_input | tostring) // ""),
  cwd: (.cwd // ""),
  permissionSuggestions: (.permission_suggestions // []),
  timestamp: $ts
}' > "$MARKER"

# Every exit below leaves the marker in place for the badge; agent-spy.sh's
# PostToolUse (or the server's TTL) retires it, exactly as before this feature.

# Defaults mirror lib/approvals.js — keep in sync. A missing or unparseable
# config.json means defaults, i.e. the gate is on.
ENABLED="true"
MODE="permission+question"
WAIT_SECONDS=""
CONFIG="$CCK_DIR/config.json"
if [ -f "$CONFIG" ]; then
  eval "$(jq -r '
    @sh "ENABLED=\(if .approvals.enabled == false then "false" else "true" end)",
    @sh "MODE=\(.approvals.mode // "permission+question")",
    @sh "WAIT_SECONDS=\(.approvals.waitSeconds // "")"
  ' < "$CONFIG" 2>/dev/null)"
fi
[ "$ENABLED" = "false" ] && exit 0

if [ "$KIND" = "question" ] && [ "$MODE" != "permission+question" ]; then
  exit 0
fi

case "$WAIT_SECONDS" in *[!0-9]* | "") WAIT_SECONDS=1800 ;; esac
# PERMISSION_TTL_MS hides the card at 30 min — waiting longer than the UI can
# show the ask is strictly worse than giving up (D11)
[ "$WAIT_SECONDS" -gt 1800 ] && WAIT_SECONDS=1800

SERVER_INFO="$CCK_DIR/server.json"

# A TCP connect beats a pid probe: it proves the board is actually serving, and
# it works in the stripped environment Claude Code spawns hooks into, where
# kill -0 cannot see native Windows pids and ps may be missing from PATH. The
# port is re-read on every probe, not cached: under the hub every sub-app binds
# an ephemeral port, so a board that restarts mid-wait comes back on a new one.
# $(<file) and =~ keep the probe free of jq and cat spawns (~280 ms each here).
board_alive() {
  local raw port
  raw=$(<"$SERVER_INFO") 2>/dev/null || return 1
  [[ $raw =~ \"port\"[[:space:]]*:[[:space:]]*([0-9]+) ]] || return 1
  port=${BASH_REMATCH[1]}
  (: < "/dev/tcp/127.0.0.1/$port") 2>/dev/null
}

DECISION="$DIR/_decision-$REQ_ID.json"
# EPOCHSECONDS (bash 5) keeps the poll loop free of `date` spawns
DEADLINE=$((EPOCHSECONDS + WAIT_SECONDS))
# Probing once up front made one unreachable moment disarm the whole ask, so a
# board restarting on a new port (every hub-spawned sub-app binds an ephemeral
# one) took the ask with it. Probe on a cadence instead and only give up once
# the board has been gone for the whole grace. The terminal prompt stays live
# throughout either way.
BOARD_PROBE_SECONDS=5
BOARD_GRACE_SECONDS=15
NEXT_PROBE=0
UNREACHABLE_SINCE=0

# Claude Code's live-session registry flips from "waiting" the moment the
# terminal prompt is answered, while PostToolUse waits for the tool to finish
# and never fires on a deny. Undocumented, so a missing file or field leaves
# PostToolUse in charge, as before.
SESSIONS_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions"
REGISTRY=""
SEEN_WAITING=0
find_registry() {
  local f raw
  for f in "$SESSIONS_DIR"/*.json; do
    [ -f "$f" ] || continue
    raw=""
    IFS= read -r raw 2>/dev/null < "$f"
    case "$raw" in *"\"sessionId\":\"$SESSION_ID\""*) REGISTRY=$f; return 0 ;; esac
  done
  return 1
}

while :; do
  if [ -f "$DECISION" ]; then
    PAYLOAD=$(cat "$DECISION" 2>/dev/null)
    rm -f "$DECISION" "$MARKER"
    [ -n "$PAYLOAD" ] || exit 0
    if [ "$KIND" = "plan" ] && [ "$(echo "$PAYLOAD" | jq -r '.behavior // "deny"' 2>/dev/null)" = "allow" ]; then
      # A plan allow must echo tool_input as updatedInput — Claude Code
      # >= 2.1.199 silently drops an ExitPlanMode allow without it and falls
      # back to the built-in dialog (measured; plannotator does the same).
      echo "$INPUT" | jq -c --argjson p "$PAYLOAD" \
        '{hookSpecificOutput: {hookEventName: "PermissionRequest",
          decision: ({behavior: "allow", updatedInput: (.tool_input // {})}
          + (if $p.updatedPermissions then {updatedPermissions: $p.updatedPermissions} else {} end))}}' 2>/dev/null
    elif [ "$KIND" != "question" ]; then
      # Permission asks and plan denies share this shaping — the server sends
      # only behavior+message for a plan deny. PermissionRequest decisions must
      # ride hookSpecificOutput — a top-level {decision} is the approve/block
      # string channel and an object there throws
      echo "$PAYLOAD" | jq -c '{hookSpecificOutput: {hookEventName: "PermissionRequest",
        decision: ({behavior: (.behavior // "deny")}
        + (if .message then {message: .message} else {} end)
        + (if .updatedInput then {updatedInput: .updatedInput} else {} end)
        + (if .updatedPermissions then {updatedPermissions: .updatedPermissions} else {} end))}}' 2>/dev/null
    else
      # updatedInput replaces the whole input object, so echo every field and
      # add the answers Claude never fills in itself (D6). Questions ride the
      # PermissionRequest channel now (#42) — allow with the answers filled in.
      ANSWERS=$(echo "$PAYLOAD" | jq -c '.answers // empty' 2>/dev/null)
      [ -n "$ANSWERS" ] || exit 0
      echo "$INPUT" | jq -c --argjson answers "$ANSWERS" \
        '{hookSpecificOutput: {hookEventName: "PermissionRequest",
          decision: {behavior: "allow", updatedInput: ((.tool_input // {}) + {answers: $answers})}}}' 2>/dev/null
    fi
    exit 0
  fi

  # Marker gone = answered in the terminal (PostToolUse fires ~23 ms after — D5);
  # id changed = displaced by a newer ask (D8). Either way this gate is over.
  # Builtin read + substring match instead of jq: a spawn costs ~280 ms on
  # Windows (O2), and the marker is single-line jq -c output with a known id.
  IFS= read -r CUR_MARKER < "$MARKER" 2>/dev/null || exit 0
  case "$CUR_MARKER" in *"\"id\":\"$REQ_ID\""*) ;; *) exit 0 ;; esac

  if [ -n "$REGISTRY" ]; then
    REG_RAW=""
    IFS= read -r REG_RAW 2>/dev/null < "$REGISTRY"
    if [[ $REG_RAW =~ \"status\":\"([a-z]+)\" ]]; then
      if [ "${BASH_REMATCH[1]}" = "waiting" ]; then
        SEEN_WAITING=1
      elif [ "$SEEN_WAITING" -eq 1 ]; then
        rm -f "$MARKER"
        exit 0
      fi
    fi
  fi

  if [ "$EPOCHSECONDS" -ge "$NEXT_PROBE" ]; then
    NEXT_PROBE=$((EPOCHSECONDS + BOARD_PROBE_SECONDS))
    [ -n "$REGISTRY" ] || find_registry
    # No beacon at all = no board on this config dir, now or a moment ago: give
    # up at once, exactly as before. A beacon whose port is closed is the
    # restart window instead, so that one gets the grace.
    [ -f "$SERVER_INFO" ] || exit 0
    if board_alive; then
      UNREACHABLE_SINCE=0
    else
      [ "$UNREACHABLE_SINCE" -eq 0 ] && UNREACHABLE_SINCE=$EPOCHSECONDS
      [ $((EPOCHSECONDS - UNREACHABLE_SINCE)) -ge "$BOARD_GRACE_SECONDS" ] && exit 0
    fi
  fi

  [ "$EPOCHSECONDS" -ge "$DEADLINE" ] && exit 0
  sleep 0.5
done
