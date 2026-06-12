#!/usr/bin/env bash
# start.sh — 幂等启动 claude-tmux-bridge：
#   tmux session "claude-bridge"，window claude = 常驻 claude，window daemon = daemon。
# 只新建独立 session，不碰用户已有的 tmux session；停止用 stop.sh（kill-session，绝不 kill-server）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${BRIDGE_STATE_DIR:-$HOME/.claude-tmux-bridge}"
SESSION="claude-bridge"

mkdir -p "$STATE_DIR"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "✅ 已在运行。状态：bash $ROOT/status.sh；附身观看：tmux attach -t $SESSION"
  exit 0
fi

# 初始化 config：优先从上一代状态目录迁移（daemon 会再把旧结构升级为多通道结构）
CONFIG="$STATE_DIR/config.json"
if [ ! -f "$CONFIG" ]; then
  PREV_CONFIG="$HOME/.claude-feishu-tmux-bridge/config.json"
  if [ -f "$PREV_CONFIG" ]; then
    cp "$PREV_CONFIG" "$CONFIG"
    echo "ℹ️  已从 $PREV_CONFIG 迁移配置"
  else
    jq -n '{
      workdir: "~/Desktop/workspace",
      workspaces: {},
      turn_timeout_seconds: 300,
      max_reply_chars: 20000,
      channels: {
        feishu:   { enabled: true, allowed_senders: [], receipt_emoji: "OnIt" },
        telegram: { enabled: false, bot_token: "", allowed_user_ids: [], proxy: "" }
      }
    }' > "$CONFIG"
    echo "ℹ️  已生成 ${CONFIG}（填入通道白名单后重跑）"
  fi
fi

# 至少要有一个可用通道
FEISHU_OK=$(jq '(.channels.feishu.enabled // false) and ((.channels.feishu.allowed_senders // .allowed_senders // []) | length > 0)' "$CONFIG" 2>/dev/null || echo false)
LEGACY_OK=$(jq '(.channels == null) and ((.allowed_senders // []) | length > 0)' "$CONFIG" 2>/dev/null || echo false)
TG_OK=$(jq '(.channels.telegram.enabled // false) and (.channels.telegram.bot_token != "") and ((.channels.telegram.allowed_user_ids // []) | length > 0)' "$CONFIG" 2>/dev/null || echo false)
if [ "$FEISHU_OK" != "true" ] && [ "$TG_OK" != "true" ] && [ "$LEGACY_OK" != "true" ]; then
  echo "❌ $CONFIG 没有任何可用通道（feishu 需 allowed_senders，telegram 需 bot_token + allowed_user_ids）"
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
          { "type": "command", "command": "bash $ROOT/stop-hook.sh" }
        ]
      }
    ]
  }
}
EOF

BRIDGE_PROMPT='你正通过聊天桥（飞书/Telegram）与用户对话：你的每轮回复全文会被原样发送到用户手机上。请保持回复简洁、少用宽表格和长代码块。绝对不要使用 AskUserQuestion 工具（它会无限阻塞桥），需要用户决策时直接用文字提问。'

# 窗口一律按名字定位（兼容 base-index 非 0 的用户配置）
tmux new-session -d -s "$SESSION" -n claude -c "$WORKDIR" \
  claude --dangerously-skip-permissions \
         --settings "$STATE_DIR/bridge-settings.json" \
         --append-system-prompt "$BRIDGE_PROMPT"
# 让 claude 退出后 pane 保留，daemon 可 respawn-window 复活
tmux set-option -t "$SESSION:claude" remain-on-exit on

tmux new-window -t "$SESSION" -n daemon \
  "BRIDGE_STATE_DIR='$STATE_DIR' bun '$ROOT/core/daemon.mjs' 2>&1 | tee -a '$STATE_DIR/daemon.out'"
tmux set-option -t "$SESSION:daemon" remain-on-exit on

sleep 2
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "❌ 启动失败，session 没起来"
  exit 1
fi
echo "✅ 桥已启动：claude @ $WORKDIR + daemon"
echo "   观看/接管：tmux attach -t $SESSION   停止：bash $ROOT/stop.sh"
