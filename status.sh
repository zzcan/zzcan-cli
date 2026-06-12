#!/usr/bin/env bash
# status.sh — 查看 Cli 运行状态
set -euo pipefail
STATE_DIR="${BRIDGE_STATE_DIR:-$HOME/.zzcan-cli}"
SESSION="zzcan-cli"

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "❌ 未运行（无 tmux session ${SESSION}）"
  exit 1
fi

claude_dead=$(tmux display -p -t "$SESSION:claude" '#{pane_dead}' 2>/dev/null || echo "?")
daemon_dead=$(tmux display -p -t "$SESSION:daemon" '#{pane_dead}' 2>/dev/null || echo "?")
echo "tmux session : ✅ $SESSION"
echo "claude pane  : $([ "$claude_dead" = "0" ] && echo ✅ 存活 || echo "❌ dead=$claude_dead")"
echo "daemon pane  : $([ "$daemon_dead" = "0" ] && echo ✅ 存活 || echo "❌ dead=$daemon_dead")"
echo "config       : $STATE_DIR/config.json"
echo "log 末 5 行  :"
tail -5 "$STATE_DIR/bridge.log" 2>/dev/null | sed 's/^/  /' || echo "  (无日志)"
