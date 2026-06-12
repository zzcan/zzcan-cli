#!/usr/bin/env bash
# stop-hook.sh — Claude Code Stop hook：stdin JSON → append 一行到 outbox。
# 只通过 bridge-settings.json 挂载到 Cli 的 claude session，不影响日常使用。
set -euo pipefail
STATE_DIR="${BRIDGE_STATE_DIR:-$HOME/.zzcan-cli}"
jq -c '{session_id, transcript_path, ts: (now | floor)}' >> "$STATE_DIR/outbox.ndjson"
