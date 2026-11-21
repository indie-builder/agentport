import { assertServerEndpoint } from '@agentport/core/net-guard';
import type { ApiTool } from '@agentport/shared';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { runMcpExecution } from '../../plugins/concurrency.js';
import type { createApprovalEvaluator } from './approval-policy.js';

type ApprovalEvaluation = Pick<
  Awaited<ReturnType<ReturnType<typeof createApprovalEvaluator>>>,
  'effectiveMode' | 'baseline' | 'approved' | 'decisionHash' | 'matchedRuleIds'
> & { approval?: { deniedAt: Date | null } | null };

export interface GeneratedServerInput {
  nodeEnv?: string | undefined;
  privateHostAllowlist: string;
  name: string;
  baseUrl: string;
  headers: Record<string, string>;
  tools: ApiTool[];
  evaluateApproval?: (tool: ApiTool, baseUrl: string) => Promise<ApprovalEvaluation>;
  isRunActive?: () => Promise<boolean>;
  onApprovalRequired?: (
    toolName: string,
    args: Record<string, unknown>,
    decision: ApprovalEvaluation,
  ) => Promise<void>;
  onDenied?: (
    toolName: string,
    args: Record<string, unknown>,
    matchedRuleIds?: readonly string[],
  ) => Promise<void>;
  checkOutbound?: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<{ blocked: boolean; args: Record<string, unknown> }>;
}

function approvalRequiredMessage(toolName: string): string {
  return `需要批准：${toolName}。请在运行详情页批准后重试。`;
}

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

async function readCapped(res: Response, max: number): Promise<string> {
  const body = res.body;
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
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
  recheckApproval: (() => Promise<CallToolResult | null>) | undefined,
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
  await assertServerEndpoint(url.toString(), {
    nodeEnv,
    allowlist: privateHostAllowlist,
  });
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

  return runMcpExecution(async () => {
    if (signal.aborted) return cancelledResult(tool.name);
    if (isRunActive && !(await isRunActive())) return cancelledResult(tool.name);
    if (signal.aborted) return cancelledResult(tool.name);
    const blocked = await recheckApproval?.();
    if (blocked) return blocked;
    if (signal.aborted) return cancelledResult(tool.name);
    try {
      const res = await fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
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
      if (signal.aborted) return cancelledResult(tool.name);
      throw err;
    }
  });
}

export function buildGeneratedServer(input: GeneratedServerInput): McpServer {
  const server = new McpServer({ name: input.name, version: '1.0.0' });
  for (const tool of input.tools) {
    if (!tool.enabled) continue;
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
        const approvalGate = async (decision?: ApprovalEvaluation) => {
          switch (decision?.effectiveMode ?? tool.approvalMode) {
            case 'deny':
              await input.onDenied?.(tool.name, args, decision?.matchedRuleIds);
              return policyDeniedResult(tool.name);
            case 'ask':
              if (decision?.approved) return null;
              if (
                signal.aborted ||
                (input.isRunActive && !(await input.isRunActive())) ||
                signal.aborted
              )
                return cancelledResult(tool.name);
              if (decision?.approval?.deniedAt != null) return deniedResult(tool.name);
              if (decision !== undefined)
                await input.onApprovalRequired?.(tool.name, args, decision);
              return {
                isError: true,
                content: [{ type: 'text' as const, text: approvalRequiredMessage(tool.name) }],
              };
            case 'allow':
              return null;
          }
        };
        const evaluateApproval = input.evaluateApproval;
        const decision = await evaluateApproval?.(tool, input.baseUrl);
        const blocked = await approvalGate(decision);
        if (blocked) return blocked;
        const checked = input.checkOutbound
          ? await input.checkOutbound(tool.name, args)
          : { blocked: false, args };
        if (checked.blocked) return policyDeniedResult(tool.name);
        const result = await callUpstream(
          tool,
          input.baseUrl,
          input.headers,
          checked.args,
          input.nodeEnv,
          input.privateHostAllowlist,
          signal,
          input.isRunActive,
          evaluateApproval &&
            (async () => {
              const current = await evaluateApproval(tool, input.baseUrl);
              if (current?.decisionHash !== decision?.decisionHash) {
                if (current.effectiveMode === 'deny') return approvalGate(current);
                return {
                  isError: true,
                  content: [{ type: 'text', text: '工具审批判定已变更，调用未执行。' }],
                };
              }
              return approvalGate(current);
            }),
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
