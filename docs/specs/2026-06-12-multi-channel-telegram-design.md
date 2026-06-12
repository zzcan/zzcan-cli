# 通用化 + Telegram 通道设计

日期：2026-06-12
状态：已确认
前置：`2026-06-12-feishu-tmux-bridge-design.md`（飞书版基础架构）

## 已确认的决策

| 决策点 | 选择 |
|---|---|
| 多通道模型 | 飞书 + Telegram **共享同一个 claude session**，同一条 FIFO 队列，回复发回消息来源通道 |
| 仓库形态 | 独立项目 `~/Desktop/workspace/codes/claude-tmux-bridge`，GitHub public；`~/.claude/skills/` 只留薄壳 SKILL.md |
| TG 回复形式 | **流式**（占位消息 + 每 ~2s `editMessageText` 增量），飞书维持一次性全文 |
| 状态目录 | 改名 `~/.claude-tmux-bridge/`，启动时自动从旧 `~/.claude-feishu-tmux-bridge/` 迁移 config |

## 目录结构

```
core/lib.mjs            纯逻辑（过滤/队列/transcript/命令/截断/行分割 + TG 切分、流式节流）
core/daemon.mjs         编排器，channel 无关：队列、注入、Stop hook、超时、命令
channels/feishu.mjs     lark-cli 订阅 / lark-cli 发送 / 表情回应回执
channels/telegram.mjs   getUpdates 长轮询 / sendMessage / typing 回执 / editMessageText 流式
stop-hook.sh  start.sh  stop.sh  status.sh
tests/                  单测 + e2e（飞书路径不回归 + TG 假 Bot API server）
```

## Channel adapter 接口

```js
{
  name: "feishu" | "telegram",
  start(onMessage),        // 开始监听；onMessage({channel, senderId, text, msgId})
                           // 自动重连/重拉由 adapter 自己负责
  send(senderId, text),    // 终稿回复（async，失败自行重试，返回 bool）
  receipt(msg),            // 即时回执，best-effort（飞书=表情回应；TG=sendChatAction typing）
  stream?: {               // 可选；daemon 据此决定是否流式
    begin(senderId),       // → handle（占位消息）
    update(handle, text),  // 编辑占位消息为当前累计文本
    end(handle, text),     // 终稿（超长时 adapter 自行切多条）
  }
}
```

队列消息对象从 `{openId, text, msgId}` 扩展为 `{channel, senderId, text, msgId}`。
finish/lateFinish 路由：`adapters[turn.msg.channel].send(...)`。
daemon 内置命令（/reset /clear /stop /status）对所有通道一致。

## 流式机制（daemon 侧，通道无关）

- 注入时若当前消息的 adapter 有 `stream`：调 `begin` 拿 handle，并启动 2s 间隔 timer
- timer 每次从该轮 offset 读 transcript 增量（不消费，只 peek），文本有变化才调 `update`
- Stop 事件 → 停 timer → `end(handle, 终稿)`；超时放弃 → 停 timer → end 留占位 + 超时提示
- transcript 路径未知（首轮）时跳过流式更新，只在 Stop 后发终稿

## Telegram 细节

- **长轮询**：`getUpdates timeout=50&offset=...`，单 fetch 失败指数退避重试；按 `message.from.id` 白名单过滤，仅 private chat、仅 text
- **发送**：`sendMessage` 纯文本（不开 parse_mode）；>4096 字符切多条（lib 纯函数 `splitForTelegram`）
- **流式编辑**：占位 "…"；`editMessageText` 文本不变时跳过（TG 会报 message is not modified）；累计超 4096 → 当前消息定稿，发新占位续写
- **代理**：`config.channels.telegram.proxy`（Bun fetch `proxy` 选项），未配置时读 `HTTPS_PROXY`
- **token/uid**：`config.channels.telegram.bot_token` + `allowed_user_ids`；缺 token 则该通道不启动（日志提示）

## config.json 新结构（启动时自动迁移旧结构）

```json
{
  "workdir": "~/Desktop/workspace",
  "turn_timeout_seconds": 300,
  "max_reply_chars": 20000,
  "channels": {
    "feishu":   { "enabled": true, "allowed_senders": ["ou_..."], "receipt_emoji": "OnIt" },
    "telegram": { "enabled": false, "bot_token": "", "allowed_user_ids": [], "proxy": "" }
  }
}
```

## 测试策略

- 现有 27 单测全部保留（守住飞书逻辑不回归），import 路径更新
- 新增单测：`splitForTelegram`、TG update 解析（`parseTelegramUpdate`）、流式节流决策（纯函数）
- e2e：现有 dry-run 不变；TG 端用 bun 起假 Bot API HTTP server（getUpdates 喂假消息、记录 sendMessage/editMessageText 调用）跑全链路
- 真机验收：飞书回归一条 + TG 发一条看流式

## 明确不做

- 飞书伪流式（卡片 edit）——接口已留，需要时单独做
- TG 群聊、图片、命令菜单（setMyCommands 之后再说）
- webhook 模式
