# feishu-tmux-bridge 设计

日期：2026-06-12
状态：已确认（用户已批准核心决策与架构）

## 背景与目标

现有 `feishu-bridge` skill 用「LLM 当路由器」：每条飞书消息唤醒一个满载 SKILL.md 的 Claude 主 session，走 read-inbox → filter → classify → safety → reply 的多轮推理，且长 session context 持续膨胀——这是延迟大、越用越卡的根因。

本项目用**纯代码常驻进程**替换整个路由层：飞书消息 → tmux 注入常驻交互式 Claude Code session → Stop hook 确定性感知回复完成 → lark-cli 发回飞书。全链路除 Claude 本身推理外零 LLM 调用。

**目标延迟**：Claude 响应时间 + 1~2s。
**适用场景**：单用户（白名单只有本人）、私聊、纯文字、以对话为主的临时使用。

## 已确认的决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 权限模式 | `--dangerously-skip-permissions` | 永不卡权限弹窗；白名单仅本人，风险可控 |
| 回复形式 | 一次性全文 + 即时回执（⏳ 表情回应） | 实现简单可靠；transcript 读取按增量偏移设计，留伪流式扩展点 |
| 工作目录 | 固定单目录（默认 `~/Desktop/workspace`，config 可改） | 纯对话场景不需要 multi-repo 路由；换目录重启桥 |
| 完成检测 | Claude Code **Stop hook**（方案 A） | 确定性信号，零启发式；优于 pane 静默检测（B）和 `claude -p --resume` 每条冷启动（C，MCP 多时启动 5-10s） |

## 总体架构

```
飞书私聊 ──lark-cli event +subscribe (NDJSON stdout)──▶ daemon.mjs (bun, 常驻)
                                                          │ 过滤(白名单/p2p/text/去重) → FIFO 队列
                                                          │ 即时回执 ⏳（消息表情回应）
                                                          ▼
                                          tmux load-buffer + paste-buffer -p + send-keys Enter
                                                          │ （注入时记录 transcript 字节偏移）
                                                          ▼
                                          常驻 claude（tmux session "feishu-bridge" window 0）
                                                          │ 回复完成
                                                          ▼
                                          Stop hook → append {session_id, transcript_path, ts}
                                                       到 outbox.ndjson
                                                          ▼
                          daemon 监听 outbox → 从记录偏移读 transcript 增量，抽 assistant 文本块
                                                          │
                                                          ▼
                          lark-cli im +messages-send（带 idempotency-key + 3 次重试）→ 注入队列下一条
```

## 目录与文件

代码：`~/.claude/skills/feishu-tmux-bridge/`

```
daemon.mjs          # 核心常驻进程（bun，单文件，纯函数部分可单测）
stop-hook.sh        # Stop hook：stdin JSON → append 一行到 outbox.ndjson
start.sh            # 建 tmux session + 起 claude + 起 daemon（幂等）
stop.sh             # tmux kill-session -t feishu-bridge（只杀自己，绝不 kill-server）
status.sh           # daemon/claude 存活、队列长度、当前轮耗时
SKILL.md            # 薄层：教 agent 帮用户 start/stop/status/排障，不参与运行时
tests/              # bun test 单测 + dry-run 端到端
docs/specs/         # 本文档
```

状态：`~/.claude-feishu-tmux-bridge/`

```
config.json         # allowed_senders / workdir / turn_timeout_seconds 等
bridge-settings.json# 传给 claude --settings 的 hook 配置（只对桥 session 生效）
outbox.ndjson       # Stop hook 写、daemon 读
seen-message-ids.txt# 去重，保留最近 1000 条
bridge.log          # daemon 日志
```

### config.json 字段

```json
{
  "allowed_senders": ["ou_..."],        // 初始化时从 ~/.claude-feishu-bridge/config.json 引导
  "workdir": "~/Desktop/workspace",     // 常驻 claude 的 cwd
  "turn_timeout_seconds": 300,          // 单轮超时
  "claude_extra_args": []               // 预留
}
```

## 组件设计

### 1. daemon.mjs（核心）

单进程四职责，跑在 `feishu-bridge` tmux session 的 window 1：

**收**：spawn `lark-cli event +subscribe --as bot --event-types im.message.receive_v1 --quiet`，逐行读 stdout NDJSON。子进程退出 → 指数退避重拉，连续失败 ≥3 次回飞书告警。

**滤**：从现有 `filter.sh` 移植为纯函数 `filterEvent(line, config, seenIds)`：
- 非法 JSON → skip
- sender 不在 `allowed_senders` → skip
- 非 p2p → skip
- 非 text → 回一句「暂只支持文字」后 skip
- msg_id 已见 → skip（seen 文件保留最近 1000 条）
- 通过 → `{openId, text, msgId}`

**注**：内存 FIFO 队列，**严格串行**——当前轮未收到 Stop 事件不注入下一条。注入步骤：
1. 记录 transcript 文件当前字节大小为 `offset`
2. `tmux load-buffer -b fb -` ← 消息文本
3. `tmux paste-buffer -p -b fb -t feishu-bridge:0`（bracketed paste，多行不提前提交）
4. `tmux send-keys -t feishu-bridge:0 Enter`
5. 发 ⏳ 表情回应到原消息（失败不阻塞主流程，降级为不发回执）

