// core/redact.mjs — 出站脱敏：回复发往 IM 服务器前抹掉常见密钥格式。
// 原则：宁可漏（pattern 不全）不可误（普通文本被改写）——所以全部用强特征 pattern，
// 不做“看起来像随机串就抹”的激进启发式。

const RULES = [
  // 私钥块（多行）
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:private-key]"],
  // OpenAI / Anthropic 等 sk- 系
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED:api-key]"],
  // GitHub: ghp_/gho_/ghu_/ghs_/ghr_ 与 fine-grained PAT
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, "[REDACTED:github-token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED:github-token]"],
  // AWS Access Key ID
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:aws-key]"],
  // Slack
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED:slack-token]"],
  // Telegram bot token
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, "[REDACTED:telegram-token]"],
  // JWT（三段 base64url，首段以 eyJ 开头）
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED:jwt]"],
  // Bearer <token>
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g, "Bearer [REDACTED]"],
  // key=value / key: value 赋值（保留键名，抹值）：标识符以 key/secret/token/password 结尾、
  // 值 ≥8 字符才动手，避免误伤普通示例文本
  [/\b([A-Za-z0-9_-]*(?:key|secret|token|password|passwd))(\s*[=:]\s*)(["']?)[^\s"']{8,}\3/gi,
   "$1$2$3[REDACTED]$3"],
];

export function redactSecrets(text) {
  let out = text;
  for (const [re, replacement] of RULES) {
    out = out.replace(re, replacement);
  }
  return out;
}
