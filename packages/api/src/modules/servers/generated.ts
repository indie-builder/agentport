import type { ApiTool } from '@agentport/shared';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { runMcpExecution } from '../../plugins/concurrency.js';
import { assertServerEndpoint } from './ssrf.js';

export interface GeneratedServerInput {
  /** 决定 SSRF 是否放行 localhost；与 test-connection 保持同一来源。 */
  nodeEnv?: string | undefined;
  /** 显式配置的私网主机；只对这些主机的 upstream 放行内网地址。 */
  privateHostAllowlist: string;
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
  denied?: string[];
  refreshDenied?: () => Promise<string[]>;
  /**
   * run 是否仍在执行。run 结束（完成/失败/取消）后挂起的调用不应继续执行，
   * 也不应在执行前把请求发到上游；无 run 上下文时不传。
   */
  isRunActive?: () => Promise<boolean>;
  onApprovalRequired?: (toolName: string, args: Record<string, unknown>) => Promise<void>;
  onDenied?: (toolName: string, args: Record<string, unknown>) => Promise<void>;
}

/** 未批准时的固定文案：前端靠这段文本识别审批请求。 */
function approvalRequiredMessage(toolName: string): string {
  return `需要批准：${toolName}。请在运行详情页批准后重试。`;
}

/** 调用方已取消（连接断开）或 run 已结束时给模型的说明；与超时区分开。 */
function callCancelledMessage(toolName: string): string {
  return `调用已取消：${toolName}。运行已结束或请求已断开；已发送的上游请求可能仍在处理。`;
}

function approvalDeniedMessage(toolName: string): string {
  return `已拒绝：${toolName}。用户拒绝了本次调用。`;
}

function cancelledResult(toolName: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: callCancelledMessage(toolName) }] };
}

function deniedResult(toolName: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: approvalDeniedMessage(toolName) }] };
}

function policyDeniedMessage(toolName: string): string {
  return `禁止调用：${toolName}。该工具被策略禁止调用，请联系管理员。`;
}

function policyDeniedResult(toolName: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: policyDeniedMessage(toolName) }] };
}

type FilledPath =
  | { ok: true; path: string; rest: Record<string, unknown> }
  | { ok: false; param: string };

/** 路径模板里的 {param} 已用掉后，剩余参数才进 query/body。 */
function fillPath(template: string, args: Record<string, unknown>): FilledPath {
  const rest: Record<string, unknown> = { ...args };
  let invalid: string | undefined;
  const path = template.replace(/\{([^{}]+)\}/g, (_match, key: string) => {
    const value = rest[key];
    delete rest[key];
    const text = value === undefined ? '' : String(value);
    // encodeURIComponent 不转义点号，`..` 会被 URL 归一化后跳出工具声明的路径段。
    if (text === '.' || text === '..') {
      invalid ??= key;
      return '';
    }
    return encodeURIComponent(text);
  });
  return invalid === undefined ? { ok: true, path, rest } : { ok: false, param: invalid };
}

/**
 * fetch 前再次校验目标地址：工具定义保存时能过检查，不代表运行时 DNS 没被改。
 * 这里不吞错误，让它冒泡成 CallToolResult 的错误内容。
 */
/** 读响应体时立即截断：超出上限就停止读取并取消流。 */
async function readCapped(res: Response, max: number): Promise<string> {
  const body = res.body;
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  // 读满上限后再多读一块，用来判断是否真的被截断。
  while (total <= max) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (text.length > max) break;
  }
  if (total > max || text.length > max) {
    await reader.cancel().catch(() => undefined);
    return `${text.slice(0, max)}\n…[truncated at ${max} chars]`;
  }
  return text + decoder.decode();
}

