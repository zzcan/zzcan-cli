---
name: feishu-tmux-bridge
description: tmux 注入式飞书桥（纯代码路由，零 LLM 开销）。当用户说 启动 tmux 桥 / start tmux bridge / 飞书 tmux 桥 / 起飞书桥(新版) 时使用。纯代码 daemon 收飞书私聊 → tmux 注入常驻 Claude Code session → Stop hook 感知回复完成 → 发回飞书。旧的 feishu-bridge skill 是 LLM 路由版，与本桥互斥运行。
---

# feishu-tmux-bridge

所有脚本在 `~/.claude/skills/feishu-tmux-bridge/`，状态在 `~/.claude-feishu-tmux-bridge/`。
设计文档：`docs/specs/2026-06-12-feishu-tmux-bridge-design.md`。

**本 skill 只负责帮用户启动/停止/排障，不参与运行时**——消息路由全在 daemon.mjs（纯代码），你不需要也不应该去读 inbox 或代发回复。

## 命令

| 用户说 | 你做 |
|---|---|
| 启动 | `bash start.sh`，把输出贴给用户 |
| 停止 | `bash stop.sh` |
| 状态 | `bash status.sh` |
| 跑测试 | `bun test` + `bash tests/e2e-dry-run.sh` |

## 架构一句话

`lark-cli event +subscribe` → daemon.mjs（过滤/队列/注入）→ tmux session `feishu-bridge`（window `claude` = 常驻 claude，window `daemon` = daemon）→ Stop hook 写 outbox → daemon 读 transcript 增量 → `lark-cli im +messages-send` 发回。

## 手机端可用命令（daemon 处理，不进 Claude）

`/reset`（重启 claude，context 归零）、`/clear`（清 context 不重启）、`/stop`（中断当前轮）、`/status`。

## 排障

- 配置：`~/.claude-feishu-tmux-bridge/config.json`（allowed_senders / workdir / turn_timeout_seconds / receipt_emoji）。改完 `stop.sh && start.sh`。
- 日志：`bridge.log`（daemon 结构化日志）、`daemon.out`（daemon stdout/stderr 原样）。
- 没回复：1) `status.sh` 看两个 pane 是否存活；2) 看 bridge.log 是否有 `skip sender`（open_id 不在白名单）；3) `tmux attach -t feishu-bridge` 直接看 claude 在干嘛（看完 `Ctrl-b d` detach，别 exit）。
- claude 卡在等输入：attach 进去手动处理，或手机发 `/reset`。
- 历史：旧的 LLM 路由版 feishu-bridge skill 已于 2026-06-12 删除；start.sh 里对它的互斥检查保留无害。
