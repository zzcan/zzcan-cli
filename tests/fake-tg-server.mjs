#!/usr/bin/env bun
// fake-tg-server.mjs — e2e 用的假 Telegram Bot API。
// 用法: bun fake-tg-server.mjs <port> <stateDir>
//   <stateDir>/tg-inbound.ndjson  测试脚本往里追加 update，getUpdates 按 offset 消费
//   <stateDir>/tg-calls.ndjson    服务器记录所有出站调用（method + payload），测试断言用
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const [port, stateDir] = [Number(process.argv[2]), process.argv[3]];
const INBOUND = join(stateDir, "tg-inbound.ndjson");
const CALLS = join(stateDir, "tg-calls.ndjson");
let nextMessageId = 1000;

function readInbound(offset) {
  if (!existsSync(INBOUND)) return [];
  return readFileSync(INBOUND, "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((u) => u.update_id >= offset);
}

Bun.serve({
  port,
  async fetch(req) {
    const method = new URL(req.url).pathname.split("/").pop();
    const payload = await req.json().catch(() => ({}));
    appendFileSync(CALLS, JSON.stringify({ method, payload }) + "\n");
    let result = true;
    if (method === "getUpdates") {
      // 简化长轮询：有货立刻给，没货等 300ms 再看一次
      let updates = readInbound(payload.offset ?? 0);
      if (updates.length === 0) {
        await new Promise((r) => setTimeout(r, 300));
        updates = readInbound(payload.offset ?? 0);
      }
      result = updates;
    } else if (method === "sendMessage") {
      result = { message_id: nextMessageId++, chat: { id: payload.chat_id } };
    } else if (method === "editMessageText") {
      result = { message_id: payload.message_id };
    }
    return Response.json({ ok: true, result });
  },
});
console.log(`fake tg server on :${port}`);
