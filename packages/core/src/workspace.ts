import type { McpJsonEntry } from './tools.js';

export interface WorkspaceFiles {
  mcpJson: string;
  claudeMd: string;
  agentMd: string;
  skills: Array<{
    slug: string;
    content: string;
    files: Array<{ path: string; content: string }>;
  }>;
  subAgents: Array<{ slug: string; content: string }>;
  /** 项目规则：`.claude/rules/<slug>.md` 的完整内容。 */
  rules: Array<{ slug: string; content: string }>;
  /** 自定义输出风格：`.claude/output-styles/<slug>.md` 的完整内容。 */
  outputStyles: Array<{ slug: string; content: string }>;
  /** 选中的输出风格名（写入 settings.outputStyle）；null 表示用默认。 */
  selectedOutputStyle: string | null;
  /** 渲染出的 `.claude/settings.json` 内容；null 表示无该文件。 */
  settingsJson: string | null;
}

export interface WorkspaceAgent {
  slug: string;
  name: string;
  description?: string;
  model: string;
  systemPrompt: string;
  maxTurns: number;
  permissionMode?: string;
  effort?: string | null;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** 子智能体的技能；父智能体只声明自己的，子技能仅供子智能体原生加载。 */
  skills?: WorkspaceSkill[];
  /** 子智能体超时；调用方会一直等到它返回或超时。 */
  timeoutMs?: number;
}

export interface WorkspaceSkill {
  slug: string;
  name: string;
  description: string;
  body: string;
  /** 官方 SKILL.md 目录的支持资源文件，相对技能目录的路径。 */
  files?: Array<{ path: string; content: string }>;
}

export interface WorkspaceInput {
  agent: WorkspaceAgent;
  servers: Array<{ name: string; entry: McpJsonEntry }>;
  skills?: WorkspaceSkill[];
  /** 单层委派：这些子智能体渲染到 .claude/agents/，主智能体获得 Agent 工具。 */
  subAgents?: WorkspaceAgent[];
  /** 项目规则：{ slug, content, globs? }。 */
  rules?: Array<{ slug: string; content: string; globs?: string }>;
  /** 自定义输出风格：{ slug, description, keepCodingInstructions, body }。 */
  outputStyles?: Array<{
    slug: string;
    description: string;
    keepCodingInstructions: boolean;
    body: string;
  }>;
  /** 选中的输出风格名；undefined/null 表示默认。 */
  selectedOutputStyle?: string | null;
  toolsAllow?: string[];
  toolsDeny?: string[];
}

/** 渲染一个输出风格 `.md`：官方 frontmatter（name/description/keep-coding-instructions）+ 正文。 */
export function renderOutputStyleMd(style: {
  slug: string;
  description: string;
  keepCodingInstructions: boolean;
  body: string;
}): string {
  return [
    '---',
    `name: ${yamlString(style.slug)}`,
    ...(style.description ? [`description: ${yamlString(style.description)}`] : []),
    `keep-coding-instructions: ${style.keepCodingInstructions ? 'true' : 'false'}`,
    '---',
    '',
    style.body.trim(),
    '',
  ].join('\n');
}

