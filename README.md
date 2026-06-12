# zzcan-cli

把 IM 私聊（飞书 / Telegram）接到一个常驻的交互式 Claude Code session 上——在手机上和你电脑里的 Claude 对话。

**纯代码路由，零 LLM 转发开销**：消息往返链路上没有任何额外的模型调用，延迟 ≈ Claude 本身的响应时间 + 1~2 秒。

```
飞书/Telegram ──► daemon（bun，常驻）──► tmux 注入常驻 claude
                      ▲                        │
                      └── outbox ◄── Stop hook（回复完成的确定性信号）
                      │
                      └──► 回复路由回来源通道（Telegram 流式打字机效果）
```

## 为什么是这个架构

- **常驻交互式 session**：进程和 context 都是热的，没有每条消息冷启动 CLI / 重载 MCP 的开销；跑的是交互式 Claude Code，走订阅而非 API 计费。
- **Stop hook 而非启发式**：Claude Code 的 Stop hook 在每轮回复结束时确定性触发并给出 transcript 路径——不需要 pane 静默检测、不需要猜"说完没"。
- **tmux 是免费的观察窗**：`tmux attach -t zzcan-cli` 随时看到/接管手机上那场对话。

## 特性

- 多通道共享同一个 claude session（飞书问一半换 Telegram 接着聊，context 连贯），回复发回来源通道
- Telegram 流式输出（占位消息 + 增量编辑，超 4096 字符自动滚动到新消息）；飞书一次性全文 + 表情回执
- 白名单（飞书 open_id / Telegram user id），仅私聊、仅文本
- 严格串行队列：连发多条按序处理，互不串扰
- 内置命令（不进 Claude，daemon 纯代码处理）：`/reset` 重启 claude、`/clear` 清 context、`/stop` 中断当前轮、`/status`、`/cd <名字>` 切换预登记的工作区（config 的 `workspaces` 映射；切换会重启 claude、context 清零）
- claude 进程死亡自动 respawn；监听断线自动重连并告警；单轮超时提醒
- 大陆环境：Telegram 走 `proxy` 配置或 `HTTPS_PROXY`

## 依赖

[bun](https://bun.sh) ≥ 1.0、tmux、jq、[Claude Code](https://claude.com/claude-code)；飞书通道需 [lark-cli](https://github.com/larksuite/cli)（已登录 bot 身份）。

## 快速开始

```bash
git clone https://github.com/<you>/zzcan-cli && cd zzcan-cli
bash start.sh        # 首次运行生成 ~/.zzcan-cli/config.json
```

编辑 `~/.zzcan-cli/config.json`：

```json
{
  "workdir": "~/your/workspace",
  "turn_timeout_seconds": 300,
  "max_reply_chars": 20000,
  "channels": {
    "feishu":   { "enabled": true,  "allowed_senders": ["ou_你的openid"], "receipt_emoji": "OnIt" },
    "telegram": { "enabled": true,  "bot_token": "123:ABC", "allowed_user_ids": [11111111], "proxy": "http://127.0.0.1:7890" }
  }
}
```

再 `bash start.sh`。停止 `bash stop.sh`，状态 `bash status.sh`。

Telegram bot 找 [@BotFather](https://t.me/BotFather) 创建；你的 user id 可以先给 bot 发条消息，再看 `bridge.log` 里的 `telegram skip sender` 行。

## 测试

```bash
bun test                     # 单测（纯逻辑：过滤/队列/transcript/TG 切分与流式步进）
bash tests/e2e-dry-run.sh    # 飞书链路端到端（假事件源 + 假 claude，不真发）
bash tests/e2e-telegram.sh   # Telegram 链路端到端（假 Bot API server，验证流式）
```

## 安全

桥里的 claude 以 `--dangerously-skip-permissions` 运行（否则权限弹窗会卡死无人值守的桥）——**安全边界就是白名单**，确保里面只有你自己。Stop hook 通过 `claude --settings` 注入，只对桥的 session 生效，不影响你日常使用 Claude Code。

## 设计文档

见 `docs/specs/`。

## License

MIT