async function callUpstream(
  tool: ApiTool,
  baseUrl: string,
  headers: Record<string, string>,
  args: Record<string, unknown>,
  nodeEnv: string | undefined,
  privateHostAllowlist: string,
  signal: AbortSignal,
  isRunActive: (() => Promise<boolean>) | undefined,
): Promise<CallToolResult> {
  if (tool.paramsIn === 'body' && (tool.method === 'GET' || tool.method === 'DELETE')) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `${tool.method} 工具「${tool.name}」不能使用 body 参数；请改为 query`,
        },
      ],
    };
  }
  const filled = fillPath(tool.pathTemplate, args);
  if (!filled.ok) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `${tool.method} 工具「${tool.name}」的参数 ${filled.param} 不能是 "." 或 ".."`,
        },
      ],
    };
  }
  const { path, rest } = filled;
  const url = new URL(baseUrl.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`));
  // 与 test-connection 一致：nodeEnv 决定是否放行 localhost，避免「测得通但跑不通」。
  await assertServerEndpoint(url.toString(), {
    nodeEnv,
    allowlist: privateHostAllowlist,
  });
  // DNS 校验期间可能已被取消或 run 已结束：在真正发请求前关掉这个窗口。
  if (signal.aborted) return cancelledResult(tool.name);
  if (isRunActive && !(await isRunActive())) return cancelledResult(tool.name);

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
  // 已发出的请求无法撤回：run 在 fetch 途中结束时，只能等对方响应或 30s 超时。
  return runMcpExecution(async () => {
    // 排队期间可能已被取消或 run 已结束：拿到名额后、发请求前再确认一次。
    if (signal.aborted) return cancelledResult(tool.name);
    if (isRunActive && !(await isRunActive())) return cancelledResult(tool.name);
    try {
      const res = await fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      // 边流边截断：上游返回 2GB 时不能在截断前先整块读进内存。
      const MAX_BODY = 1_048_576;
      const text = await readCapped(res, MAX_BODY);
      if (!res.ok) {
        return {
          isError: true,
          content: [{ type: 'text', text: `upstream ${res.status}: ${text}` }],
        };
      }
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      // 只有调用方取消才算取消；30s 超时与网络错误照旧冒泡。
      if (signal.aborted) return cancelledResult(tool.name);
      throw err;
    }
  });
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
    const outputSchema = tool.outputSchema
      ? fromJsonSchema<Record<string, unknown>>(
          tool.outputSchema as Parameters<typeof fromJsonSchema>[0],
        )
      : undefined;
    server.registerTool(
      tool.name,
      {
        description: tool.description || `${tool.method} ${tool.pathTemplate}`,
        inputSchema,
        ...(outputSchema ? { outputSchema } : {}),
      },
      async (args, ctx) => {
        const signal = ctx.mcpReq.signal;
        if (signal.aborted) return cancelledResult(tool.name);
        if (input.isRunActive && !(await input.isRunActive())) return cancelledResult(tool.name);
        if (tool.approvalMode === 'deny') {
          await input.onDenied?.(tool.name, args);
          return policyDeniedResult(tool.name);
        }
        if (tool.approvalMode === 'ask') {
          const approvals = input.refreshApprovals
            ? await input.refreshApprovals()
            : input.approvals;
          if (!approvals.includes(tool.name)) {
            const denied = input.refreshDenied ? await input.refreshDenied() : (input.denied ?? []);
            if (signal.aborted) return cancelledResult(tool.name);
            if (input.isRunActive && !(await input.isRunActive()))
              return cancelledResult(tool.name);
            if (signal.aborted) return cancelledResult(tool.name);
            if (denied.includes(tool.name)) return deniedResult(tool.name);
            await input.onApprovalRequired?.(tool.name, args);
            return {
              isError: true,
              content: [{ type: 'text', text: approvalRequiredMessage(tool.name) }],
            };
          }
        }
        const result = await callUpstream(
          tool,
          input.baseUrl,
          input.headers,
          args,
          input.nodeEnv,
          input.privateHostAllowlist,
          signal,
          input.isRunActive,
        );
        if (!tool.outputSchema || result.isError) return result;
        const text = result.content?.find((item) => item.type === 'text')?.text ?? '';
        try {
          // MCP SDK 要求声明 outputSchema 的工具必须返回 structuredContent，否则整次调用被判失败。
          return { ...result, structuredContent: JSON.parse(text) };
        } catch (err) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `上游返回非 JSON，无法满足 outputSchema：${err instanceof Error ? err.message : '解析失败'}`,
              },
            ],
          };
        }
      },
    );
  }
  return server;
}
