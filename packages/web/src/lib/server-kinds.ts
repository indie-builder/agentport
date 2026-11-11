import type { Server } from '@agentport/shared';

export const kindMeta: Record<Server['kind'], { label: string; newHint?: string }> = {
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
  },
  gateway: {
    label: '统一聚合',
  },
};
