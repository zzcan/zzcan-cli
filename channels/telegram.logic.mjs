// channels/telegram.logic.mjs — Telegram 通道纯逻辑（可单测，无 IO）

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
