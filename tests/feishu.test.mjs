import { test, expect } from "bun:test";
import { filterEvent } from "../channels/feishu.logic.mjs";

const CONFIG = { allowed_senders: ["ou_me"] };

function textEvent({ sender = "ou_me", chatType = "p2p", msgType = "text", msgId = "om_1", text = "hello" } = {}) {
  return JSON.stringify({
    header: { event_type: "im.message.receive_v1" },
    event: {
      sender: { sender_id: { open_id: sender } },
      message: {
        chat_type: chatType,
        message_type: msgType,
        message_id: msgId,
        content: JSON.stringify({ text }),
      },
    },
  });
}

test("filterEvent allows whitelisted p2p text message", () => {
  const seen = new Set();
  const r = filterEvent(textEvent(), CONFIG, seen);
  expect(r).toEqual({ action: "allow", openId: "ou_me", text: "hello", msgId: "om_1" });
  expect(seen.has("om_1")).toBe(true);
});

test("filterEvent skips malformed JSON", () => {
  expect(filterEvent("not json{", CONFIG, new Set())).toEqual({ action: "skip", reason: "malformed" });
});

test("filterEvent skips non-whitelisted sender", () => {
  const r = filterEvent(textEvent({ sender: "ou_stranger" }), CONFIG, new Set());
  expect(r).toEqual({ action: "skip", reason: "sender" });
});

test("filterEvent skips group chat", () => {
  const r = filterEvent(textEvent({ chatType: "group" }), CONFIG, new Set());
  expect(r).toEqual({ action: "skip", reason: "group" });
});

test("filterEvent asks daemon to notify on non-text message from allowed sender", () => {
  const r = filterEvent(textEvent({ msgType: "image" }), CONFIG, new Set());
  expect(r).toEqual({ action: "notify_nontext", openId: "ou_me", msgId: "om_1" });
});

test("filterEvent dedupes already-seen message ids", () => {
  const seen = new Set(["om_1"]);
  expect(filterEvent(textEvent(), CONFIG, seen)).toEqual({ action: "skip", reason: "dup" });
});

test("filterEvent skips unrelated event types", () => {
  const line = JSON.stringify({ header: { event_type: "card.action.trigger" }, event: {} });
  expect(filterEvent(line, CONFIG, new Set())).toEqual({ action: "skip", reason: "type" });
});
