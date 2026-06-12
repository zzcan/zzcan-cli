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

// daemon 内置命令：消息整体（trim 后）精确等于命令才命中，其余一律当对话注入。
const COMMANDS = ["reset", "clear", "stop", "status"];
export function matchCommand(text) {
  const t = text.trim();
  for (const c of COMMANDS) {
    if (t === "/" + c) return c;
  }
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

    case "reset":
      return { state: createQueueState(), actions: [] };
  }

  return { state: s, actions };
}
