import { test, expect } from "bun:test";
import { filterEvent } from "../core/lib.mjs";

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

// ---- parseTranscriptDelta ----
import { parseTranscriptDelta, matchCommand, truncateReply } from "../core/lib.mjs";

function asst(...blocks) {
  return JSON.stringify({ type: "assistant", message: { content: blocks } });
}

test("parseTranscriptDelta joins text blocks across assistant messages", () => {
  const jsonl = [
    asst({ type: "text", text: "第一段" }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] } }),
    asst({ type: "tool_use", name: "Bash", input: {} }, { type: "text", text: "第二段" }),
  ].join("\n");
  expect(parseTranscriptDelta(jsonl)).toBe("第一段\n\n第二段");
});

test("parseTranscriptDelta excludes thinking blocks", () => {
  const jsonl = asst({ type: "thinking", thinking: "内心戏" }, { type: "text", text: "回复" });
  expect(parseTranscriptDelta(jsonl)).toBe("回复");
});

test("parseTranscriptDelta tolerates partial trailing line and blank lines", () => {
  const jsonl = asst({ type: "text", text: "ok" }) + "\n\n" + '{"type":"assist';
  expect(parseTranscriptDelta(jsonl)).toBe("ok");
});

test("parseTranscriptDelta returns empty string when no assistant text", () => {
  expect(parseTranscriptDelta("")).toBe("");
});

// ---- matchCommand ----
test("matchCommand recognizes built-in commands with surrounding whitespace", () => {
  expect(matchCommand(" /reset ")).toBe("reset");
  expect(matchCommand("/clear")).toBe("clear");
  expect(matchCommand("/stop")).toBe("stop");
  expect(matchCommand("/status")).toBe("status");
});

test("matchCommand returns null for normal text and partial matches", () => {
  expect(matchCommand("帮我 /reset 一下")).toBe(null);
  expect(matchCommand("/resetall")).toBe(null);
  expect(matchCommand("你好")).toBe(null);
});

// ---- truncateReply ----
test("truncateReply keeps short text untouched", () => {
  expect(truncateReply("short", 100)).toBe("short");
});

test("truncateReply cuts long text and marks truncation", () => {
  const out = truncateReply("a".repeat(50), 10);
  expect(out).toBe("a".repeat(10) + "\n…（已截断）");
});

// ---- queue state machine ----
import { createQueueState, queueEvent } from "../core/lib.mjs";

const m1 = { openId: "ou_me", text: "一", msgId: "om_a" };
const m2 = { openId: "ou_me", text: "二", msgId: "om_b" };

test("message while idle injects immediately", () => {
  const { state, actions } = queueEvent(createQueueState(), { type: "message", msg: m1, now: 1000 });
  expect(actions).toEqual([{ type: "inject", msg: m1, turnId: 1 }]);
  expect(state.current.turnId).toBe(1);
});

test("message while busy is queued, not injected", () => {
  let s = queueEvent(createQueueState(), { type: "message", msg: m1, now: 1000 }).state;
  const { state, actions } = queueEvent(s, { type: "message", msg: m2, now: 1001 });
  expect(actions).toEqual([]);
  expect(state.queue).toEqual([m2]);
});

test("stop finishes current turn then injects next from queue", () => {
  let s = queueEvent(createQueueState(), { type: "message", msg: m1, now: 1000 }).state;
  s = queueEvent(s, { type: "message", msg: m2, now: 1001 }).state;
  const { state, actions } = queueEvent(s, { type: "stop", now: 1005 });
  expect(actions[0]).toEqual({ type: "finish", turn: { msg: m1, turnId: 1, injectedAt: 1000 } });
  expect(actions[1]).toEqual({ type: "inject", msg: m2, turnId: 2 });
  expect(state.current.turnId).toBe(2);
  expect(state.queue).toEqual([]);
});

