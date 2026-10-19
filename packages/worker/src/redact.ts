/**
 * 沙盒输出可能带出凭证：stderr、工具结果都会落日志/DB/页面。
 * 只遮盖常见凭证形态，保留前 4 位便于排查。
 */
function mask(secret: string): string {
  return secret.length > 4 ? `${secret.slice(0, 4)}***` : '***';
}

const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi;
const PROVIDER_KEY = /\b(?:sk-|ghp_)[A-Za-z0-9_-]{16,}/g;
const ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Za-z0-9_]*)=("[^"\n]*"|'[^'\n]*'|[^\s,;&]+)/gi;
const BASE64URL = /[A-Za-z0-9_-]{32,}/g;

/** UUID、全小写 hash 也会命中 base64url；要求大小写与数字同时出现才当密钥。 */
function looksRandom(token: string): boolean {
  return /[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token);
}

export function redactSecrets(text: string): string {
  return (
    text
      // Bearer 后只剩前 4 位，无法还原；先把整段替换掉，避免再被 base64url 规则二次处理。
      .replace(BEARER, (_match, prefix: string, token: string) => `${prefix}${mask(token)}`)
      .replace(PROVIDER_KEY, (match) => mask(match))
      .replace(ASSIGNMENT, (_match, key: string, value: string) => {
        const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
        const body = quote ? value.slice(1, -1) : value;
        return `${key}=${quote}${mask(body)}${quote}`;
      })
      .replace(BASE64URL, (match) => (looksRandom(match) ? mask(match) : match))
  );
}
