#!/usr/bin/env bun
// daemon.mjs — feishu-tmux-bridge 核心常驻进程。
// 收（lark-cli event 订阅）→ 滤（lib.filterEvent）→ 注（tmux paste）→ 回（Stop hook outbox → transcript 增量 → lark-cli 发回）。
// 纯逻辑在 lib.mjs（有单测），这里只做 IO 编排。
//
// 环境变量（测试/dry-run 用）：
//   BRIDGE_STATE_DIR     状态目录（默认 ~/.claude-feishu-tmux-bridge）
//   BRIDGE_DRY_RUN=1     不真发飞书（回复落 dry-run/ 文件）
//   BRIDGE_LISTENER_CMD  覆盖事件源命令（测试用 `tail -F 假事件文件` 代替 lark-cli 订阅）
//   BRIDGE_TMUX_TARGET   注入目标 pane（默认 feishu-bridge:claude）
//   BRIDGE_PASTE_MODE    bracketed(默认)|plain —— e2e 假 claude 用 plain（裸 read 不识别 bracketed paste 序列）

import {
  readFileSync, existsSync, appendFileSync, statSync, openSync, readSync, closeSync,
  mkdirSync, writeFileSync, readdirSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  filterEvent, parseTranscriptDelta, matchCommand, truncateReply,
  createQueueState, queueEvent, createLineSplitter,
} from "./lib.mjs";

const STATE_DIR = process.env.BRIDGE_STATE_DIR || join(homedir(), ".claude-feishu-tmux-bridge");
const DRY_RUN = process.env.BRIDGE_DRY_RUN === "1";
// 按窗口名定位（用户 tmux 配了 base-index 1，索引不可靠）
const TMUX_TARGET = process.env.BRIDGE_TMUX_TARGET || "feishu-bridge:claude";
const PASTE_MODE = process.env.BRIDGE_PASTE_MODE || "bracketed";
const OUTBOX = join(STATE_DIR, "outbox.ndjson");
const SEEN_FILE = join(STATE_DIR, "seen-message-ids.txt");
const LOG_FILE = join(STATE_DIR, "bridge.log");

mkdirSync(STATE_DIR, { recursive: true });
const config = JSON.parse(readFileSync(join(STATE_DIR, "config.json"), "utf8"));
const TIMEOUT_MS = (config.turn_timeout_seconds ?? 300) * 1000;
const MAX_REPLY_CHARS = config.max_reply_chars ?? 20000;
const WORKDIR = (config.workdir || "~").replace(/^~/, homedir());

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  appendFileSync(LOG_FILE, line + "\n");
  console.error(line);
}

// ---- seen ids（去重持久化，启动时裁到最近 1000）----
const seen = new Set(
  existsSync(SEEN_FILE) ? readFileSync(SEEN_FILE, "utf8").split("\n").filter(Boolean).slice(-1000) : [],
);
writeFileSync(SEEN_FILE, [...seen].join("\n") + (seen.size ? "\n" : ""));
function rememberSeen(id) {
  appendFileSync(SEEN_FILE, id + "\n");
}

// ---- 飞书发送（重试 5/15/45s；DRY_RUN 落文件）----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sendText(openId, text) {
  if (DRY_RUN) {
    const dir = join(STATE_DIR, "dry-run");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-text-${openId}.txt`);
    writeFileSync(f, text);
    log(`DRY_RUN sendText to=${openId} len=${text.length} → ${f}`);
    return true;
  }
  const delays = [5000, 15000, 45000];
  const idempotency = `tmux-bridge-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  for (let i = 0; i < 3; i++) {
    const r = spawnSync("lark-cli", [
      "im", "+messages-send", "--as", "bot",
      "--user-id", openId, "--text", text,
      "--idempotency-key", idempotency,
    ], { stdio: "ignore" });
    if (r.status === 0) return true;
    if (i < 2) await sleep(delays[i]);
  }
  log(`sendText FAILED to=${openId} len=${text.length}`);
  return false;
}

function react(msgId) {
  // 即时回执（best-effort，失败只记日志不阻塞）
  if (DRY_RUN) {
    log(`DRY_RUN react msg=${msgId}`);
    return;
  }
  const child = spawn("lark-cli", [
    "im", "reactions", "create", "--as", "bot",
    "--params", JSON.stringify({ message_id: msgId }),
    "--data", JSON.stringify({ reaction_type: { emoji_type: config.receipt_emoji || "OnIt" } }),
  ], { stdio: "ignore" });
  child.on("exit", (code) => { if (code !== 0) log(`react failed msg=${msgId} code=${code}`); });
}

