import { createHash } from 'node:crypto';

/**
 * 工作区里唯一的密钥文件是 `.mcp.json`（generated server 的短期 token）。
 * 容器内以 uid 1000 读 bind mount，macOS Docker Desktop 会把宿主文件的 uid 映射成 1000，
 * 所以 0600 + 宿主用户 owner 在容器内仍可读（已实测）；Linux 宿主 uid 不是 1000 时会读不到。
 */
export const WORKSPACE_FILE_MODE = 0o600;
export const WORKSPACE_DIR_MODE = 0o700;

/** sha256(base64url)：DB 只存 hash，泄露的库不能直接拿来调 MCP。 */
export function hashMcpToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}
