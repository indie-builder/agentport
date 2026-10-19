import type { McpJsonEntry } from './tools.js';

export interface WorkspaceFiles {
  mcpJson: string;
  claudeMd: string;
  agentMd: string;
}

export interface WorkspaceAgent {
  slug: string;
  name: string;
  model: string;
  systemPrompt: string;
  maxTurns: number;
}

export interface WorkspaceInput {
  agent: WorkspaceAgent;
  servers: Array<{ name: string; entry: McpJsonEntry }>;
  toolsAllow?: string[];
  toolsDeny?: string[];
}

/** 内置工具一律禁用；限制靠裸工具名从上下文移除，而不是 allowedTools。 */
const DEFAULT_DISALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Agent',
  'TaskStop',
];

const DESCRIPTION_MAX = 200;

/** 单行摘要：取 system prompt 第一段非空文本，去掉标题标记。 */
function summarize(prompt: string, fallback: string): string {
  const line =
    prompt
      .split('\n')
      .map((l) => l.trim())
      .map((l) => l.replace(/^#+\s*/, ''))
      .find((l) => l.length > 0) ?? fallback;
  return line.length > DESCRIPTION_MAX ? `${line.slice(0, DESCRIPTION_MAX)}…` : line;
}

/** JSON 字符串同时也是合法的 YAML 双引号标量，省掉手写转义。 */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlList(values: string[]): string {
  return `[${values.map(yamlString).join(', ')}]`;
}

function renderClaudeMd(input: WorkspaceInput): string {
  const { agent, servers } = input;
  const toolLines =
    servers.length === 0
      ? ['当前没有绑定 MCP Server，你没有可调用的工具。']
      : [
          '本工作区通过 `.mcp.json` 绑定以下 MCP Server：',
          '',
          ...servers.map((s) => `- \`${s.name}\` → 工具名形如 \`mcp__${s.name}__<tool>\``),
        ];

  return [
    `# ${agent.name}`,
    '',
    agent.systemPrompt.trim(),
    '',
    '## 工具使用',
    '',
    ...toolLines,
    '',
    '只使用 `mcp__*` MCP 工具；内置的 shell、文件与网络工具已被禁用。',
    '如需更多能力，请让管理员在平台中为智能体绑定对应的 MCP Server。',
    '',
  ].join('\n');
}

function renderAgentMd(input: WorkspaceInput): string {
  const { agent, servers } = input;
  const tools = input.toolsAllow ?? servers.map((s) => `mcp__${s.name}__*`);
  const disallowed = input.toolsDeny ?? DEFAULT_DISALLOWED_TOOLS;
  const description = summarize(agent.systemPrompt, `${agent.name} 智能体`);

  const frontmatter = [
    '---',
    `name: ${yamlString(agent.slug)}`,
    `description: ${yamlString(description)}`,
    `model: ${yamlString(agent.model)}`,
    `tools: ${yamlList(tools)}`,
    `disallowedTools: ${yamlList(disallowed)}`,
    `maxTurns: ${agent.maxTurns}`,
    '---',
  ];

  return [
    ...frontmatter,
    '',
    `# ${agent.name}`,
    '',
    description,
    '',
    '完整系统提示见 `CLAUDE.md`。',
    '',
  ].join('\n');
}

/** 把 DB 中的智能体定义渲染成三个落盘文件的内容；纯函数，不碰文件系统。 */
export function renderWorkspace(input: WorkspaceInput): WorkspaceFiles {
  const mcpServers: Record<string, McpJsonEntry> = {};
  for (const server of input.servers) {
    mcpServers[server.name] = server.entry;
  }

  return {
    mcpJson: `${JSON.stringify({ mcpServers }, null, 2)}\n`,
    claudeMd: renderClaudeMd(input),
    agentMd: renderAgentMd(input),
  };
}
