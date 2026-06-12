#!/usr/bin/env bash
# e2e-telegram.sh — Telegram 通道全链路（含流式）：
#   假 Bot API server ← 长轮询/sendMessage/editMessageText → daemon（真 telegram 适配器）
#   → tmux 注入假 claude（分两段写 transcript，间隔 3s）→ 断言：
#   typing 回执、占位消息、流式中途 edit 出现第一段、终稿包含两段。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP=$(mktemp -d)
SESSION="tgbridge-test-$$"
PORT=$(( (RANDOM % 10000) + 40000 ))
trap 'tmux kill-session -t "$SESSION" 2>/dev/null || true; { kill "$DAEMON_PID" "$SERVER_PID" 2>/dev/null; wait "$DAEMON_PID" "$SERVER_PID" 2>/dev/null; } || true; rm -rf "$TMP"' EXIT

TRANSCRIPT="$TMP/transcript.jsonl"
OUTBOX="$TMP/outbox.ndjson"
CALLS="$TMP/tg-calls.ndjson"
touch "$TRANSCRIPT" "$OUTBOX" "$CALLS" "$TMP/tg-inbound.ndjson"

cat > "$TMP/config.json" << EOF
{
  "workdir": "$TMP", "turn_timeout_seconds": 300, "max_reply_chars": 20000,
  "channels": {
    "feishu":   { "enabled": false, "allowed_senders": [] },
    "telegram": { "enabled": true, "bot_token": "TESTTOKEN", "allowed_user_ids": [111], "proxy": "" }
  }
}
EOF

# 假 claude：收到一行输入 → 写第一段 → 等 3s（让流式 timer 抓到中间态）→ 写第二段 + stop 事件
cat > "$TMP/fake-claude.sh" << EOF
#!/usr/bin/env bash
while IFS= read -r line; do
  jq -cn --arg t "第一段：\$line" '{type:"assistant",message:{content:[{type:"text",text:\$t}]}}' >> "$TRANSCRIPT"
  sleep 3
  jq -cn '{type:"assistant",message:{content:[{type:"text",text:"第二段收尾"}]}}' >> "$TRANSCRIPT"
  jq -cn --arg p "$TRANSCRIPT" '{session_id:"s1",transcript_path:\$p}' >> "$OUTBOX"
done
EOF
chmod +x "$TMP/fake-claude.sh"
tmux new-session -d -s "$SESSION" -n fake "bash $TMP/fake-claude.sh"

bun "$ROOT/tests/fake-tg-server.mjs" "$PORT" "$TMP" >> "$TMP/server.out" 2>&1 &
SERVER_PID=$!
sleep 0.5

BRIDGE_STATE_DIR="$TMP" BRIDGE_TMUX_TARGET="$SESSION:fake" BRIDGE_PASTE_MODE=plain \
  BRIDGE_TG_API_BASE="http://127.0.0.1:$PORT" BRIDGE_TRANSCRIPT_PATH="$TRANSCRIPT" \
  bun "$ROOT/core/daemon.mjs" >> "$TMP/daemon.out" 2>&1 &
DAEMON_PID=$!
sleep 1

# 注入一条 TG 消息（白名单用户 111，私聊）
jq -cn '{update_id: 1, message: {message_id: 7, from: {id: 111}, chat: {id: 111, type: "private"}, text: "你好"}}' >> "$TMP/tg-inbound.ndjson"

# 等终稿（editMessageText 内容包含“第二段收尾”）
for i in $(seq 1 40); do
  if grep -q "第二段收尾" "$CALLS" 2>/dev/null; then break; fi
  sleep 0.5
done

fail() { echo "FAIL: $1"; echo "--- calls:"; cat "$CALLS"; echo "--- daemon:"; cat "$TMP/daemon.out"; exit 1; }

grep -q '"method":"sendChatAction"' "$CALLS" || fail "没有 typing 回执"
grep -q '"text":"…"' "$CALLS" || fail "没有占位消息"
# 流式中间态：终稿之前应有一次 edit 只含第一段、不含第二段
MIDDLE=$(grep '"method":"editMessageText"' "$CALLS" | grep "第一段" | grep -v "第二段收尾" || true)
[ -n "$MIDDLE" ] || fail "没有捕捉到流式中间态（只含第一段的 edit）"
FINAL=$(grep '"method":"editMessageText"' "$CALLS" | tail -1)
echo "$FINAL" | grep -q "第一段" || fail "终稿缺第一段"
echo "$FINAL" | grep -q "第二段收尾" || fail "终稿缺第二段"

echo "PASS: e2e telegram（typing ✓ 占位 ✓ 流式中间态 ✓ 终稿 ✓）"
