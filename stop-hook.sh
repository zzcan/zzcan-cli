#!/usr/bin/env bash
# stop-hook.sh — Claude Code Stop hook：stdin JSON → append 一行到 outbox。
# 只通过 bridge-settings.json 挂载到桥的 claude session，不影响日常使用。
set -euo pipefail
STATE_DIR="${BRIDGE_STATE_DIR:-$HOME/.claude-feishu-tmux-bridge}"
jq -c '{session_id, transcript_path, ts: (now | floor)}' >> "$STATE_DIR/outbox.ndjson"
