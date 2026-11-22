import { errorText } from '@agentport/shared';
import type { CreateMcpHandlerOptions, McpHttpHandler } from '@modelcontextprotocol/server';
import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';

export interface AgentToolSpec {
  slug: string;
  name: string;
  description: string;
}

export interface AgentInvoker {
  invoke(input: {
    slug: string;
    prompt: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<string>;
}

function toolName(slug: string): string {
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

export function platformMcpToken(env: NodeJS.ProcessEnv): string | null {
  const token = env.PLATFORM_MCP_TOKEN;
  return token && token.length >= 16 ? token : null;
}

export function agentHandler(
  invoker: AgentInvoker,
  specs: AgentToolSpec[],
  options?: CreateMcpHandlerOptions,
): McpHttpHandler {
  return createMcpHandler(() => buildAgentServer(specs, invoker), options);
}