// ---- tmux ----
function tmux(...args) {
  const r = spawnSync("tmux", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tmux ${args[0]} failed: ${r.stderr?.trim()}`);
  return r.stdout;
}
function paneAlive() {
  try {
    return tmux("display", "-p", "-t", TMUX_TARGET, "#{pane_dead}").trim() === "0";
  } catch {
    return false;
  }
}

// ---- transcript 定位与增量读取 ----
let transcriptPath = null; // 由 Stop hook 事件学习；/reset、/clear 后置空重学
const turnOffsets = new Map(); // turnId → 注入时 transcript 字节偏移

function discoverTranscript() {
  // daemon 重启而 claude 还活着时，避免首轮 offset=0 把历史全文当回复。
  const slug = WORKDIR.replace(/[/.]/g, "-");
  const dir = join(homedir(), ".claude", "projects", slug);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f: join(dir, f), m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files[0]?.f ?? null;
}

function currentOffset() {
  const p = transcriptPath ?? discoverTranscript();
  if (p && existsSync(p)) {
    if (!transcriptPath) transcriptPath = p;
    return statSync(p).size;
  }
  return 0;
}

function readDelta(turnId, eventPath) {
  let from = turnOffsets.get(turnId) ?? 0;
  turnOffsets.delete(turnId);
  if (transcriptPath !== eventPath) from = 0; // session 变了（/clear 等），整文件兜底
  transcriptPath = eventPath;
  const size = statSync(eventPath).size;
  if (size <= from) return "";
  const fd = openSync(eventPath, "r");
  try {
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    return parseTranscriptDelta(buf.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

// ---- 队列编排（所有 IO 经 ioChain 串行，保证回贴顺序）----
let state = createQueueState();
let ioChain = Promise.resolve();
function enqueueIO(fn) {
  ioChain = ioChain.then(fn).catch((e) => log(`IO error: ${e?.stack || e}`));
}

// load-buffer 需要 stdin，spawnSync 单独处理
function tmuxPaste(text) {
  let r = spawnSync("tmux", ["load-buffer", "-b", "fbridge", "-"], { input: text });
  if (r.status !== 0) throw new Error("tmux load-buffer failed");
  const pasteArgs = ["paste-buffer", "-d", "-b", "fbridge", "-t", TMUX_TARGET];
  if (PASTE_MODE === "bracketed") pasteArgs.splice(1, 0, "-p");
  r = spawnSync("tmux", pasteArgs);
  if (r.status !== 0) throw new Error("tmux paste-buffer failed");
}

function dispatch(actions) {
  for (const a of actions) {
    switch (a.type) {
      case "inject":
        enqueueIO(async () => {
          turnOffsets.set(a.turnId, currentOffset());
          tmuxPaste(a.msg.text);
          await sleep(150); // 让输入框消化 paste 再回车
          tmux("send-keys", "-t", TMUX_TARGET, "Enter");
          react(a.msg.msgId);
          log(`inject turn=${a.turnId} msg=${a.msg.msgId}`);
        });
        break;
      case "finish":
      case "lateFinish":
        enqueueIO(async () => {
          const reply = readDelta(a.turn.turnId, a.path);
          if (!reply) {
            log(`${a.type} turn=${a.turn.turnId}: empty reply, skip send`);
            return;
          }
          const prefix = a.type === "lateFinish" ? "🕐 迟到的回复：\n" : "";
          await sendText(a.turn.msg.openId, truncateReply(prefix + reply, MAX_REPLY_CHARS));
          log(`${a.type} turn=${a.turn.turnId} sent len=${reply.length}`);
        });
        break;
      case "notifyTimeout":
        enqueueIO(() => sendText(
          a.msg.openId,
          "⚠️ 这条超过超时阈值还没回完，可能卡在等输入。发 /reset 重置，或电脑上 tmux attach -t feishu-bridge 看看。",
        ));
        break;
    }
  }
}

// ---- 三个入口：消息事件 / Stop 事件 / 定时 tick ----
function onEventLine(line) {
  const r = filterEvent(line, config, seen);
  if (r.action === "skip") {
    if (r.reason !== "type") log(`skip ${r.reason}`);
    return;
  }
  rememberSeen(r.msgId);
  if (r.action === "notify_nontext") {
    enqueueIO(() => sendText(r.openId, "暂只支持文字消息"));
    return;
  }
  const cmd = matchCommand(r.text);
  if (cmd) return handleCommand(cmd, r);
  if (!ensurePane(r.openId)) return;
  const { state: s2, actions } = queueEvent(state, { type: "message", msg: r, now: Date.now() });
  state = s2;
  dispatch(actions);
}

function onStopEvent(ev) {
  if (!ev?.transcript_path || !existsSync(ev.transcript_path)) {
    log(`stop event missing transcript_path: ${JSON.stringify(ev)}`);
    return;
  }
  const { state: s2, actions } = queueEvent(state, { type: "stop", now: Date.now() });
  state = s2;
  // transcript 路径绑在 action 上，避免 IO 链异步执行时被后续 Stop 事件覆盖
  dispatch(actions.map((a) =>
    a.type === "finish" || a.type === "lateFinish" ? { ...a, path: ev.transcript_path } : a,
  ));
}

function handleCommand(cmd, msg) {
  log(`command /${cmd} from ${msg.openId}`);
  switch (cmd) {
    case "reset":
      enqueueIO(async () => {
        tmux("respawn-window", "-k", "-t", TMUX_TARGET);
        state = createQueueState();
        transcriptPath = null;
        turnOffsets.clear();
        await sendText(msg.openId, "✅ 已重启 Claude，context 已清零");
      });
      break;
    case "clear":
      enqueueIO(async () => {
        tmux("send-keys", "-t", TMUX_TARGET, "/clear", "Enter");
        state = createQueueState();
        transcriptPath = null;
        turnOffsets.clear();
        await sendText(msg.openId, "✅ context 已清空（进程未重启）");
      });
      break;
    case "stop": {
      enqueueIO(() => tmux("send-keys", "-t", TMUX_TARGET, "Escape"));
      const { state: s2, actions } = queueEvent(state, { type: "interrupt", now: Date.now() });
      state = s2;
      enqueueIO(() => sendText(msg.openId, "⏹ 已中断当前轮"));
      dispatch(actions);
      break;
    }
    case "status": {
      const alive = paneAlive();
      const cur = state.current
        ? `处理中 turn=${state.current.turnId}，已 ${Math.round((Date.now() - state.current.injectedAt) / 1000)}s`
        : "空闲";
      enqueueIO(() => sendText(
        msg.openId,
        `📊 bridge 状态\nclaude pane: ${alive ? "存活" : "❌ 不存在/已死"}\n当前轮: ${cur}\n排队: ${state.queue.length} 条`,
      ));
      break;
    }
  }
}

function ensurePane(notifyOpenId) {
  if (paneAlive()) return true;
  try {
    tmux("respawn-window", "-k", "-t", TMUX_TARGET);
    state = createQueueState();
    transcriptPath = null;
    turnOffsets.clear();
    log("claude pane dead → respawned");
    enqueueIO(() => sendText(notifyOpenId, "⚠️ Claude 进程曾退出，已自动重启（context 清零），请重发刚才那条"));
  } catch (e) {
    log(`respawn failed: ${e}`);
    enqueueIO(() => sendText(notifyOpenId, "❌ Claude 进程不在且重启失败，请电脑上检查 tmux session feishu-bridge"));
  }
  return false;
}

// ---- outbox 轮询（Stop hook 追加）----
let outboxOffset = existsSync(OUTBOX) ? statSync(OUTBOX).size : 0; // 跳过历史
setInterval(() => {
  if (!existsSync(OUTBOX)) return;
  const size = statSync(OUTBOX).size;
  if (size <= outboxOffset) {
    if (size < outboxOffset) outboxOffset = size; // 文件被轮转/清空
    return;
  }
  const fd = openSync(OUTBOX, "r");
  const buf = Buffer.alloc(size - outboxOffset);
  readSync(fd, buf, 0, buf.length, outboxOffset);
  closeSync(fd);
  outboxOffset = size;
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      onStopEvent(JSON.parse(line));
    } catch (e) {
      log(`bad outbox line: ${e}`);
    }
  }
}, 500);

// ---- 超时 tick ----
setInterval(() => {
  const { state: s2, actions } = queueEvent(state, { type: "tick", now: Date.now(), timeoutMs: TIMEOUT_MS });
  state = s2;
  dispatch(actions);
}, 5000);

// ---- 事件监听：子进程 stdout 读 NDJSON，自动重拉。
// 生产 = lark-cli 订阅；测试用 BRIDGE_LISTENER_CMD 换成 `tail -F 假事件文件`，代码路径完全一致。
function startListener() {
  let failStreak = 0;
  const spawnListener = () => {
    const child = process.env.BRIDGE_LISTENER_CMD
      ? spawn("bash", ["-c", process.env.BRIDGE_LISTENER_CMD], { stdio: ["ignore", "pipe", "pipe"] })
      : spawn("lark-cli", [
          "event", "+subscribe", "--as", "bot",
          "--event-types", "im.message.receive_v1", "--quiet",
        ], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", createLineSplitter((l) => { failStreak = 0; onEventLine(l); }));
    child.stderr.on("data", (d) => appendFileSync(LOG_FILE, d));
    child.on("exit", (code) => {
      failStreak++;
      const delay = Math.min(60000, 1000 * 2 ** failStreak);
      log(`listener exited code=${code}, restart in ${delay}ms (streak=${failStreak})`);
      if (failStreak === 3 && config.allowed_senders?.[0]) {
        enqueueIO(() => sendText(config.allowed_senders[0], "⚠️ 飞书事件监听连续掉线重试中，可能漏消息，检查 bridge.log"));
      }
      setTimeout(spawnListener, delay);
    });
    listenerChild = child;
  };
  spawnListener();
  log(`daemon started (listener: ${process.env.BRIDGE_LISTENER_CMD || "lark-cli"}${DRY_RUN ? ", DRY_RUN" : ""})`);
}
let listenerChild = null;
process.on("SIGTERM", () => { listenerChild?.kill(); process.exit(0); });
process.on("SIGINT", () => { listenerChild?.kill(); process.exit(0); });

startListener();
if (!DRY_RUN && config.allowed_senders?.[0]) {
  enqueueIO(() => sendText(config.allowed_senders[0], `✅ 桥已启动 (workdir: ${WORKDIR})`));
}
