#!/usr/bin/env bash
# stop.sh — 只杀自己的 session（claude-bridge），绝不 kill-server，不碰用户其他 tmux session。
set -euo pipefail
SESSION="claude-bridge"
if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux kill-session -t "$SESSION"
  echo "✅ 已停止（session $SESSION 已销毁，daemon 与 claude 一并退出）"
else
  echo "ℹ️  没有在运行"
fi
