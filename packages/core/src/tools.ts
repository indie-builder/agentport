import type { ServerInput } from '@agentport/shared';

/** `.mcp.json` 中的单个条目。 */
export type McpJsonEntry =
  | { command: string; args: string[]; env: Record<string, string> }
  | {
      type: 'http';
      url: string;
      headers: Record<string, string>;
      /** 仅预览用：说明运行时注入的 Authorization，不写入真实工作区文件。 */
      _note?: string;
    };

/** 把 DB 中的 server 配置渲染成 `.mcp.json` 的条目，密钥由调用方注入。 */
export function toMcpJsonEntry(server: ServerInput, secrets: Record<string, string>): McpJsonEntry {
  // stdio 有意在非 root Docker 沙盒内执行；命令必须在镜像中可用，env 仅注入绑定的密钥。
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
