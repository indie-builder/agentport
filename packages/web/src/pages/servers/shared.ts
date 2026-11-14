import type { ApiTool, Server, ServerInput, ServerTestResult } from '@agentport/shared';

export type Kind = ServerInput['kind'];

export const approvalOptions = [
  { value: 'allow', label: '允许' },
  { value: 'ask', label: '需要审批' },
  { value: 'deny', label: '禁止' },
] satisfies { value: ApiTool['approvalMode']; label: string }[];

export const kindMeta: Record<Server['kind'], { label: string; newHint: string }> = {
  stdio: {
    label: '本地命令',
    newHint: '在沙盒里启动一个 MCP 进程，例如 npx 包或本地脚本。',
  },
  http: {
    label: '远程 MCP',
    newHint: '直接连接一个已经实现了 MCP 协议的 HTTP 服务。',
  },
  generated: {
    label: 'HTTP API 转 MCP',
    newHint: '逐个声明上游 HTTP 端点，平台替你生成可调用的 MCP 工具。',
  },
  knowledge: {
    label: '知识库',
    newHint: '',
  },
};

/** 本次页面会话的最近一次试连结果；刷新后只剩 server.lastTest* 持久化字段。 */
export interface LastTest {
  at: string;
  result: ServerTestResult;
}
