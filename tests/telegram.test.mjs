import { test, expect } from "bun:test";
// ---- telegram helpers ----
import { splitForTelegram, parseTelegramUpdate, nextStreamStep } from "../channels/telegram.logic.mjs";

test("splitForTelegram keeps short text as single chunk", () => {
  expect(splitForTelegram("hi", 4096)).toEqual(["hi"]);
});

test("splitForTelegram splits at newline boundary when possible", () => {
  const text = "aaa\nbbb\nccc";
  expect(splitForTelegram(text, 8)).toEqual(["aaa\nbbb", "ccc"]);
});

test("splitForTelegram hard-splits when no newline in window", () => {
  expect(splitForTelegram("a".repeat(10), 4)).toEqual(["aaaa", "aaaa", "aa"]);
});

const TG_CONFIG = { allowed_user_ids: [111] };
function tgUpdate({ from = 111, chatType = "private", text = "hi", msgId = 9, chatId = 111 } = {}) {
  return { update_id: 1, message: { message_id: msgId, from: { id: from }, chat: { id: chatId, type: chatType }, text } };
}

test("parseTelegramUpdate allows whitelisted private text message", () => {
  expect(parseTelegramUpdate(tgUpdate(), TG_CONFIG)).toEqual({
    action: "allow", senderId: 111, text: "hi", msgId: 9,
  });
});

test("parseTelegramUpdate skips non-whitelisted user", () => {
  expect(parseTelegramUpdate(tgUpdate({ from: 222 }), TG_CONFIG)).toEqual({ action: "skip", reason: "sender" });
});

test("parseTelegramUpdate skips group chats and non-text", () => {
  expect(parseTelegramUpdate(tgUpdate({ chatType: "group" }), TG_CONFIG)).toEqual({ action: "skip", reason: "group" });
  const noText = tgUpdate(); delete noText.message.text;
  expect(parseTelegramUpdate(noText, TG_CONFIG)).toEqual({ action: "skip", reason: "nontext" });
});

test("parseTelegramUpdate skips updates without message", () => {
  expect(parseTelegramUpdate({ update_id: 2 }, TG_CONFIG)).toEqual({ action: "skip", reason: "type" });
});

test("nextStreamStep noop when text unchanged", () => {
  expect(nextStreamStep("abc", "abc", 4096)).toEqual({ type: "noop" });
});

test("nextStreamStep edits when text grew within limit", () => {
  expect(nextStreamStep("ab", "abcd", 4096)).toEqual({ type: "edit", text: "abcd" });
});

test("nextStreamStep rolls over when text exceeds limit", () => {
  const full = "aaa\nbbb\nccc";
  expect(nextStreamStep("aaa", full, 8)).toEqual({ type: "rollover", finalize: "aaa\nbbb", carry: "ccc" });
});
