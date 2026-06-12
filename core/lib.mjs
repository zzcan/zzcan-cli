// lib.mjs — feishu-tmux-bridge 纯函数层（daemon.mjs 负责 IO，这里只做可单测的逻辑）

// 过滤一行 lark-cli event NDJSON。
// 返回: {action:'allow', openId, text, msgId}
//     | {action:'notify_nontext', openId, msgId}
//     | {action:'skip', reason}
export function filterEvent(line, config, seenIds) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return { action: "skip", reason: "malformed" };
  }
  if (ev?.header?.event_type !== "im.message.receive_v1") {
    return { action: "skip", reason: "type" };
  }
  const msg = ev.event?.message ?? {};
  const openId = ev.event?.sender?.sender_id?.open_id;
  const msgId = msg.message_id;
  if (!openId || !msgId) return { action: "skip", reason: "malformed" };
  if (!config.allowed_senders?.includes(openId)) return { action: "skip", reason: "sender" };
  if (msg.chat_type !== "p2p") return { action: "skip", reason: "group" };
  if (seenIds.has(msgId)) return { action: "skip", reason: "dup" };
  seenIds.add(msgId);
  if (msg.message_type !== "text") return { action: "notify_nontext", openId, msgId };
  let text;
  try {
    text = JSON.parse(msg.content)?.text;
  } catch {
    return { action: "skip", reason: "malformed" };
  }
  if (typeof text !== "string" || text.trim() === "") return { action: "skip", reason: "malformed" };
  return { action: "allow", openId, text, msgId };
}

// 解析 transcript jsonl 增量，抽出本轮所有 assistant 文本块（跳过 thinking/tool_use），按序拼接。
export function parseTranscriptDelta(jsonlText) {
  const parts = [];
  for (const line of jsonlText.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 末尾半行或脏数据
    }
    if (entry?.type !== "assistant") continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        parts.push(block.text);
      }
    }
  }
  return parts.join("\n\n");
}

// daemon 内置命令。无参命令要求消息整体（trim 后）精确等于命令；
// /cd 可带一个工作区名。其余文本一律当对话注入。
const COMMANDS = ["reset", "clear", "stop", "status"];
export function matchCommand(text) {
  const t = text.trim();
  for (const c of COMMANDS) {
    if (t === "/" + c) return { cmd: c, arg: null };
  }
  if (t === "/cd") return { cmd: "cd", arg: null };
  const m = t.match(/^\/cd\s+(\S+)$/);
  if (m) return { cmd: "cd", arg: m[1] };
  return null;
}

export function truncateReply(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n…（已截断）";
}

// ---- 队列状态机（纯 reducer，daemon 解释 actions 做 IO）----
// 不变量：严格串行——current 占用期间新消息只入队；Stop 事件按 FIFO 归属
// （存在 lastAbandoned 时先归它，因为 claude 按序完成各轮）。
export function createQueueState() {
  return { queue: [], current: null, lastAbandoned: null, nextTurnId: 1 };
}

export function queueEvent(state, event) {
  const s = {
    queue: [...state.queue],
    current: state.current,
    lastAbandoned: state.lastAbandoned,
    nextTurnId: state.nextTurnId,
  };
  const actions = [];

  const injectNext = (now) => {
    if (s.queue.length === 0) {
      s.current = null;
      return;
    }
    const msg = s.queue.shift();
    s.current = { msg, turnId: s.nextTurnId++, injectedAt: now };
    actions.push({ type: "inject", msg, turnId: s.current.turnId });
  };

  switch (event.type) {
    case "message":
      if (s.current) {
        s.queue.push(event.msg);
      } else {
        s.queue.push(event.msg);
        injectNext(event.now);
      }
      break;

    case "stop":
      if (s.lastAbandoned) {
        actions.push({ type: "lateFinish", turn: s.lastAbandoned });
        s.lastAbandoned = null;
      } else if (s.current) {
        actions.push({ type: "finish", turn: s.current });
        injectNext(event.now);
      }
      // idle 且无 abandoned：杂散 stop，忽略
      break;

    case "tick":
      if (s.current && event.now - s.current.injectedAt > event.timeoutMs) {
        actions.push({ type: "notifyTimeout", msg: s.current.msg });
        s.lastAbandoned = s.current;
        injectNext(event.now);
      }
      break;

    case "interrupt":
      // /stop：丢弃当前轮与 abandoned（Escape 已打断 claude），队列保留并继续
      s.lastAbandoned = null;
      if (s.current) {
        s.current = null;
        injectNext(event.now);
      }
      break;

    case "reset":
      return { state: createQueueState(), actions: [] };
  }

  return { state: s, actions };
}

// 有状态行分割器：替代 node:readline（Bun 兼容层在 FIFO/pipe 上有丢行风险）。
// 返回 feed(chunk)；每凑齐一行（去掉 \n，跳过空行）回调一次。
export function createLineSplitter(onLine) {
  let buf = "";
  return function feed(chunk) {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) onLine(line);
    }
  };
}

// ---- Telegram 纯逻辑 ----

// 按 maxChars 切块，优先在换行处断（窗口内有 \n 就用最后一个），否则硬切。
export function splitForTelegram(text, maxChars) {
  const chunks = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1);
    const nl = window.lastIndexOf("\n");
    const cut = nl > 0 ? nl : maxChars;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(nl > 0 ? cut + 1 : cut);
  }
  chunks.push(rest);
  return chunks;
}

// 解析一条 getUpdates 的 update（已是对象）。offset 机制保证不重复，无需 seen 去重。
// 返回: {action:'allow', senderId, text, msgId} | {action:'skip', reason}
export function parseTelegramUpdate(update, config) {
  const m = update?.message;
  if (!m) return { action: "skip", reason: "type" };
  const senderId = m.from?.id;
  if (!senderId || !config.allowed_user_ids?.includes(senderId)) return { action: "skip", reason: "sender" };
  if (m.chat?.type !== "private") return { action: "skip", reason: "group" };
  if (typeof m.text !== "string" || m.text.trim() === "") return { action: "skip", reason: "nontext" };
  return { action: "allow", senderId, text: m.text, msgId: m.message_id };
}

// 流式步进决策：当前占位消息已显示 shown，全文长成了 full。
// noop=没变化；edit=编辑为 full；rollover=占位消息用 finalize 定稿，carry 开新占位继续。
export function nextStreamStep(shown, full, maxChars) {
  if (full === shown) return { type: "noop" };
  if (full.length <= maxChars) return { type: "edit", text: full };
  const [finalize, ...rest] = splitForTelegram(full, maxChars);
  return { type: "rollover", finalize, carry: rest.join("\n") };
}

// from=0 兜底读取（session 切换/auto-compact 后路径变了）时使用：
// 只取“最后一条真人消息”之后的 assistant 文本，防止把整段历史当回复发出去。
// 注意：一轮之内的 tool_result 也是 type:"user" 行，不算真人消息。
export function parseLastTurnDelta(jsonlText) {
  const lines = jsonlText.split("\n");
  let lastHumanIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry?.type !== "user") continue;
    const content = entry.message?.content;
    const isToolResult = Array.isArray(content) && content.some((b) => b?.type === "tool_result");
    if (!isToolResult) lastHumanIdx = i;
  }
  return parseTranscriptDelta(lines.slice(lastHumanIdx + 1).join("\n"));
}
