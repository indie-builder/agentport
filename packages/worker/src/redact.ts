/**
 * 沙盒输出可能带出凭证：stderr、工具结果都会落日志/DB/页面。
 * 只遮盖常见凭证形态，保留前 4 位便于排查。
 */
function mask(secret: string): string {
  return secret.length > 4 ? `${secret.slice(0, 4)}***` : '***';
}

// V8 用 {8,} 这类量词匹配数 MB 的连续串会栈溢出；有界 lookahead 只检查前 8 位，
// 再由 + 贪婪取整段，既保住长度阈值，也不会把整段留在回溯栈里。
// 不能把紧随方案的下一段词当 token 消费（`Bearer Bearer abcdefgh`）：先用 lookahead
// 确认至少 8 位，短匹配就不会跳过下一次方案词。
const BEARER = /(\bBearer\s+)(?=[A-Za-z0-9._~+/=-]{8})([A-Za-z0-9._~+/=-]+)/gi;
const PROVIDER_KEY = /\b(?:sk-|ghp_)[A-Za-z0-9_-]+/g;
const ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Za-z0-9_]*)=("[^"\n]*"|'[^'\n]*'|[^\s,;&]+)/gi;
const BASE64URL = /[A-Za-z0-9_-]+/g;

/** UUID、全小写 hash 也会命中 base64url；要求大小写与数字同时出现才当密钥。 */
function looksRandom(token: string): boolean {
  return /[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token);
}

export function redactSecrets(text: string): string {
  return (
    text
      // Bearer 后只剩前 4 位，无法还原；先把整段替换掉，避免再被 base64url 规则二次处理。
      .replace(BEARER, (_match, prefix: string, token: string) => `${prefix}${mask(token)}`)
      .replace(PROVIDER_KEY, (match) => {
        // sk- / ghp_ 之后至少 16 位才算 provider key。
        const prefixLength = match.startsWith('sk-') ? 3 : 4;
        return match.length - prefixLength >= 16 ? mask(match) : match;
      })
      .replace(ASSIGNMENT, (_match, key: string, value: string) => {
        const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
        const body = quote ? value.slice(1, -1) : value;
        return `${key}=${quote}${mask(body)}${quote}`;
      })
      .replace(BASE64URL, (match) =>
        match.length >= 32 && looksRandom(match) ? mask(match) : match,
      )
  );
}
