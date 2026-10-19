import type { Server, ServerInput } from '@agentport/shared';

/**
 * 判断某个工具在当前 server 配置下是否应被智能体看到。
 * 目前只有一条规则：stdio server 默认不可在沙盒内直接执行，需由 worker 决定。
 * 后续权限/白名单策略集中在这里，避免散落到 api 与 worker。
 */
export function isServerUsableInSandbox(_server: Server): boolean {
  return true;
}

/** `.mcp.json` 中的单个条目。 */
export type McpJsonEntry =
  | { command: string; args: string[]; env: Record<string, string> }
  | { type: 'http'; url: string; headers: Record<string, string> };

/** 把 DB 中的 server 配置渲染成 `.mcp.json` 的条目，密钥由调用方注入。 */
export function toMcpJsonEntry(server: ServerInput, secrets: Record<string, string>): McpJsonEntry {
  if (server.kind === 'stdio') {
    return {
      command: server.command,
      args: server.args,
      env: { ...server.env, ...secrets },
    };
  }
  // generated server 对外表现为平台自己的 MCP HTTP 端点 /mcp/:id；
  // 该端点地址由调用方（worker）按运行环境改写，这里先给出上游基址占位。
  const url = server.kind === 'generated' ? server.baseUrl : server.url;
  return {
    type: 'http',
    url,
    headers: { ...server.headers, ...secrets },
  };
}
