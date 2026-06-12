#!/usr/bin/env bun
// core/daemon.mjs — zzcan-cli 编排器（通道无关）。
// 通道适配器（channels/*.mjs）收消息 → 过滤在适配器内 → 这里排队/注入 tmux →
// Stop hook 写 outbox → 读 transcript 增量 → 回复路由回来源通道；支持通道级流式。
//
// 环境变量（测试用）：
//   BRIDGE_STATE_DIR     状态目录（默认 ~/.zzcan-cli）
//   BRIDGE_DRY_RUN=1     通道出站调用不真发（落 dry-run/ 文件）
//   BRIDGE_LISTENER_CMD  feishu 适配器事件源覆盖（见 channels/feishu.mjs）
//   BRIDGE_TG_API_BASE   telegram API 根覆盖（见 channels/telegram.mjs）
//   BRIDGE_TMUX_TARGET   注入目标 pane（默认 zzcan-cli:claude）
//   BRIDGE_PASTE_MODE    bracketed(默认)|plain —— e2e 假 claude 用 plain

import {
  readFileSync, existsSync, appendFileSync, statSync, openSync, readSync, closeSync,
  mkdirSync, writeFileSync, readdirSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  parseTranscriptDelta, parseLastTurnDelta, matchCommand, truncateReply,
  createQueueState, queueEvent,
} from "./lib.mjs";
import { createStreamSlot } from "./stream.mjs";
import { redactSecrets } from "./redact.mjs";
import { createFeishuChannel } from "../channels/feishu.mjs";
import { createTelegramChannel } from "../channels/telegram.mjs";

const STATE_DIR = process.env.BRIDGE_STATE_DIR || join(homedir(), ".zzcan-cli");
const DRY_RUN = process.env.BRIDGE_DRY_RUN === "1";
// 按窗口名定位（用户 tmux 配了 base-index 1，索引不可靠）
const TMUX_TARGET = process.env.BRIDGE_TMUX_TARGET || "zzcan-cli:claude";
const PASTE_MODE = process.env.BRIDGE_PASTE_MODE || "bracketed";
const OUTBOX = join(STATE_DIR, "outbox.ndjson");
const LOG_FILE = join(STATE_DIR, "bridge.log");
const STREAM_INTERVAL_MS = 2000;

mkdirSync(STATE_DIR, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  appendFileSync(LOG_FILE, line + "\n");
  console.error(line);
}

// ---- config（自动迁移飞书单通道时代的旧结构）----
const CONFIG_PATH = join(STATE_DIR, "config.json");
function loadConfig() {
  const path = CONFIG_PATH;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (raw.channels) return raw;
  const migrated = {
    workdir: raw.workdir,
    turn_timeout_seconds: raw.turn_timeout_seconds ?? 300,
    max_reply_chars: raw.max_reply_chars ?? 20000,
    channels: {
      feishu: { enabled: true, allowed_senders: raw.allowed_senders ?? [], receipt_emoji: raw.receipt_emoji || "OnIt" },
      telegram: { enabled: false, bot_token: "", allowed_user_ids: [], proxy: "" },
    },
  };
  writeFileSync(path, JSON.stringify(migrated, null, 2));
  log("config migrated to multi-channel structure");
  return migrated;
}
const config = loadConfig();
const TIMEOUT_MS = (config.turn_timeout_seconds ?? 300) * 1000;
const MAX_REPLY_CHARS = config.max_reply_chars ?? 20000;
let WORKDIR = (config.workdir || "~").replace(/^~/, homedir()); // /cd 会更新并持久化

// ---- IO 链 ----
// core 链：tmux 注入 / transcript 读取等轮次生命周期，必须全局串行。
// 每通道一条出站链：一个通道的发送重试（最长 65s）不拖累另一个通道。
const chains = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function enqueue(key, fn) {
  const next = (chains.get(key) || Promise.resolve()).then(fn).catch((e) => log(`IO error [${key}]: ${e?.stack || e}`));
  chains.set(key, next);
}
const enqueueIO = (fn) => enqueue("core", fn);
const enqueueCh = (channel, fn) => enqueue(`ch:${channel}`, fn);

