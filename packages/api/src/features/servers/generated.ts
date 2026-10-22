import { setTimeout as sleep } from 'node:timers/promises';
import type { ApiTool } from '@agentport/shared';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { runMcpExecution, tryApprovalWait } from '../../plugins/concurrency.js';
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
  /**
   * run 是否仍在执行。run 结束（完成/失败/取消）后挂起的调用不应继续执行，
   * 也不应在执行前把请求发到上游；无 run 上下文时不传。
   */
  isRunActive?: () => Promise<boolean>;
  /**
   * 拒绝时持久化结构化审批请求，供 UI 读取；无 run 上下文时不传。
   * expiresAt 是这次调用的等待截止时刻，立即拒绝时为 null。
   */
  onApprovalRequired?: (toolName: string, expiresAt: Date | null) => Promise<void>;
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

/** 调用方已取消（连接断开）或 run 已结束时给模型的说明；与超时区分开。 */
export function callCancelledMessage(toolName: string): string {
  return `调用已取消：${toolName}。运行已结束或请求已断开；已发送的上游请求可能仍在处理。`;
}

function cancelledResult(toolName: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: callCancelledMessage(toolName) }] };
}

const APPROVAL_POLL_MS = 500;

type ApprovalOutcome = 'approved' | 'timeout' | 'cancelled';

/**
 * 挂起等待批准：轮询 DB，批准返回 approved，超时返回 timeout；
 * 请求被取消或 run 结束时立即返回 cancelled，不再等剩余时间。
 */
async function waitForApproval(
  toolName: string,
  input: GeneratedServerInput,
  waitMs: number,
  signal: AbortSignal,
): Promise<ApprovalOutcome> {
  const deadline = Date.now() + waitMs;
  if (signal.aborted) return 'cancelled';
  if (input.isRunActive && !(await input.isRunActive())) return 'cancelled';
  if (signal.aborted) return 'cancelled';
  await input.onApprovalRequired?.(toolName, new Date(deadline));
  while (Date.now() < deadline) {
    try {
      await sleep(APPROVAL_POLL_MS, undefined, { signal });
    } catch {
      return 'cancelled';
    }
    // 睡醒时可能已过截止：此时再批准的请求已不属于这次调用，不能再恢复它。
    if (Date.now() >= deadline) break;
    const approvals = input.refreshApprovals
      ? await input.refreshApprovals()
      : (input.approvals ?? []);
    // 刷新期间连接可能已断开，或 run 已结束：优先报取消，不再从结果里恢复调用。
    if (signal.aborted) return 'cancelled';
    if (input.isRunActive && !(await input.isRunActive())) return 'cancelled';
    if (Date.now() >= deadline) return 'timeout';
    if (approvals.includes(toolName)) return 'approved';
  }
  return 'timeout';
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
  const { path, rest } = fillPath(tool.pathTemplate, args);
  const url = new URL(baseUrl.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`));
  // 与 test-connection 一致：nodeEnv 决定是否放行 localhost，避免「测得通但跑不通」。
  await assertSafeUrl(url.toString(), nodeEnv);
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
    server.registerTool(
      tool.name,
      {
        description: tool.description || `${tool.method} ${tool.pathTemplate}`,
        inputSchema,
      },
      async (args, ctx) => {
        const signal = ctx.mcpReq.signal;
        if (signal.aborted) return cancelledResult(tool.name);
        if (input.isRunActive && !(await input.isRunActive())) return cancelledResult(tool.name);
        if (tool.requiresApproval) {
          const approvals = input.refreshApprovals
            ? await input.refreshApprovals()
            : input.approvals;
          if (!approvals.includes(tool.name)) {
            const waitMs = input.approvalWaitMs ?? 0;
            if (waitMs <= 0) {
              if (signal.aborted) return cancelledResult(tool.name);
              if (input.isRunActive && !(await input.isRunActive()))
                return cancelledResult(tool.name);
              if (signal.aborted) return cancelledResult(tool.name);
              await input.onApprovalRequired?.(tool.name, null);
              return {
                isError: true,
                content: [{ type: 'text', text: approvalRequiredMessage(tool.name) }],
              };
            }
            // 真暂停：这次调用挂起，批准后继续执行，模型无需重试。
            // 等待名额是独立的；满了就走立即拒绝，不能让挂起把执行链路堵死。
            const outcome = await tryApprovalWait(() =>
              waitForApproval(tool.name, input, waitMs, signal),
            );
            if (outcome.accepted) {
              if (outcome.value === 'cancelled') return cancelledResult(tool.name);
              if (outcome.value === 'timeout') {
                return {
                  isError: true,
                  content: [{ type: 'text', text: approvalTimeoutMessage(tool.name, waitMs) }],
                };
              }
            } else {
              if (signal.aborted) return cancelledResult(tool.name);
              if (input.isRunActive && !(await input.isRunActive()))
                return cancelledResult(tool.name);
              if (signal.aborted) return cancelledResult(tool.name);
              await input.onApprovalRequired?.(tool.name, null);
              return {
                isError: true,
                content: [{ type: 'text', text: approvalRequiredMessage(tool.name) }],
              };
            }
          }
        }
        return callUpstream(
          tool,
          input.baseUrl,
          input.headers,
          args,
          input.nodeEnv,
          signal,
          input.isRunActive,
        );
      },
    );
  }
  return server;
}
