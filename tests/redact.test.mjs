import { test, expect } from "bun:test";
import { redactSecrets } from "../core/redact.mjs";

test("redacts sk- style api keys (openai/anthropic)", () => {
  const out = redactSecrets("key is sk-ant-api03-AbCdEfGh1234567890IjKlMnOpQrStUvWxYz ok");
  expect(out).not.toContain("AbCdEfGh");
  expect(out).toContain("[REDACTED");
});

test("redacts github tokens", () => {
  const out = redactSecrets("ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 和 github_pat_11ABCDEFG0_abcdefghijklmnopqrstuvwxyz");
  expect(out).not.toContain("ghp_AbCd");
  expect(out).not.toContain("github_pat_11");
});

test("redacts aws access key id", () => {
  expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).not.toContain("AKIAIOSFODNN7EXAMPLE");
});

test("redacts telegram bot tokens", () => {
  const out = redactSecrets("token: 1234567890:" + "AAF" + "FakeFakeFakeFakeFakeFakeFakeFake");
  expect(out).not.toContain("FakeFake");
});

test("redacts jwt", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  expect(redactSecrets(`Authorization 用 ${jwt} 这个`)).not.toContain("dozjgNryP4J3");
});

test("redacts private key blocks", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7\nx9yz\n-----END RSA PRIVATE KEY-----";
  const out = redactSecrets(`这是你的私钥：\n${pem}\n保存好`);
  expect(out).not.toContain("MIIEpAIBAAKCAQEA7");
  expect(out).toContain("[REDACTED");
});

test("redacts bearer tokens and slack tokens", () => {
  expect(redactSecrets("Bearer abcdefghijklmnopqrstuvwxyz123456")).not.toContain("abcdefghijklmnop");
  expect(redactSecrets("xox" + "b-123456789-abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
});

test("redacts key=value style secret assignments keeping the key name", () => {
  const out = redactSecrets('DB_PASSWORD=hunter2secret123 和 api_key: "abc123def456ghi"');
  expect(out).toContain("DB_PASSWORD");
  expect(out).not.toContain("hunter2secret123");
  expect(out).not.toContain("abc123def456ghi");
});

test("leaves normal text, urls, and commit hashes alone", () => {
  const text = [
    "commit d912c1b078e267abc 修复了 bug",
    "见 https://github.com/zzcan/zzcan-cli/blob/main/core/lib.mjs",
    "risk-taking 行为和 task-based 方案",
    "端口 8080，耗时 300s，密码学相关讨论",
  ].join("\n");
  expect(redactSecrets(text)).toBe(text);
});
