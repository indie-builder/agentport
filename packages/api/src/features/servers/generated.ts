import type { ApiTool } from '@agentport/shared';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { assertSafeUrl } from './ssrf.js';

export interface GeneratedServerInput {
  /** 决定 SSRF 是否放行 localhost；与 test-connection 保持同一来源。 */
  nodeEnv?: string | undefined;
  name: string;
  baseUrl: string;
  headers: Record<string, string>;
  tools: ApiTool[];
  /** 当前 run 已批准的工具名；没有 run 上下文时为空，审批工具一律拒绝。 */
  approvals: string[];
  /**
   * 调用时重新读取审批状态。MCP handler 的工厂只在连接建立时执行一次，
   * 若只用构造期的 approvals，批准后同一连接内的调用仍然会被拒。
   */
  refreshApprovals?: () => Promise<string[]>;
  /** 拒绝时持久化结构化审批请求，供 UI 读取；无 run 上下文时不传。 */
  onApprovalRequired?: (toolName: string) => Promise<void>;
  /**
   * 等待人类批准的时长（D-18）。设置后，未批准的工具调用会挂起而不是立即失败：
   * 模型看到的是"这次工具调用比较慢"，批准后同一次调用直接拿到结果，
   * 不需要它重新发起。0 或未设置时保持旧的立即拒绝行为。
   */
  approvalWaitMs?: number;
}

/** 未批准时的固定文案：前端靠这段文本识别审批请求。 */
export function approvalRequiredMessage(toolName: string): string {
  return `需要批准：${toolName}。请在运行详情页批准后重试。`;
}

/** 挂起等待期间给模型的说明；批准后不会返回它。 */
export function approvalTimeoutMessage(toolName: string, waitMs: number): string {
  return `需要批准：${toolName}。已等待 ${Math.round(waitMs / 1000)} 秒仍未批准，本次调用取消。`;
}

const APPROVAL_POLL_MS = 500;

/** 挂起等待批准：轮询 DB，批准返回 true，超时返回 false。 */
async function waitForApproval(
  toolName: string,
  input: GeneratedServerInput,
  waitMs: number,
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  await input.onApprovalRequired?.(toolName);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, APPROVAL_POLL_MS));
    const approvals = input.refreshApprovals
      ? await input.refreshApprovals()
      : (input.approvals ?? []);
    if (approvals.includes(toolName)) return true;
  }
  return false;
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
  nodeEnv: string | undefined,
): Promise<CallToolResult> {
  const { path, rest } = fillPath(tool.pathTemplate, args);
  const url = new URL(baseUrl.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`));
  // 与 test-connection 一致：nodeEnv 决定是否放行 localhost，避免「测得通但跑不通」。
  await assertSafeUrl(url.toString(), nodeEnv);

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

  // 不跟随重定向（SSRF 只校验第一跳）；限制超时与响应体，避免上游拖死进程。
  const res = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await res.text();
  const MAX_BODY = 1_048_576;
  const text =
    raw.length > MAX_BODY
      ? `${raw.slice(0, MAX_BODY)}\n…[truncated ${raw.length - MAX_BODY} chars]`
      : raw;
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
      async (args) => {
        if (tool.requiresApproval) {
          const approvals = input.refreshApprovals
            ? await input.refreshApprovals()
            : input.approvals;
          if (!approvals.includes(tool.name)) {
            const waitMs = input.approvalWaitMs ?? 0;
            if (waitMs <= 0) {
              await input.onApprovalRequired?.(tool.name);
              return {
                isError: true,
                content: [{ type: 'text', text: approvalRequiredMessage(tool.name) }],
              };
            }
            // 真暂停：这次调用挂起，批准后继续执行，模型无需重试。
            const approved = await waitForApproval(tool.name, input, waitMs);
            if (!approved) {
              return {
                isError: true,
                content: [{ type: 'text', text: approvalTimeoutMessage(tool.name, waitMs) }],
              };
            }
          }
        }
        return callUpstream(tool, input.baseUrl, input.headers, args, input.nodeEnv);
      },
    );
  }
  return server;
}
