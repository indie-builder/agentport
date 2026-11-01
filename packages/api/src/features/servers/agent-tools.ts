import { errorText } from '@agentport/shared';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';

/**
 * 把平台内的智能体暴露成 MCP 工具，供其他 Host（Claude Code、其他智能体）调用。
 *
 * 每次调用创建一个 run、等待其终态，然后返回最终 assistant 文本。
 * 这是「平台即工具」的能力：智能体从被使用变为可被组合。
 */
export interface AgentToolSpec {
  slug: string;
  name: string;
  description: string;
}

export interface AgentInvoker {
  /** 执行一次智能体，返回最终文本；失败抛错。signal 中止时不得启动或需终止已创建的 run。 */
  invoke(input: {
    slug: string;
    prompt: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<string>;
}

function toolName(slug: string): string {
  // MCP 工具名只保留安全字符，且要稳定可预测。
  return `run_${slug.replace(/[^a-z0-9_-]/gi, '_').toLowerCase()}`;
}

export function buildAgentServer(specs: AgentToolSpec[], invoker: AgentInvoker): McpServer {
  const server = new McpServer({ name: 'agentport', version: '1.0.0' });

  for (const spec of specs) {
    server.registerTool(
      toolName(spec.slug),
      {
        title: spec.name,
        description: spec.description || `运行智能体 ${spec.name}`,
        inputSchema: fromJsonSchema<Record<string, unknown>>({
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '给智能体的任务描述' },
            timeoutMs: {
              type: 'number',
              description: '超时毫秒数，默认 10 分钟',
              exclusiveMinimum: 0,
            },
          },
          required: ['prompt'],
        }),
      },
      async (args: { prompt?: unknown; timeoutMs?: unknown }, ctx) => {
        const prompt = typeof args.prompt === 'string' ? args.prompt : '';
        if (prompt.length === 0) {
          return { content: [{ type: 'text', text: 'prompt is required' }], isError: true };
        }
        try {
          const text = await invoker.invoke({
            slug: spec.slug,
            prompt,
            // 客户端断开（tools/call 取消）时 SDK 通过 ctx.mcpReq.signal 通知，run 必须随之停下。
            signal: ctx.mcpReq.signal,
            ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
          });
          return { content: [{ type: 'text', text }] };
        } catch (err) {
          return {
            content: [{ type: 'text', text: errorText(err) }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}

/** 平台对外 MCP 端点的 Bearer token；单管理员场景下由环境变量提供。 */
export function platformMcpToken(env: NodeJS.ProcessEnv): string | null {
  const token = env.PLATFORM_MCP_TOKEN;
  return token && token.length >= 16 ? token : null;
}

export function agentHandler(invoker: AgentInvoker, specs: AgentToolSpec[]): McpHttpHandler {
  // 每次请求重新构建：智能体列表变化后无需重启端点。
  return createMcpHandler(() => buildAgentServer(specs, invoker));
}