**回**：监听 outbox.ndjson（fs.watch + 1s 轮询兜底）。收到 Stop 事件 → 从 `offset` 读 transcript 增量，解析 jsonl 中 `type === "assistant"` 行的 `message.content[]` 文本块，按序拼接为回复。发送复用现有 `reply-text.sh` 语义：`lark-cli im +messages-send --as bot --user-id <openId> --text <reply> --idempotency-key <key>`，重试 3 次（5/15/45s）。超长截断到飞书文本上限并标注「（已截断）」。发送后从队列取下一条注入。

**管**：
- 单轮超时（默认 300s）→ 回飞书「⚠️ 可能卡在等输入，发 /reset 重置，或电脑上 tmux attach -t feishu-bridge 看看」；本轮标记放弃，继续处理队列。放弃后若迟到的 Stop 事件到达（按注入时记录的轮次 ID 比对），仍把该轮回复补发到飞书，但不影响已继续的队列处理
- claude pane 不存在/进程死 → respawn window 0 并通知
- transcript 路径发现：优先用 Stop hook 给的 `transcript_path`；注入时若未知（首轮），offset 取 0 或文件当前大小

### 2. stop-hook.sh

```
stdin JSON {session_id, transcript_path, ...}
  → jq 抽字段 → append 一行到 ~/.claude-feishu-tmux-bridge/outbox.ndjson
```

通过 bridge-settings.json 注入：

```json
{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/skills/feishu-tmux-bridge/stop-hook.sh" }] }] } }
```

只通过 `claude --settings` 加载，**不写入用户全局/项目 settings**，对日常 Claude 使用零影响。

### 3. start.sh

幂等启动：
1. **互斥检查**：发现旧 feishu-bridge 的 listener（`~/.claude-feishu-bridge/listener.pid` 存活）→ 拒绝启动并提示先停旧桥（两套同时订阅会双重回复）
2. `tmux has-session -t feishu-bridge` 已存在 → 直接报状态退出
3. 新建 session（不碰用户现有的 `main` session）：
   ```
   tmux new-session -d -s feishu-bridge -c <workdir> \
     claude --dangerously-skip-permissions \
            --settings ~/.claude-feishu-tmux-bridge/bridge-settings.json \
            --append-system-prompt "<桥接须知>"
   tmux new-window -t feishu-bridge -n daemon \
     bun ~/.claude/skills/feishu-tmux-bridge/daemon.mjs
   ```
4. 启动成功后由 daemon 发一条「✅ 桥已启动 (workdir: ...)」到飞书

**桥接须知**（--append-system-prompt 内容要点）：你通过飞书桥与用户对话；回复全文会原样发到用户手机，保持简洁、少用宽表格；**禁止使用 AskUserQuestion**（会无限阻塞桥），需要用户决策时用普通文字提问。

### 4. tmux 隔离保证

- 所有 tmux 操作显式 `-t feishu-bridge[:window]`，不会打到用户 `main` session 的任何 pane
- `stop.sh` 只用 `kill-session -t feishu-bridge`；代码中禁止出现 `kill-server`
- 不修改 `~/.tmux.conf`、不改 tmux server 全局选项
- 附带收益：用户 tailscale ssh 后 `tmux attach -t feishu-bridge` 可实时观看/接管对话

## daemon 内置命令（纯代码处理，不进 Claude）

| 命令 | 行为 |
|---|---|
| `/reset` | respawn window 0 的 claude 进程，context 归零 |
| `/clear` | 透传 `/clear` 给 claude（不重启进程，秒级清 context） |
| `/stop` | `send-keys Escape` 中断当前轮，清空本轮等待状态 |
| `/status` | 回 daemon/claude 存活、队列长度、当前轮已耗时 |

匹配规则：消息整体精确等于命令（含前导 `/`），其余一律当对话注入。

## 明确不做（YAGNI）

- multi-repo 路由（/use、/at、URL 推断）、classify、safety-check、subagent dispatch
- 卡片伪流式（留扩展点：transcript 增量读取天然支持）
- 群聊、图片/文件/富文本消息（过滤层 SKIP，非文字回提示）
- 漏消息 reconcile 回填（daemon 挂掉期间的消息会丢；v1 接受，记为已知限制）
- 旧 feishu-bridge skill 不改不删，两套并存但互斥运行（start.sh 检查）

## 测试策略

1. **单测（bun test）**：filterEvent、队列状态机（串行/超时/放弃）、transcript 增量解析（含多 assistant 消息一轮、思考块过滤）
2. **Dry-run 端到端**：`BRIDGE_DRY_RUN=1` 时不真发飞书（落文件），手工向 daemon 喂假 NDJSON 事件，断言 tmux 注入调用与回贴内容
3. **真机验收**：
   - 手机发「你好」→ 收到 ⏳ 回执 + 文字回复
   - 连发两条 → 严格按序串行回复
   - `/status` `/clear` `/reset` 各验证一次
   - kill claude 进程 → 自动 respawn + 飞书通知

## 已知限制

- daemon 离线期间的消息不回填（无 reconcile）
- Stop hook 依赖 Claude Code 当前 hook 行为；Claude Code 大版本升级后需跑一次真机验收
- bypass 权限 + 手机可达 = 手机端可让 Claude 执行任意命令；安全边界是飞书白名单（仅本人 open_id）
