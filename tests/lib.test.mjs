import { test, expect } from "bun:test";
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
  expect(matchCommand(" /reset ")).toEqual({ cmd: "reset", arg: null });
  expect(matchCommand("/clear")).toEqual({ cmd: "clear", arg: null });
  expect(matchCommand("/stop")).toEqual({ cmd: "stop", arg: null });
  expect(matchCommand("/status")).toEqual({ cmd: "status", arg: null });
});

test("matchCommand parses /cd with and without workspace name", () => {
  expect(matchCommand("/cd beukay")).toEqual({ cmd: "cd", arg: "beukay" });
  expect(matchCommand(" /cd  codes ")).toEqual({ cmd: "cd", arg: "codes" });
  expect(matchCommand("/cd")).toEqual({ cmd: "cd", arg: null });
});

test("matchCommand returns null for normal text and partial matches", () => {
  expect(matchCommand("帮我 /reset 一下")).toBe(null);
  expect(matchCommand("/resetall")).toBe(null);
  expect(matchCommand("/reset now")).toBe(null);
  expect(matchCommand("/cdrom")).toBe(null);
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

// ---- parseLastTurnDelta（from=0 兜底只取最后一轮，防把历史全文当回复）----
import { parseLastTurnDelta } from "../core/lib.mjs";

function human(text) {
  return JSON.stringify({ type: "user", message: { content: text } });
}
function toolResult() {
  return JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] } });
}

test("parseLastTurnDelta only returns assistant text after the last human message", () => {
  const jsonl = [
    human("第一问"),
    asst({ type: "text", text: "旧回答" }),
    human("第二问"),
    asst({ type: "text", text: "新回答" }),
  ].join("\n");
  expect(parseLastTurnDelta(jsonl)).toBe("新回答");
});

test("parseLastTurnDelta does not cut at tool_result entries within the turn", () => {
  const jsonl = [
    human("旧问题"),
    asst({ type: "text", text: "旧回答" }),
    human("新问题"),
    asst({ type: "text", text: "先说一句" }, { type: "tool_use", name: "Bash", input: {} }),
    toolResult(),
    asst({ type: "text", text: "再说结论" }),
  ].join("\n");
  expect(parseLastTurnDelta(jsonl)).toBe("先说一句\n\n再说结论");
});

test("parseLastTurnDelta falls back to all assistant text when no human entry", () => {
  const jsonl = asst({ type: "text", text: "唯一回复" });
  expect(parseLastTurnDelta(jsonl)).toBe("唯一回复");
});