/** 渲染一条规则文件：有 globs 时写入 frontmatter 的 paths；否则纯 Markdown。 */
export function renderRuleMd(rule: { slug: string; content: string; globs?: string }): string {
  const globs = (rule.globs ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
  if (globs.length === 0) return `${rule.content.trim()}\n`;
  return [
    '---',
    'paths:',
    ...globs.map((g) => `  - ${yamlString(g)}`),
    '---',
    '',
    rule.content.trim(),
    '',
  ].join('\n');
}

/**
 * 内置工具默认全部禁用。限制靠裸工具名从上下文移除；
 * allowedTools 只负责自动批准，不负责限制。
 */
export const DEFAULT_DISALLOWED_TOOLS = [
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
  // 会话间消息工具与「同步等待」相悖：发送方不等对方返回就继续。
  // ListAgents/SendMessage 可按智能体显式放行（D-19）；Monitor/EndConversation 永远关闭。
  'ListAgents',
  'SendMessage',
  'EndConversation',
  'Monitor',
  'SendUserMessage',
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

/**
 * 描述会被插进 markdown 列表与表格单元格。换行能另起段落伪造标题，
 * `|` 能冲出表格单元格，两者都要压平——描述是用户可控的导入内容。
 */
function inlineText(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

function yamlList(values: string[]): string {
  return `[${values.map(yamlString).join(', ')}]`;
}

/**
 * 智能体间沟通的等待语义。
 *
 * 平台里只有三种形式，调用方都必须等到对方给出结果：
 * 1. 委派给子智能体（Agent 工具）
 * 2. 调用平台内其他智能体（/mcp 暴露的 run_<slug> 工具）
 * 3. 调用外部 HTTP→MCP 工具（可能需要人工审批，批准前调用方挂起）
 *
 * SDK 的 `Agent` 默认后台运行（run_in_background 缺省 true），与「等待」相反。
 * 这里把 run_in_background: false 写成硬约束，否则父智能体会在子智能体
 * 返回前结束本轮，最终文本里没有结果。
 */
export const DELEGATION_WAIT_RULE =
  '委派时必须传 `run_in_background: false`：平台要求你等到子智能体返回结果后再继续。' +
  '默认的后台模式会让本轮在结果回来前结束。';

export function delegationWaitSection(input: WorkspaceInput): string[] {
  const subAgents = input.subAgents ?? [];
  const lines: string[] = [];

  if (subAgents.length > 0) {
    lines.push(
      '',
      '## 等待规则',
      '',
      '本平台的智能体之间是**同步调用**：调用方发起后要等到被调用方返回，才能继续。',
      '',
      '- 委派给子智能体：调用 `Agent` 时传 `run_in_background: false`，不要用后台模式。',
      '  如果你提前结束本轮，调用方（用户或其他智能体）拿不到结果。',
      '- 子智能体只返回最终文本。中间的 `tool_start` / `tool_result` 由平台记录，你不需要转述。',
      `- 子智能体受它自己的 \`maxTurns\` 与智能体超时约束；超时后本次委派失败，不会无限等待。`,
    );
  }

  if (input.servers.length > 0) {
    lines.push(
      '',
      '### 工具调用中的等待',
      '',
      '- MCP 工具是同步调用：返回前不要假设结果已经可用。',
      '- 标记为「需要批准」的工具会先返回一条 `需要批准：<tool>`。',
      '  这不是失败：把这句话原样告诉用户，等管理员在运行详情页批准后重试同一调用。',
    );
  }

  return lines;
}

function renderClaudeMd(input: WorkspaceInput): string {
  const { agent, servers, skills = [] } = input;
  const toolLines =
    servers.length === 0
      ? [
          skills.length === 0
            ? '当前没有绑定 MCP Server，也没有可用技能；主会话仍可使用下述原生记忆。'
            : '当前没有绑定 MCP Server，你没有 MCP 工具；可用能力只有下方列出的技能与原生记忆。',
        ]
      : [
          '本工作区通过 `.mcp.json` 绑定以下 MCP Server：',
          '',
          ...servers.map((s) => `- \`${s.name}\` → 工具名形如 \`mcp__${s.name}__<tool>\``),
        ];

  const skillLines =
    skills.length === 0
      ? []
      : [
          '',
          '## 可用技能',
          '',
          ...skills.map((s) => `- \`${s.slug}\`：${inlineText(s.description)}`),
          '',
          '需要时用原生 `Skill` 工具调用对应技能，技能名就是上面的 slug。',
          '不要用 `Read` 打开 `.claude/skills/` 下的文件：文件工具仅供主会话访问原生记忆。',
        ];

  const subAgents = input.subAgents ?? [];
  const subAgentLines =
    subAgents.length === 0
      ? []
      : [
          '',
          '## 可用子智能体',
          '',
          '用 `Agent` 工具把任务委派给以下子智能体。它们不能再向下委派。',
          '',
          '| slug | 适用场景 | 超时 |',
          '|---|---|---|',
          ...subAgents.map(
            (s) =>
              `| \`${s.slug}\` | ${inlineText(s.description || s.name)} | ${s.timeoutMs ? `${Math.round(s.timeoutMs / 1000)}s` : '默认'} |`,
          ),
          '',
          '委派前先读上面的「等待规则」。',
        ];

  return [
    `# ${agent.name}`,
    '',
    agent.systemPrompt.trim(),
    '',
    '## 工具使用',
    '',
    ...toolLines,
    ...(subAgents.length > 0
      ? ['', '内置的 `Agent` 工具已启用，仅用于委派给上面的子智能体。']
      : []),
    '',
    '业务能力使用 `mcp__*` MCP 工具；内置 shell 与网络工具已禁用。',
    '主会话可用 `Read`、`Write`、`Edit` 访问 `/mnt/agent-memory/` 内的 Markdown 原生记忆；只读可用 `Read` 打开 `.claude/skills/<slug>/references/` 下的 Markdown；其他路径与子智能体文件访问均被拒绝。',
    '如需更多能力，请让管理员在平台中为智能体绑定对应的 MCP Server。',
    ...skillLines,
    ...delegationWaitSection(input),
    ...subAgentLines,
    '',
  ].join('\n');
}

/** standalone：子智能体文件没有自己的 CLAUDE.md，正文直接放系统提示。 */
function renderAgentMd(input: WorkspaceInput, standalone = false): string {
  const { agent, servers, skills = [] } = input;
  const tools =
    input.toolsAllow && input.toolsAllow.length > 0
      ? input.toolsAllow
      : servers.map((s) => `mcp__${s.name}__*`);
  const hasSubAgents = (input.subAgents ?? []).length > 0;
  // 智能体可显式放行 ListAgents/SendMessage（D-19）；其余默认项不能通过配置解除。
  const allowedByConfig = new Set(input.toolsAllow ?? []);
  const mayEnable = (tool: string): boolean =>
    tool === 'Agent' || tool === 'TaskStop'
      ? hasSubAgents
      : tool === 'ListAgents' || tool === 'SendMessage'
        ? allowedByConfig.has(tool)
        : false;
  // 单层委派：有子智能体时放行 Agent/TaskStop，与 runner 的 options 保持一致；
  // 子智能体本身不传 subAgents，因此仍被禁用，无法继续向下委派。
  const disallowed = [
    ...new Set([
      ...DEFAULT_DISALLOWED_TOOLS.filter((tool) => !mayEnable(tool)),
      // 子智能体的单层约束由这里兜底：API 只拦两层父子，
      // 手工把文件放回 .claude/agents/ 时也必须无法再委派。
      ...(standalone ? ['Agent', 'TaskStop'] : []),
      ...(input.toolsDeny ?? []),
    ]),
  ];
  const description =
    agent.description?.trim() || summarize(agent.systemPrompt, `${agent.name} 智能体`);

  const frontmatter = [
    '---',
    `name: ${yamlString(agent.slug)}`,
    `description: ${yamlString(description)}`,
    `model: ${yamlString(agent.model)}`,
    // 子智能体不能声明 tools：SDK 在派生时先按主会话解析这些名字，MCP 工具此时尚未注册，
    // `mcp__<server>__*` 解析为空会被直接拒绝（"would be spawned with zero tools"）。
    // 省略 tools 即继承父会话工具集；子级 disallowedTools 保持禁用文件工具。
    ...(standalone ? [] : [`tools: ${yamlList(hasSubAgents ? [...tools, 'Agent'] : tools)}`]),
    `disallowedTools: ${yamlList(disallowed)}`,
    `maxTurns: ${agent.maxTurns}`,
    ...(skills.length > 0 ? [`skills: ${yamlList(skills.map((s) => s.slug))}`] : []),
    ...(agent.effort ? [`effort: ${yamlString(agent.effort)}`] : []),
    '---',
  ];

  return [
    ...frontmatter,
    '',
    `# ${agent.name}`,
    '',
    description,
    '',
    ...(standalone
      ? [
          agent.systemPrompt.trim(),
          '',
          // 子智能体没有自己的 CLAUDE.md，等待语义只能写在它自己的 md 里。
          '你是被父智能体同步调用的：直接执行任务并返回最终文本。',
          '不要再委派给其他智能体（`Agent`/`TaskStop` 已禁用）。',
          ...(agent.timeoutMs
            ? [`父智能体最多等你 ${Math.round(agent.timeoutMs / 1000)} 秒，超时本次委派即失败。`]
            : []),
          '',
        ]
      : [
          hasSubAgents
            ? '完整系统提示见 `CLAUDE.md`；需要时用 `Agent` 工具委派给 `CLAUDE.md` 中列出的子智能体。'
            : '完整系统提示见 `CLAUDE.md`。',
          '',
        ]),
  ].join('\n');
}

export function renderSkillMd(skill: WorkspaceSkill): string {
  return [
    '---',
    `name: ${yamlString(skill.slug)}`,
    `description: ${yamlString(skill.description)}`,
    '---',
    '',
    `# ${skill.name}`,
    '',
    skill.body.trim(),
    '',
  ].join('\n');
}

/** 把 DB 中的智能体定义渲染成落盘文件的内容；纯函数，不碰文件系统。 */
export function renderWorkspace(input: WorkspaceInput): WorkspaceFiles {
  const mcpServers: Record<string, McpJsonEntry> = {};
  for (const server of input.servers) {
    mcpServers[server.name] = server.entry;
  }

  // 技能按 slug 去重：根智能体在前，子智能体按序补齐，先出现者胜。
  const allSkills = new Map<string, WorkspaceSkill>();
  for (const skill of [
    ...(input.skills ?? []),
    ...(input.subAgents ?? []).flatMap((subAgent) => subAgent.skills ?? []),
  ]) {
    if (!allSkills.has(skill.slug)) allSkills.set(skill.slug, skill);
  }

  return {
    mcpJson: `${JSON.stringify({ mcpServers }, null, 2)}\n`,
    claudeMd: renderClaudeMd(input),
    agentMd: renderAgentMd(input),
    skills: [...allSkills.values()].map((skill) => ({
      slug: skill.slug,
      content: renderSkillMd(skill),
      files: skill.files ?? [],
    })),
    subAgents: (input.subAgents ?? []).map((subAgent) => ({
      slug: subAgent.slug,
      content: renderAgentMd(
        {
          agent: subAgent,
          servers: input.servers,
          skills: subAgent.skills ?? [],
          ...(subAgent.allowedTools && subAgent.allowedTools.length > 0
            ? { toolsAllow: subAgent.allowedTools }
            : {}),
          ...(subAgent.disallowedTools && subAgent.disallowedTools.length > 0
            ? { toolsDeny: subAgent.disallowedTools }
            : {}),
        },
        true,
      ),
    })),
    rules: (input.rules ?? []).map((rule) => ({
      slug: rule.slug,
      content: renderRuleMd(rule),
    })),
    outputStyles: (input.outputStyles ?? []).map((style) => ({
      slug: style.slug,
      content: renderOutputStyleMd(style),
    })),
    selectedOutputStyle: input.selectedOutputStyle ?? null,
    settingsJson: input.selectedOutputStyle
      ? `${JSON.stringify({ outputStyle: input.selectedOutputStyle }, null, 2)}\n`
      : null,
  };
}
