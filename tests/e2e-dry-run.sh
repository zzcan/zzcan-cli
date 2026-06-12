#!/usr/bin/env bash
# e2e-dry-run.sh — 不发真飞书、不起真 claude 的全链路测试：
#   假事件(stdin) → daemon 过滤/队列 → tmux 注入假 claude → 假 claude 写 transcript+outbox
#   → daemon 读增量 → dry-run 落盘回复。断言串行顺序与 /status 命令路径。
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP=$(mktemp -d)
SESSION="fbridge-test-$$"
trap 'tmux kill-session -t "$SESSION" 2>/dev/null || true; kill "$DAEMON_PID" 2>/dev/null || true; rm -rf "$TMP"' EXIT

mkdir -p "$TMP"
TRANSCRIPT="$TMP/transcript.jsonl"
OUTBOX="$TMP/outbox.ndjson"
touch "$TRANSCRIPT" "$OUTBOX"

cat > "$TMP/config.json" << EOF
{ "allowed_senders": ["ou_test"], "workdir": "$TMP", "turn_timeout_seconds": 300, "max_reply_chars": 20000 }
EOF

# 假 claude：每读到一行，appen 一条 assistant transcript + 一条 stop 事件
cat > "$TMP/fake-claude.sh" << EOF
#!/usr/bin/env bash
while IFS= read -r line; do
  jq -cn --arg t "echo: \$line" '{type:"assistant",message:{content:[{type:"text",text:\$t}]}}' >> "$TRANSCRIPT"
  jq -cn --arg p "$TRANSCRIPT" '{session_id:"s1",transcript_path:\$p}' >> "$OUTBOX"
done
EOF
chmod +x "$TMP/fake-claude.sh"

tmux new-session -d -s "$SESSION" -n fake "bash $TMP/fake-claude.sh"

# 事件源：daemon spawn `tail -F` 读假事件文件——与生产 spawn lark-cli 完全同一条代码路径
EVENTS="$TMP/events.ndjson"
touch "$EVENTS"
BRIDGE_DRY_RUN=1 BRIDGE_STATE_DIR="$TMP" BRIDGE_TMUX_TARGET="$SESSION:fake" BRIDGE_PASTE_MODE=plain \
  BRIDGE_LISTENER_CMD="tail -n +1 -F '$EVENTS'" \
  bun "$SKILL_DIR/core/daemon.mjs" >> "$TMP/daemon.out" 2>&1 &
DAEMON_PID=$!

event() {
  jq -cn --arg id "$1" --arg text "$2" '{
    header: {event_type: "im.message.receive_v1"},
    event: {
      sender: {sender_id: {open_id: "ou_test"}},
      message: {chat_type: "p2p", message_type: "text", message_id: $id, content: ({text: $text} | tostring)}
    }
  }' >> "$EVENTS"
}

sleep 1
event om_1 "第一条"
event om_2 "第二条"
event om_3 "/status"
# 白名单外的消息必须被无视
jq -cn '{header:{event_type:"im.message.receive_v1"},event:{sender:{sender_id:{open_id:"ou_evil"}},message:{chat_type:"p2p",message_type:"text",message_id:"om_evil",content:"{\"text\":\"hack\"}"}}}' >> "$EVENTS"

# 等 3 个 dry-run 回复文件（2 条 echo + 1 条 status）
for i in $(seq 1 30); do
  COUNT=$(ls "$TMP/dry-run" 2>/dev/null | wc -l | tr -d ' ' || true)
  if [ "$COUNT" -ge 3 ]; then break; fi
  sleep 0.5
done

FILES=$(ls "$TMP/dry-run" | sort)
[ "$(echo "$FILES" | wc -l | tr -d ' ')" = "3" ] || { echo "FAIL: 期望 3 个回复，得到：$FILES"; cat "$TMP/daemon.out"; exit 1; }

# /status 是快路径会先回；两条对话回复必须严格有序
E1=$(grep -l "echo: 第一条" "$TMP"/dry-run/* || true)
E2=$(grep -l "echo: 第二条" "$TMP"/dry-run/* || true)
ST=$(grep -l "bridge 状态" "$TMP"/dry-run/* || true)
[ -n "$E1" ] || { echo "FAIL: 缺第一条回复"; exit 1; }
[ -n "$E2" ] || { echo "FAIL: 缺第二条回复"; exit 1; }
[ -n "$ST" ] || { echo "FAIL: 缺 /status 回复"; exit 1; }
[ "$(basename "$E1")" \< "$(basename "$E2")" ] || { echo "FAIL: 回复乱序: $E1 vs $E2"; exit 1; }
if grep -q "hack" "$TMP"/dry-run/*; then echo "FAIL: 白名单外消息被处理了"; exit 1; fi

echo "PASS: e2e dry-run（串行顺序 ✓ /status ✓ 白名单 ✓）"
