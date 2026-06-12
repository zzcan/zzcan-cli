// channels/feishu.mjs — 飞书通道适配器。
// listen = spawn lark-cli event +subscribe（BRIDGE_LISTENER_CMD 可覆盖，e2e 用）
// send   = lark-cli im +messages-send（重试 5/15/45s）
// receipt= 消息表情回应（best-effort）
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createLineSplitter } from "../core/lib.mjs";
import { filterEvent } from "./feishu.logic.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 异步跑 lark-cli（spawnSync 会阻塞事件循环几百 ms，拖累其他通道的轮询/流式）
function runLarkCli(args) {
  return new Promise((resolve) => {
    const c = spawn("lark-cli", args, { stdio: "ignore" });
    c.on("exit", (code) => resolve(code === 0));
    c.on("error", () => resolve(false));
  });
}

export function createFeishuChannel({ config, stateDir, log, onListenerDown }) {
  const SEEN_FILE = join(stateDir, "feishu-seen-ids.txt");
  const seen = new Set(
    existsSync(SEEN_FILE) ? readFileSync(SEEN_FILE, "utf8").split("\n").filter(Boolean).slice(-1000) : [],
  );
  writeFileSync(SEEN_FILE, [...seen].join("\n") + (seen.size ? "\n" : ""));

  let child = null;

  function start(onMessage) {
    let failStreak = 0;
    const spawnListener = () => {
      child = process.env.BRIDGE_LISTENER_CMD
        ? spawn("bash", ["-c", process.env.BRIDGE_LISTENER_CMD], { stdio: ["ignore", "pipe", "pipe"] })
        : spawn("lark-cli", [
            "event", "+subscribe", "--as", "bot",
            "--event-types", "im.message.receive_v1", "--quiet",
          ], { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", createLineSplitter((line) => {
        failStreak = 0;
        const r = filterEvent(line, config, seen);
        if (r.action === "skip") {
          if (r.reason !== "type") log(`feishu skip ${r.reason}`);
          return;
        }
        appendFileSync(SEEN_FILE, r.msgId + "\n");
        if (r.action === "notify_nontext") {
          onMessage({ channel: "feishu", senderId: r.openId, text: null, msgId: r.msgId, nontext: true });
          return;
        }
        onMessage({ channel: "feishu", senderId: r.openId, text: r.text, msgId: r.msgId });
      }));
      child.stderr.on("data", (d) => log(`feishu listener: ${String(d).trim()}`));
      child.on("exit", (code) => {
        failStreak++;
        const delay = Math.min(60000, 1000 * 2 ** failStreak);
        log(`feishu listener exited code=${code}, restart in ${delay}ms (streak=${failStreak})`);
        if (failStreak === 3) onListenerDown?.("feishu");
        setTimeout(spawnListener, delay);
      });
    };
    spawnListener();
  }

  async function send(senderId, text) {
    const delays = [5000, 15000, 45000];
    const idempotency = `tmux-bridge-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    for (let i = 0; i < 3; i++) {
      const ok = await runLarkCli([
        "im", "+messages-send", "--as", "bot",
        "--user-id", senderId, "--text", text,
        "--idempotency-key", idempotency,
      ]);
      if (ok) return true;
      if (i < 2) await sleep(delays[i]);
    }
    log(`feishu send FAILED to=${senderId} len=${text.length}`);
    return false;
  }

  function receipt(msg) {
    const c = spawn("lark-cli", [
      "im", "reactions", "create", "--as", "bot",
      "--params", JSON.stringify({ message_id: msg.msgId }),
      "--data", JSON.stringify({ reaction_type: { emoji_type: config.receipt_emoji || "OnIt" } }),
    ], { stdio: "ignore" });
    c.on("exit", (code) => { if (code !== 0) log(`feishu receipt failed msg=${msg.msgId} code=${code}`); });
  }

  return { name: "feishu", displayName: "lark", start, send, receipt, stop: () => child?.kill() };
}