// ---- 通道注册 ----
const adapters = {};
const onListenerDown = (name) =>
  notifyOwner(`⚠️ ${name} 监听连续掉线重试中，可能漏消息，检查 bridge.log`);
if (config.channels.feishu?.enabled) {
  adapters.feishu = createFeishuChannel({ config: config.channels.feishu, stateDir: STATE_DIR, log, onListenerDown });
}
if (config.channels.telegram?.enabled) {
  if (config.channels.telegram.bot_token) {
    adapters.telegram = createTelegramChannel({ config: config.channels.telegram, stateDir: STATE_DIR, log, onListenerDown });
  } else {
    log("telegram enabled but bot_token empty — channel not started");
  }
}
if (Object.keys(adapters).length === 0) {
  log("no channel enabled, exiting");
  process.exit(1);
}
// 对用户展示用的通道名（feishu → lark）
const channelLabels = (sep) => Object.values(adapters).map((a) => a.displayName || a.name).join(sep);

// ---- 出站（dry-run 时落文件不真发）----
function dryWrite(kind, to, text) {
  const dir = join(STATE_DIR, "dry-run");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${kind}-${to}.txt`);
  writeFileSync(f, text);
  log(`DRY_RUN ${kind} to=${to} len=${text.length} → ${f}`);
  return true;
}
async function chSend(channel, senderId, text) {
  if (DRY_RUN) return dryWrite("text", senderId, text);
  return adapters[channel].send(senderId, text);
}
function chReceipt(msg) {
  if (DRY_RUN) { log(`DRY_RUN receipt msg=${msg.msgId}`); return; }
  adapters[msg.channel].receipt(msg);
}
function notifyOwner(text) {
  // Cli 级通知发给每个通道的第一个白名单用户（各走自己的链）
  const f = config.channels.feishu;
  if (adapters.feishu && f.allowed_senders?.[0]) enqueueCh("feishu", () => chSend("feishu", f.allowed_senders[0], text));
  const t = config.channels.telegram;
  if (adapters.telegram && t.allowed_user_ids?.[0]) enqueueCh("telegram", () => chSend("telegram", t.allowed_user_ids[0], text));
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
function tmuxPaste(text) {
  let r = spawnSync("tmux", ["load-buffer", "-b", "fbridge", "-"], { input: text });
  if (r.status !== 0) throw new Error("tmux load-buffer failed");
  const pasteArgs = ["paste-buffer", "-d", "-b", "fbridge", "-t", TMUX_TARGET];
  if (PASTE_MODE === "bracketed") pasteArgs.splice(1, 0, "-p");
  r = spawnSync("tmux", pasteArgs);
  if (r.status !== 0) throw new Error("tmux paste-buffer failed");
}

// ---- transcript 定位与读取 ----
// 由 Stop hook 事件学习；/reset、/clear 后置空重学。BRIDGE_TRANSCRIPT_PATH 仅供 e2e 直接指定。
let transcriptPath = process.env.BRIDGE_TRANSCRIPT_PATH || null;
const turnOffsets = new Map(); // turnId → 注入时 transcript 字节偏移

function discoverTranscript() {
  // daemon 重启而 claude 还活着时，避免首轮 offset=0 把历史全文当回复
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
function readRange(path, from) {
  const size = statSync(path).size;
  if (size <= from) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
function readDelta(turnId, eventPath) {
  let from = turnOffsets.get(turnId) ?? 0;
  turnOffsets.delete(turnId);
  // session 变了（/clear、auto-compact 等）→ from=0 兜底，但只取最后一轮，
  // 防止把整段历史对话当回复发出去
  let lastTurnOnly = false;
  if (transcriptPath !== eventPath) {
    from = 0;
    lastTurnOnly = true;
  }
  transcriptPath = eventPath;
  const raw = readRange(eventPath, from);
  return lastTurnOnly ? parseLastTurnDelta(raw) : parseTranscriptDelta(raw);
}
// 流式 peek：不消费 offset、不改 transcriptPath
function peekDelta(turnId) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  const from = turnOffsets.get(turnId);
  if (from === undefined) return null;
  // 流式中间态也会发到 IM 服务器，同样要脱敏
  return redactSecrets(parseTranscriptDelta(readRange(transcriptPath, from)));
}

// ---- 流式驱动（adapter 提供 stream 才启用；竞态防护在 core/stream.mjs 的链式槽里）----
const streams = new Map(); // turnId → {slot, timer}
function startStream(turnId, msg) {
  const adapter = adapters[msg.channel];
  if (!adapter?.stream || DRY_RUN) return;
  const entry = { slot: createStreamSlot(adapter.stream, { log }), timer: null };
  streams.set(turnId, entry);
  enqueueCh(msg.channel, async () => {
    if (!streams.has(turnId)) return; // 已被 takeStream 取走（超时/重置）
    await entry.slot.start(msg.senderId);
    entry.timer = setInterval(() => entry.slot.tick(() => peekDelta(turnId)), STREAM_INTERVAL_MS);
  });
}
// 取走该轮的流式槽（停 tick 定时器）；finish 路径用 slot.finish 收尾，丢弃路径用 slot.cancel
function takeStream(turnId) {
  const entry = streams.get(turnId);
  if (!entry) return null;
  streams.delete(turnId);
  if (entry.timer) clearInterval(entry.timer);
  return entry.slot;
}

// ---- 队列编排 ----
let state = createQueueState();

async function deliverReply(turn, slot, reply, { late = false } = {}) {
  const prefix = late ? "🕐 迟到的回复：\n" : "";
  const text = truncateReply(redactSecrets(prefix + (reply || "")), MAX_REPLY_CHARS);
  if (slot && await slot.finish(text)) return; // 终稿已由流式消息承载
  if (reply) {
    await chSend(turn.msg.channel, turn.msg.senderId, text);
  } else {
    log(`turn=${turn.turnId}: empty reply, skip send`);
  }
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
          chReceipt(a.msg);
          log(`inject turn=${a.turnId} ch=${a.msg.channel} msg=${a.msg.msgId}`);
        });
        startStream(a.turnId, a.msg);
        break;
      case "finish":
      case "lateFinish": {
        const st = takeStream(a.turn.turnId);
        const late = a.type === "lateFinish";
        enqueueIO(() => {
          // transcript 读取留在 core 链（必须先于下一个 inject 更新 transcriptPath）；
          // 发送切到通道链，不阻塞后续注入
          const reply = readDelta(a.turn.turnId, a.path);
          log(`${a.type} turn=${a.turn.turnId} ch=${a.turn.msg.channel} len=${reply.length}`);
          enqueueCh(a.turn.msg.channel, () => deliverReply(a.turn, st, reply, { late }));
        });
        break;
      }
      case "notifyTimeout":
        takeStream(state.lastAbandoned?.turnId)?.cancel();
        enqueueCh(a.msg.channel, () => chSend(
          a.msg.channel, a.msg.senderId,
          "⚠️ 这条超过超时阈值还没回完，可能卡在等输入。发 /reset 重置，或电脑上 tmux attach -t zzcan-cli 看看。",
        ));
        break;
    }
  }
}

// ---- 入站 ----
function onMessage(msg) {
  if (msg.nontext) {
    enqueueCh(msg.channel, () => chSend(msg.channel, msg.senderId, "暂只支持文字消息"));
    return;
  }
  const cmd = matchCommand(msg.text);
  if (cmd) return handleCommand(cmd.cmd, msg, cmd.arg);
  if (!ensurePane(msg)) return;
  const { state: s2, actions } = queueEvent(state, { type: "message", msg, now: Date.now() });
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

function resetSessionState() {
  for (const turnId of [...streams.keys()]) takeStream(turnId)?.cancel();
  state = createQueueState();
  transcriptPath = null;
  turnOffsets.clear();
}

function handleCommand(cmd, msg, arg = null) {
  log(`command /${cmd}${arg ? " " + arg : ""} from ${msg.channel}:${msg.senderId}`);
  switch (cmd) {
    case "cd": {
      const spaces = config.workspaces || {};
      const list = Object.entries(spaces).map(([k, v]) => `${k} → ${v}`).join("\n") || "（未登记，编辑 config.json 的 workspaces）";
      if (!arg) {
        enqueueCh(msg.channel, () => chSend(msg.channel, msg.senderId, `📂 当前: ${WORKDIR}\n可切换:\n${list}`));
        break;
      }
      if (!spaces[arg]) {
        enqueueCh(msg.channel, () => chSend(msg.channel, msg.senderId, `❌ 未登记的工作区 ${arg}。可选:\n${list}`));
        break;
      }
      const dir = spaces[arg].replace(/^~/, homedir());
      if (!existsSync(dir)) {
        enqueueCh(msg.channel, () => chSend(msg.channel, msg.senderId, `❌ 目录不存在: ${dir}`));
        break;
      }
      enqueueIO(() => {
        tmux("respawn-window", "-k", "-c", dir, "-t", TMUX_TARGET);
        resetSessionState();
        WORKDIR = dir;
        config.workdir = spaces[arg];
        writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); // 重启 Cli 后仍在该工作区
        enqueueCh(msg.channel, () => chSend(msg.channel, msg.senderId, `✅ 已切到 ${arg} (${dir})，context 已清零`));
      });
      break;
    }
    case "reset":
      enqueueIO(() => {
        tmux("respawn-window", "-k", "-t", TMUX_TARGET);
        resetSessionState();
        enqueueCh(msg.channel, () => chSend(msg.channel, msg.senderId, "✅ 已重启 Claude，context 已清零"));
      });
      break;
    case "clear":
      enqueueIO(() => {
        tmux("send-keys", "-t", TMUX_TARGET, "/clear", "Enter");
        resetSessionState();
        enqueueCh(msg.channel, () => chSend(msg.channel, msg.senderId, "✅ context 已清空（进程未重启）"));
      });
      break;
    case "stop": {
      enqueueIO(() => tmux("send-keys", "-t", TMUX_TARGET, "Escape"));
      if (state.current) takeStream(state.current.turnId)?.cancel();
      const { state: s2, actions } = queueEvent(state, { type: "interrupt", now: Date.now() });
      state = s2;
      enqueueCh(msg.channel, () => chSend(msg.channel, msg.senderId, "⏹ 已中断当前轮"));
      dispatch(actions);
      break;
    }
    case "status": {
      const alive = paneAlive();
      const cur = state.current
        ? `处理中 turn=${state.current.turnId}（来自 ${state.current.msg.channel}），已 ${Math.round((Date.now() - state.current.injectedAt) / 1000)}s`
        : "空闲";
      enqueueCh(msg.channel, () => chSend(
        msg.channel, msg.senderId,
        `📊 Cli 状态\n通道: ${channelLabels(", ")}\n工作区: ${WORKDIR}\nclaude pane: ${alive ? "存活" : "❌ 不存在/已死"}\n当前轮: ${cur}\n排队: ${state.queue.length} 条`,
      ));
      break;
    }
  }
}

function ensurePane(msg) {
  if (paneAlive()) return true;
  try {
    tmux("respawn-window", "-k", "-t", TMUX_TARGET);
    resetSessionState();
    log("claude pane dead → respawned");
    enqueueCh(msg.channel, () => chSend(msg.channel, msg.senderId, "⚠️ Claude 进程曾退出，已自动重启（context 清零），请重发刚才那条"));
  } catch (e) {
    log(`respawn failed: ${e}`);
    enqueueCh(msg.channel, () => chSend(msg.channel, msg.senderId, "❌ Claude 进程不在且重启失败，请电脑上检查 tmux session zzcan-cli"));
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
  const chunk = readRange(OUTBOX, outboxOffset);
  outboxOffset = size;
  for (const line of chunk.split("\n")) {
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

// ---- 启动 ----
for (const [name, adapter] of Object.entries(adapters)) {
  adapter.start(onMessage);
  log(`channel started: ${name}`);
}
process.on("SIGTERM", () => { Object.values(adapters).forEach((a) => a.stop?.()); process.exit(0); });
process.on("SIGINT", () => { Object.values(adapters).forEach((a) => a.stop?.()); process.exit(0); });
if (!DRY_RUN) {
  enqueueIO(() => notifyOwner(`✅ Cli 已启动 (workdir: ${WORKDIR}, channels: ${channelLabels("+")})`));
}
log(`daemon started (channels: ${Object.keys(adapters).join(",")}${DRY_RUN ? ", DRY_RUN" : ""})`);
