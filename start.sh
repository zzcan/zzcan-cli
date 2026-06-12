#!/usr/bin/env bash
# start.sh — 幂等启动 feishu-tmux-bridge：
#   tmux session "feishu-bridge"，window 0 = 常驻 claude，window 1 = daemon。
# 只新建独立 session，不碰用户已有的 tmux session；停止用 stop.sh（kill-session，绝不 kill-server）。
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${BRIDGE_STATE_DIR:-$HOME/.claude-feishu-tmux-bridge}"
SESSION="feishu-bridge"
OLD_BRIDGE_PID_FILE="$HOME/.claude-feishu-bridge/listener.pid"

mkdir -p "$STATE_DIR"

# 互斥：旧 feishu-bridge 的 listener 还在跑 → 两套会双重回复，拒绝启动
if [ -f "$OLD_BRIDGE_PID_FILE" ] && kill -0 "$(cat "$OLD_BRIDGE_PID_FILE")" 2>/dev/null; then
  echo "❌ 旧 feishu-bridge 的 listener 还在跑 (PID $(cat "$OLD_BRIDGE_PID_FILE"))。"
  echo "   先停掉：bash ~/.claude/skills/feishu-bridge/scripts/stop-listener.sh"
  exit 1
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "✅ 已在运行。状态：bash $SKILL_DIR/status.sh；附身观看：tmux attach -t $SESSION"
  exit 0
fi

# 初始化 config（allowed_senders 优先从旧桥 config 引导）
CONFIG="$STATE_DIR/config.json"
if [ ! -f "$CONFIG" ]; then
  OLD_CONFIG="$HOME/.claude-feishu-bridge/config.json"
  if [ -f "$OLD_CONFIG" ]; then
    SENDERS=$(jq -c '.allowed_senders // []' "$OLD_CONFIG")
  else
    SENDERS="[]"
  fi
  jq -n --argjson senders "$SENDERS" '{
    allowed_senders: $senders,
    workdir: "~/Desktop/workspace",
    turn_timeout_seconds: 300,
    max_reply_chars: 20000,
    receipt_emoji: "OnIt"
  }' > "$CONFIG"
  echo "ℹ️  已生成 $CONFIG（workdir 默认 ~/Desktop/workspace，可改后重启）"
fi

SENDER_COUNT=$(jq '.allowed_senders | length' "$CONFIG")
if [ "$SENDER_COUNT" -eq 0 ]; then
  echo "❌ $CONFIG 的 allowed_senders 为空。填入你的 open_id 后重跑。"
  exit 1
fi

WORKDIR=$(jq -r '.workdir' "$CONFIG")
WORKDIR="${WORKDIR/#\~/$HOME}"
if [ ! -d "$WORKDIR" ]; then
  echo "❌ workdir 不存在: $WORKDIR"
  exit 1
fi

# bridge-settings.json 每次启动重写，保证 hook 路径最新
cat > "$STATE_DIR/bridge-settings.json" << EOF
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "bash $SKILL_DIR/stop-hook.sh" }
        ]
      }
    ]
  }
}
EOF

BRIDGE_PROMPT='你正通过飞书桥与用户对话：你的每轮回复全文会被原样发送到用户手机上的飞书。请保持回复简洁、少用宽表格和长代码块。绝对不要使用 AskUserQuestion 工具（它会无限阻塞桥），需要用户决策时直接用文字提问。'

# 窗口一律按名字定位（兼容 base-index 非 0 的用户配置）
tmux new-session -d -s "$SESSION" -n claude -c "$WORKDIR" \
  claude --dangerously-skip-permissions \
         --settings "$STATE_DIR/bridge-settings.json" \
         --append-system-prompt "$BRIDGE_PROMPT"
# 让 claude 退出后 pane 保留，daemon 可 respawn-window 复活
tmux set-option -t "$SESSION:claude" remain-on-exit on

tmux new-window -t "$SESSION" -n daemon \
  "BRIDGE_STATE_DIR='$STATE_DIR' bun '$SKILL_DIR/daemon.mjs' 2>&1 | tee -a '$STATE_DIR/daemon.out'"
tmux set-option -t "$SESSION:daemon" remain-on-exit on

sleep 2
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "❌ 启动失败，session 没起来"
  exit 1
fi
echo "✅ 桥已启动：claude @ $WORKDIR + daemon"
echo "   观看/接管：tmux attach -t $SESSION   停止：bash $SKILL_DIR/stop.sh"
