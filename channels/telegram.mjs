// channels/telegram.mjs — Telegram 通道适配器。
// listen = getUpdates 长轮询（offset 持久化，崩溃重启不重复消费）
// send   = sendMessage 纯文本，>4096 自动切多条
// receipt= sendChatAction typing
// stream = 占位消息 + editMessageText 增量；超 4096 定稿当前条、开新占位续写
//
// 环境变量：BRIDGE_TG_API_BASE 覆盖 API 根（e2e 假 server 用，默认 https://api.telegram.org）
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTelegramUpdate, splitForTelegram, nextStreamStep } from "./telegram.logic.mjs";

const TG_MAX = 4096;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createTelegramChannel({ config, stateDir, log, onListenerDown }) {
  const apiBase = process.env.BRIDGE_TG_API_BASE || "https://api.telegram.org";
  const base = `${apiBase}/bot${config.bot_token}`;
  const proxy = config.proxy || process.env.HTTPS_PROXY || undefined;
  const OFFSET_FILE = join(stateDir, "telegram-offset.txt");
  let stopped = false;

  async function api(method, payload, { timeoutMs = 30000 } = {}) {
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
      ...(proxy ? { proxy } : {}),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(`tg ${method}: ${j.description || res.status}`);
    return j.result;
  }

  function start(onMessage) {
    // 注册命令菜单（输入框的 / 提示），best-effort
    api("setMyCommands", {
      commands: [
        { command: "status", description: "Cli 状态：通道/工作区/当前轮/排队" },
        { command: "cd", description: "切换工作区（/cd 列出可选项）" },
        { command: "clear", description: "清空 context（不重启进程）" },
        { command: "stop", description: "中断当前正在生成的回复" },
        { command: "reset", description: "重启 Claude，context 归零" },
      ],
    }).catch((e) => log(`telegram setMyCommands failed: ${e.message || e}`));
    let offset = existsSync(OFFSET_FILE) ? parseInt(readFileSync(OFFSET_FILE, "utf8"), 10) || 0 : 0;
    let failStreak = 0;
    (async () => {
      while (!stopped) {
        try {
          const updates = await api("getUpdates", { offset, timeout: 50 }, { timeoutMs: 60000 });
          failStreak = 0;
          for (const u of updates) {
            offset = u.update_id + 1;
            writeFileSync(OFFSET_FILE, String(offset));
            const r = parseTelegramUpdate(u, config);
            if (r.action === "skip") {
              // sender 拒绝时带上来访 id，方便 onboarding 时从日志抄白名单
              if (r.reason !== "type") log(`telegram skip ${r.reason}${r.reason === "sender" ? ` from=${u.message?.from?.id}` : ""}`);
              if (r.reason === "nontext" && u.message?.chat?.type === "private"
                  && config.allowed_user_ids?.includes(u.message?.from?.id)) {
                onMessage({ channel: "telegram", senderId: u.message.from.id, text: null, msgId: u.message.message_id, nontext: true });
              }
              continue;
            }
            onMessage({ channel: "telegram", senderId: r.senderId, text: r.text, msgId: r.msgId });
          }
        } catch (e) {
          failStreak++;
          const delay = Math.min(60000, 1000 * 2 ** failStreak);
          log(`telegram poll error: ${e.message || e}, retry in ${delay}ms (streak=${failStreak})`);
          if (failStreak === 3) onListenerDown?.("telegram");
          await sleep(delay);
        }
      }
    })();
  }

  async function send(senderId, text) {
    for (const chunk of splitForTelegram(text, TG_MAX)) {
      let ok = false;
      for (let i = 0; i < 3 && !ok; i++) {
        try {
          await api("sendMessage", { chat_id: senderId, text: chunk });
          ok = true;
        } catch (e) {
          log(`telegram send retry ${i + 1}: ${e.message || e}`);
          await sleep(2000 * (i + 1));
        }
      }
      if (!ok) {
        log(`telegram send FAILED to=${senderId}`);
        return false;
      }
    }
    return true;
  }

  function receipt(msg) {
    api("sendChatAction", { chat_id: msg.senderId, action: "typing" })
      .catch((e) => log(`telegram receipt failed: ${e.message || e}`));
  }

  const stream = {
    async begin(senderId) {
      const m = await api("sendMessage", { chat_id: senderId, text: "…" });
      return { chatId: senderId, messageId: m.message_id, shown: "" };
    },
    async update(handle, full) {
      // rollover 可能连环（一次涨超过两个 4096 窗口），循环直到 edit/noop
      for (;;) {
        const step = nextStreamStep(handle.shown, full, TG_MAX);
        if (step.type === "noop") return;
        if (step.type === "edit") {
          await api("editMessageText", { chat_id: handle.chatId, message_id: handle.messageId, text: step.text });
          handle.shown = step.text;
          return;
        }
        await api("editMessageText", { chat_id: handle.chatId, message_id: handle.messageId, text: step.finalize });
        const m = await api("sendMessage", { chat_id: handle.chatId, text: "…" });
        handle.messageId = m.message_id;
        handle.shown = "";
        full = step.carry;
      }
    },
    async end(handle, full) {
      try {
        await stream.update(handle, full || "（本轮无文字回复）");
      } catch (e) {
        log(`telegram stream end failed: ${e.message || e}`);
      }
    },
  };

  return { name: "telegram", displayName: "telegram", start, send, receipt, stream, stop: () => { stopped = true; } };
}
