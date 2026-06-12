// channels/feishu.logic.mjs — 飞书通道纯逻辑（可单测，无 IO）

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
