import type { ApiTool } from '@agentport/shared';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { assertSafeUrl } from './ssrf.js';

export interface GeneratedServerInput {
  name: string;
  baseUrl: string;
  headers: Record<string, string>;
  tools: ApiTool[];
  /** 当前 run 已批准的工具名；没有 run 上下文时为空，审批工具一律拒绝。 */
  approvals: string[];
}

/** 未批准时的固定文案：前端靠这段文本识别审批请求。 */
export function approvalRequiredMessage(toolName: string): string {
  return `需要批准：${toolName}。请在运行详情页批准后重试。`;
}

/** 路径模板里的 {param} 已用掉后，剩余参数才进 query/body。 */
function fillPath(
  template: string,
  args: Record<string, unknown>,
): { path: string; rest: Record<string, unknown> } {
  const rest: Record<string, unknown> = { ...args };
  const path = template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = rest[key];
    delete rest[key];
    return encodeURIComponent(value === undefined ? '' : String(value));
  });
  return { path, rest };
}

/**
 * fetch 前再次校验目标地址：工具定义保存时能过检查，不代表运行时 DNS 没被改。
 * 这里不吞错误，让它冒泡成 CallToolResult 的错误内容。
 */
async function callUpstream(
  tool: ApiTool,
  baseUrl: string,
  headers: Record<string, string>,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const { path, rest } = fillPath(tool.pathTemplate, args);
  const url = new URL(baseUrl.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`));
  await assertSafeUrl(url.toString());

  const init: RequestInit = { method: tool.method, headers: { ...headers } };
  if (tool.paramsIn === 'query') {
    for (const [k, v] of Object.entries(rest)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
  } else if (tool.method !== 'GET' && tool.method !== 'DELETE') {
    init.body = JSON.stringify(rest);
    init.headers = { ...init.headers, 'content-type': 'application/json' };
  }

  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    return { isError: true, content: [{ type: 'text', text: `upstream ${res.status}: ${text}` }] };
  }
  return { content: [{ type: 'text', text }] };
}

/** 每次请求按 DB 定义重建实例，工具改完立即生效。 */
export function buildGeneratedServer(input: GeneratedServerInput): McpServer {
  const server = new McpServer({ name: input.name, version: '1.0.0' });
  for (const tool of input.tools) {
    if (!tool.enabled) continue;
    // JSON Schema 原样透传，避免从 zod 反向生成时丢字段。
    const inputSchema = fromJsonSchema<Record<string, unknown>>(
      tool.inputSchema as Parameters<typeof fromJsonSchema>[0],
    );
    server.registerTool(
      tool.name,
      {
        description: tool.description || `${tool.method} ${tool.pathTemplate}`,
        inputSchema,
      },
      (args) => {
        if (tool.requiresApproval && !input.approvals.includes(tool.name)) {
          return {
            isError: true,
            content: [{ type: 'text', text: approvalRequiredMessage(tool.name) }],
          };
        }
        return callUpstream(tool, input.baseUrl, input.headers, args);
      },
    );
  }
  return server;
}
