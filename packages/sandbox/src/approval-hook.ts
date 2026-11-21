import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  httpServerSchema,
  MCP_APPROVAL_WAIT_MS,
  mcpEndpointPath,
  type SandboxTask,
  toolApprovalPath,
  toolApprovalResponseSchema,
} from '@agentport/shared';
import type { HookCallback, HookPermissionDecision } from '@anthropic-ai/claude-agent-sdk';

export function createApprovalHook(
  task: SandboxTask,
  workspaceDir: string,
  runSignal: AbortSignal,
): HookCallback {
  const tools = new Map(
    task.mcpApprovalTools.map((tool) => [`mcp__${tool.server}__${tool.tool}`, tool]),
  );
  return async (input, _toolUseId, options) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const tool = tools.get(input.tool_name);
    if (tool === undefined) return {};
    const decision = (
      permissionDecision: HookPermissionDecision,
      permissionDecisionReason: string,
    ) => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision,
        permissionDecisionReason,
      },
    });
    const signal = AbortSignal.any([
      options.signal,
      runSignal,
      AbortSignal.timeout(MCP_APPROVAL_WAIT_MS),
    ]);
    if (signal.aborted) return decision('deny', '运行已取消，工具调用未执行。');
    const config: unknown = JSON.parse(await readFile(join(workspaceDir, '.mcp.json'), 'utf8'));
    if (
      typeof config !== 'object' ||
      config === null ||
      !('mcpServers' in config) ||
      typeof config.mcpServers !== 'object' ||
      config.mcpServers === null
    ) {
      return decision('deny', '无法读取平台工具审批连接。');
    }
    const entry: unknown = Reflect.get(config.mcpServers, tool.server);
    if (typeof entry !== 'object' || entry === null)
      return decision('deny', '平台工具审批连接缺失。');
    const connection = httpServerSchema.parse({ ...entry, name: tool.server, kind: 'http' });
    const serverId = task.mcpServerIds[tool.server];
    const headers = new Headers(connection.headers);
    const runId = headers.get('x-agentport-run-id');
    const url = new URL(connection.url);
    if (serverId === undefined) return decision('deny', '平台工具审批凭证缺失。');
    const suffix = mcpEndpointPath(serverId);
    if (
      !url.pathname.endsWith(suffix) ||
      runId === null ||
      !headers.get('authorization')?.startsWith('Bearer ')
    ) {
      return decision('deny', '平台工具审批凭证缺失。');
    }
    url.pathname = `${url.pathname.slice(0, -suffix.length)}${toolApprovalPath(serverId, runId, tool.tool)}`;
    url.search = '';
    url.hash = '';
    headers.set('content-type', 'application/json');
    let registered = false;
    let transportFailures = 0;
    let backoff = 2_000;
    let expiresAt = Number.POSITIVE_INFINITY;
    while (!signal.aborted && Date.now() < expiresAt) {
      let delay = 2_000;
      let responded = false;
      try {
        const response = await fetch(url, {
          method: registered ? 'GET' : 'PUT',
          headers,
          ...(registered ? {} : { body: JSON.stringify(input.tool_input) }),
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
        });
        responded = true;
        transportFailures = 0;
        if ([401, 403, 404, 409].includes(response.status))
          return decision('deny', '工具审批授权已失效，调用未执行。');
        if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after');
          const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
          const retryAt = retryAfter === null ? Number.NaN : Date.parse(retryAfter);
          delay = Math.max(
            2_000,
            Number.isFinite(seconds)
              ? seconds * 1_000
              : Number.isFinite(retryAt)
                ? retryAt - Date.now()
                : backoff,
          );
        } else if (response.ok) {
          const state = toolApprovalResponseSchema.parse(await response.json());
          if (signal.aborted) break;
          if (state.status === 'approved')
            return Date.now() >= expiresAt ? decision('deny', '工具审批已过期，调用未执行。') : {};
          if (state.status !== 'pending')
            return decision(
              'deny',
              `工具审批${state.status === 'denied' ? '已拒绝' : state.status === 'expired' ? '已过期' : '已取消'}，调用未执行。`,
            );
          registered = state.approvalId !== null;
          expiresAt =
            state.expiresAt === null ? Number.POSITIVE_INFINITY : Date.parse(state.expiresAt);
          backoff = 2_000;
        } else if (response.status >= 500) {
          delay = backoff;
          backoff = Math.min(backoff * 2, 5_000);
        } else {
          return decision('deny', '工具审批请求失败，调用未执行。');
        }
      } catch {
        if (!responded) transportFailures += 1;
        delay = backoff;
        backoff = Math.min(backoff * 2, 5_000);
      }
      if (Date.now() >= expiresAt) return decision('deny', '工具审批已过期，调用未执行。');
      if (!signal.aborted && transportFailures >= 3)
        return decision('deny', '工具审批服务不可达，调用未执行。');
      await sleep(Math.min(delay, Math.max(0, expiresAt - Date.now())), undefined, {
        signal,
      }).catch(() => undefined);
    }
    return decision('deny', '工具审批等待已取消或超时，调用未执行。');
  };
}