test("stop while idle is ignored", () => {
  const { state, actions } = queueEvent(createQueueState(), { type: "stop", now: 1 });
  expect(actions).toEqual([]);
  expect(state.current).toBe(null);
});

test("tick past timeout abandons current, notifies, and injects next", () => {
  let s = queueEvent(createQueueState(), { type: "message", msg: m1, now: 1000 }).state;
  s = queueEvent(s, { type: "message", msg: m2, now: 1001 }).state;
  const { state, actions } = queueEvent(s, { type: "tick", now: 1000 + 301_000, timeoutMs: 300_000 });
  expect(actions[0]).toEqual({ type: "notifyTimeout", msg: m1 });
  expect(actions[1]).toEqual({ type: "inject", msg: m2, turnId: 2 });
  expect(state.lastAbandoned.turnId).toBe(1);
  expect(state.current.turnId).toBe(2);
});

test("tick before timeout does nothing", () => {
  const s = queueEvent(createQueueState(), { type: "message", msg: m1, now: 1000 }).state;
  const { state, actions } = queueEvent(s, { type: "tick", now: 2000, timeoutMs: 300_000 });
  expect(actions).toEqual([]);
  expect(state.current.turnId).toBe(1);
});

test("late stop after abandon matches abandoned turn (FIFO), current keeps waiting", () => {
  let s = queueEvent(createQueueState(), { type: "message", msg: m1, now: 1000 }).state;
  s = queueEvent(s, { type: "message", msg: m2, now: 1001 }).state;
  s = queueEvent(s, { type: "tick", now: 1000 + 301_000, timeoutMs: 300_000 }).state; // m1 abandoned, m2 injected
  const { state, actions } = queueEvent(s, { type: "stop", now: 1000 + 302_000 });
  expect(actions).toEqual([{ type: "lateFinish", turn: { msg: m1, turnId: 1, injectedAt: 1000 } }]);
  expect(state.lastAbandoned).toBe(null);
  expect(state.current.turnId).toBe(2); // m2 的 stop 还没来
});

test("reset clears queue, current and abandoned", () => {
  let s = queueEvent(createQueueState(), { type: "message", msg: m1, now: 1000 }).state;
  s = queueEvent(s, { type: "message", msg: m2, now: 1001 }).state;
  const { state, actions } = queueEvent(s, { type: "reset" });
  expect(actions).toEqual([]);
  expect(state).toEqual(createQueueState());
});

test("interrupt drops current and abandoned, then injects next from queue", () => {
  let s = queueEvent(createQueueState(), { type: "message", msg: m1, now: 1000 }).state;
  s = queueEvent(s, { type: "message", msg: m2, now: 1001 }).state;
  const { state, actions } = queueEvent(s, { type: "interrupt", now: 1002 });
  expect(actions).toEqual([{ type: "inject", msg: m2, turnId: 2 }]);
  expect(state.current.turnId).toBe(2);
  expect(state.lastAbandoned).toBe(null);
});

test("interrupt while idle does nothing", () => {
  const { state, actions } = queueEvent(createQueueState(), { type: "interrupt", now: 1 });
  expect(actions).toEqual([]);
  expect(state.current).toBe(null);
});

// ---- createLineSplitter ----
import { createLineSplitter } from "../core/lib.mjs";

test("line splitter assembles lines across chunk boundaries", () => {
  const got = [];
  const feed = createLineSplitter((l) => got.push(l));
  feed('{"a":1}\n{"b"');
  feed(':2}\n');
  feed('{"c":3}');
  feed("\n\n");
  expect(got).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("line splitter handles Buffer chunks and multi-line chunks", () => {
  const got = [];
  const feed = createLineSplitter((l) => got.push(l));
  feed(Buffer.from("一\n二\n三\n"));
  expect(got).toEqual(["一", "二", "三"]);
});

// ---- telegram helpers ----
import { splitForTelegram, parseTelegramUpdate, nextStreamStep } from "../core/lib.mjs";

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
