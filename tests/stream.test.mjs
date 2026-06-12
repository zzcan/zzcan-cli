import { test, expect } from "bun:test";
import { createStreamSlot } from "../core/stream.mjs";

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeAdapter(calls, { updateDelayMs = 0 } = {}) {
  return {
    begin: async (to) => { calls.push(`begin:${to}`); return { id: 1 }; },
    update: async (h, text) => {
      if (updateDelayMs) await new Promise((r) => setTimeout(r, updateDelayMs));
      calls.push(`update:${text}`);
    },
    end: async (h, text) => { calls.push(`end:${text}`); },
  };
}

test("finish waits for in-flight update — final edit is always last", async () => {
  const calls = [];
  const slot = createStreamSlot(makeAdapter(calls, { updateDelayMs: 30 }), { log: () => {} });
  await slot.start("u1");
  slot.tick(() => "中间态");        // update 进入 in-flight（30ms 才完成）
  const done = slot.finish("终稿"); // 立即请求终稿
  await done;
  expect(calls).toEqual(["begin:u1", "update:中间态", "end:终稿"]); // end 必须在 update 之后
});

test("tick while an update is in flight is skipped", async () => {
  const calls = [];
  const slot = createStreamSlot(makeAdapter(calls, { updateDelayMs: 20 }), { log: () => {} });
  await slot.start("u1");
  slot.tick(() => "v1");
  slot.tick(() => "v2"); // v1 还在飞，应被跳过
  await slot.finish("final");
  expect(calls).toEqual(["begin:u1", "update:v1", "end:final"]);
});

test("tick after finish does nothing", async () => {
  const calls = [];
  const slot = createStreamSlot(makeAdapter(calls), { log: () => {} });
  await slot.start("u1");
  await slot.finish("final");
  slot.tick(() => "迟到");
  await tick();
  expect(calls).toEqual(["begin:u1", "end:final"]);
});

test("finish returns false when begin failed — caller falls back to plain send", async () => {
  const calls = [];
  const adapter = makeAdapter(calls);
  adapter.begin = async () => { throw new Error("boom"); };
  const slot = createStreamSlot(adapter, { log: () => {} });
  await slot.start("u1");
  expect(await slot.finish("final")).toBe(false);
  expect(calls).toEqual([]); // 没有 end
});

test("finish returns true on success; cancel stops everything silently", async () => {
  const calls = [];
  const slot = createStreamSlot(makeAdapter(calls), { log: () => {} });
  await slot.start("u1");
  expect(await slot.finish("final")).toBe(true);
  const calls2 = [];
  const slot2 = createStreamSlot(makeAdapter(calls2), { log: () => {} });
  await slot2.start("u2");
  slot2.cancel();
  slot2.tick(() => "x");
  await tick();
  expect(calls2).toEqual(["begin:u2"]);
});

test("tick with empty text does not call update", async () => {
  const calls = [];
  const slot = createStreamSlot(makeAdapter(calls), { log: () => {} });
  await slot.start("u1");
  slot.tick(() => null);
  slot.tick(() => "");
  await tick();
  expect(calls).toEqual(["begin:u1"]);
});
