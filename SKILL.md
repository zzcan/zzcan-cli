---
name: zzcan-cli
description: IM（飞书/Telegram）↔ 本机 Claude Code 聊天桥。当用户说 启动聊天桥 / start bridge / 起桥 / 把飞书或 telegram 消息接到 claude 时使用。纯代码 daemon 路由，本 skill 只负责 start/stop/status/排障，不参与运行时。
---

# zzcan-cli

项目根目录（下称 `$ROOT`）：本文件所在目录。状态在 `~/.zzcan-cli/`。
架构与协议见 `$ROOT/README.md` 与 `docs/specs/`。

**本 skill 只负责帮用户启动/停止/排障**——消息路由全在 daemon（纯代码），你不需要也不应该代收消息或代发回复。

## 命令

| 用户说 | 你做 |
|---|---|
| 启动 | `bash $ROOT/start.sh`，把输出贴给用户 |
| 停止 | `bash $ROOT/stop.sh` |
| 状态 | `bash $ROOT/status.sh` |
| 跑测试 | `cd $ROOT && bun run test` |

## 手机端可用命令（daemon 处理，不进 Claude）

`/reset`（重启 claude，context 归零）、`/clear`（清 context 不重启）、`/stop`（中断当前轮）、`/status`、`/cd <名字>`（切到 config workspaces 里登记的工作区，context 清零；`/cd` 单发列出可选项）。

## 排障

- 配置：`~/.zzcan-cli/config.json`（workdir / 超时 / channels.feishu / channels.telegram）。改完 `stop.sh && start.sh`。
- 日志：`~/.zzcan-cli/bridge.log`（结构化）、`daemon.out`（原样输出）。
- 没回复：1) `status.sh` 看 pane 存活；2) bridge.log 找 `skip sender`（不在白名单）；3) `tmux attach -t zzcan-cli` 直接看（`Ctrl-b d` 退出，别 exit）。
- Telegram 不通：大概率代理——config 的 `channels.telegram.proxy` 或环境 `HTTPS_PROXY`；看 bridge.log 的 `telegram poll error`。
- claude 卡在等输入：attach 进去手动处理，或手机发 `/reset`。
