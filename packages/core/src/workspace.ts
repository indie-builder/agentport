import {
  type AgentInput,
  agentHookFilePathSchema,
  agentHooksConfigSchema,
  DEFAULT_MEMORY_POLICY,
  disallowedToolsFor,
  displayNameSchema,
  type McpJsonArtifactEntry,
  MEMORY_CONTAINER_DIR,
  type MemoryPolicy,
  memoryWritable,
  type OpenUiToolDescriptor,
  OUTPUTS_CONTAINER_DIR,
  type PreviewMcpJsonArtifactEntry,
  SANDBOX_RUNTIME_ENV,
  slugSchema,
  type WorkspaceFiles,
} from '@agentport/shared';
import { fail } from './errors.js';
import {
  CHILD_AGENT_FRONTMATTER_KEYS,
  escapeGeneratedBoundaryLines,
  GENERATED_SUFFIX_END,
  GENERATED_SUFFIX_START,
} from './official-files.js';
import { openuiSystemPrompt } from './openui-prompt.js';
import type { SkillProvenance } from './skill-md.js';

export type { WorkspaceFiles };

export interface WorkspaceAgent {
  slug: string;
  name: string;
  description?: string;
  model: string;
  systemPrompt: string;
  maxTurns: number;
  permissionMode?: AgentInput['permissionMode'];
  uiFormat?: AgentInput['uiFormat'];
  effort?: AgentInput['effort'] | null;
  allowedTools?: string[];
  disallowedTools?: string[];
  serverNames?: string[];
  skills?: WorkspaceSkill[];
}

export interface WorkspaceSkill extends SkillProvenance {
  slug: string;
  name: string;
  description: string;
  body: string;
  files?: Array<{ path: string; content: string }>;
}

export interface WorkspaceInput<
  TEntry extends McpJsonArtifactEntry | PreviewMcpJsonArtifactEntry = McpJsonArtifactEntry,
> {
  agent: WorkspaceAgent;
  servers: Array<{ name: string; entry: TEntry }>;
  skills?: WorkspaceSkill[];
  subAgents?: WorkspaceAgent[];
  workflows?: Array<{ slug: string; content: string }>;
  rules?: Array<{ slug: string; content: string; globs?: string }>;
  outputStyles?: Array<{
    slug: string;
    description: string;
    keepCodingInstructions: boolean;
    body: string;
  }>;
  selectedOutputStyle?: string | null;
  hooks?: Record<string, unknown> | null;
  hookFiles?: Array<{ path: string; content: string; executable: boolean }>;
  plugins?: WorkspacePlugin[];
  toolsAllow?: string[];
  toolsDeny?: string[];
  openuiTools?: OpenUiToolDescriptor[];
  memoryPolicy?: MemoryPolicy;
}

export interface WorkspacePlugin {
  slug: string;
  runtimeName: string;
  skillNames: string[];
  mcpServerNames: string[];
  hasAgents: boolean;
  files: Array<{ path: string; content: string; executable: boolean }>;
}

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

function splitGlobs(value: string): string[] {
  const patterns: string[] = [];
  let depth = 0;
  let inBracket = false;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '\\') {
      i++;
      continue;
    }
    if (char === '[') inBracket = true;
    else if (char === ']') inBracket = false;
    else if (!inBracket && char === '{') depth++;
    else if (!inBracket && char === '}') depth = Math.max(0, depth - 1);
    else if (!inBracket && char === ',' && depth === 0) {
      patterns.push(value.slice(start, i));
      start = i + 1;
    }
  }
  patterns.push(value.slice(start));
  return patterns.map((pattern) => pattern.trim()).filter(Boolean);
}

export function renderRuleMd(rule: { slug: string; content: string; globs?: string }): string {
  const globs = splitGlobs(rule.globs ?? '');
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

const DESCRIPTION_MAX = 200;

function assertDisplayName(name: string): void {
  const parsed = displayNameSchema.safeParse(name);
  if (!parsed.success) {
    fail('INVALID_INPUT', `显示名无效：${parsed.error.issues[0]?.message}`, { path: '/name' });
  }
}

function summarize(prompt: string, fallback: string): string {
  const line =
    prompt
      .split('\n')
      .map((l) => l.trim())
      .map((l) => l.replace(/^#+\s*/, ''))
      .find((l) => l.length > 0) ?? fallback;
  return line.length > DESCRIPTION_MAX ? `${line.slice(0, DESCRIPTION_MAX)}…` : line;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function inlineText(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

function yamlList(values: string[]): string {
  return `[${values.map(yamlString).join(', ')}]`;
}

function rootServers<TEntry extends McpJsonArtifactEntry | PreviewMcpJsonArtifactEntry>(
  input: WorkspaceInput<TEntry>,
): WorkspaceInput<TEntry>['servers'] {
  const bound = input.agent.serverNames;
  return bound === undefined ? input.servers : input.servers.filter((s) => bound.includes(s.name));
}

function delegationWaitSection<TEntry extends McpJsonArtifactEntry | PreviewMcpJsonArtifactEntry>(
  input: WorkspaceInput<TEntry>,
): string[] {
  const subAgents = input.subAgents ?? [];
  const lines: string[] = [];

  if (subAgents.length > 0) {
    lines.push(
      '',
      '## 等待规则',
      '',
      '本平台的智能体之间是**同步调用**：调用方发起后要等到被调用方返回，才能继续。',
      '',
      '后台执行已被运行时禁用，`Agent` 调用会一直等到子智能体返回；',
      '如果你提前结束本轮，调用方（用户或其他智能体）拿不到结果。',
      '- 子智能体只返回最终文本。中间的 `tool_start` / `tool_result` 由平台记录，你不需要转述。',
      '- 子智能体受自身 `maxTurns` 限制；整轮委派计入主运行的总超时，主运行超时会中止本轮。',
    );
  }

  if (rootServers(input).length > 0) {
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

const SKILL_REFERENCE_CLAUSE =
  '只读可用 `Read` 打开 `.claude/skills/<slug>/references/` 下的 Markdown。';

function subAgentMemoryClause(policy: MemoryPolicy): string {
  const writable = memoryWritable(policy);
  const capability = writable ? '读写' : '读取';
  const suffix = writable ? '' : '，写入会被拒绝';
  return `已登记的子智能体只允许${capability}自己的 project 记忆（\`.claude/agent-memory/<slug>/\` 内的 Markdown）${suffix}；其他目录与未登记子智能体的原生文件工具请求均被拒绝。`;
}

function memoryAccessLine(policy: MemoryPolicy): string {
  const main = !policy.enabled
    ? `专家记忆已停用：本轮不挂载 \`${MEMORY_CONTAINER_DIR}/\`，不要读取或写入该目录。`
    : policy.writeMode === 'proposal_only'
      ? `主会话只能用 \`Read\` 访问 \`${MEMORY_CONTAINER_DIR}/\` 内的 Markdown 原生记忆；该目录本轮只读，\`Write\`、\`Edit\` 会被拒绝。需要改进记忆时，把建议写进最终回复，由用户或管理员通过记忆提案审核后写入。`
      : `主会话可用 \`Read\`、\`Write\`、\`Edit\` 访问 \`${MEMORY_CONTAINER_DIR}/\` 内的 Markdown 原生记忆；`;
  return `${main}${SKILL_REFERENCE_CLAUSE}${subAgentMemoryClause(policy)}`;
}

function renderClaudeMd<TEntry extends McpJsonArtifactEntry | PreviewMcpJsonArtifactEntry>(
  input: WorkspaceInput<TEntry>,
): string {
  const { agent, skills = [] } = input;
  const servers = rootServers(input);
  const toolsDeny = input.toolsDeny ?? [];
  const bashDenied = toolsDeny.includes('Bash');
  const bashCapability = bashDenied
    ? null
    : toolsDeny.some((tool) => tool.startsWith('Bash('))
      ? '`Bash`（默认启用，受命令级禁用规则约束）'
      : '`Bash`（默认启用，在沙箱容器内执行命令）';
  const toolLines =
    servers.length === 0
      ? [
          skills.length === 0
            ? bashCapability
              ? `当前没有绑定 MCP Server，也没有可用技能；主会话有 ${bashCapability} 与下述原生记忆。`
              : '当前没有绑定 MCP Server，也没有可用技能；主会话不可使用 `Bash`（已被显式禁用），只有下述原生记忆。'
            : `当前没有绑定 MCP Server，你没有 MCP 工具；可用能力只有下方列出的技能、原生记忆${bashCapability ? `与${bashCapability}` : ''}。`,
        ]
      : [
          '本工作区通过 `.mcp.json` 绑定以下 MCP Server：',
          '',
          ...servers.map((s) => `- \`${s.name}\` → 工具名形如 \`mcp__${s.name}__<tool>\``),
          '',
          '以上是主会话绑定的 MCP Server；子智能体只使用各自定义文件中声明的 MCP Server。',
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
          '| slug | 适用场景 | 最大轮次 |',
          '|---|---|---|',
          ...subAgents.map(
            (s) => `| \`${s.slug}\` | ${inlineText(s.description || s.name)} | ${s.maxTurns} |`,
          ),
          '',
          '委派前先读上面的「等待规则」。',
        ];

  const generatedBody = [
    '## 工具使用',
    '',
    ...toolLines,
    ...(subAgents.length > 0
      ? ['', '内置的 `Agent` 工具已启用，仅用于委派给上面的子智能体。']
      : []),
    '',
    `业务能力使用 \`mcp__*\` MCP 工具；${bashCapability ?? '`Bash` 已被显式禁用'}，网络工具仍禁用。`,
    memoryAccessLine(input.memoryPolicy ?? DEFAULT_MEMORY_POLICY),
    `交付给用户的文件写到 \`${OUTPUTS_CONTAINER_DIR}/\`。完成后告诉用户打开右上角「会话成果」即可预览或下载，只用这个叫法。修改已有交付时继续用同一路径覆盖，本轮没有新增或修改的文件不必重写；原生文件工具在目录之外不可写${bashCapability ? '，`Bash` 在容器内执行，可访问容器内已挂载的目录' : ''}。`,
    '如需更多能力，请让管理员在平台中为智能体绑定对应的 MCP Server。',
    '',
    '## 任务清单',
    '',
    '多步骤任务用原生 `TodoWrite` 维护清单，用户会在界面上看到进度。',
    '简单问答或单步操作不需要清单。',
    // dontAsk 下 SDK 直接拒绝提问（见官方权限流程），提示词不能承诺做不到的事。
    ...(agent.permissionMode === 'dontAsk'
      ? []
      : [
          '',
          '## 澄清提问',
          '',
          '目标缺少关键信息、不同选择会明显改变交付结果时，用原生 `AskUserQuestion` 向用户确认（1–4 个问题，每题 2–4 个选项），不要猜测后直接交付。',
          '它只用于澄清需求，不是工具授权；需要批准的副作用仍按上面的等待规则处理。',
        ]),
    ...skillLines,
    ...delegationWaitSection(input),
    ...subAgentLines,
    ...(agent.uiFormat === 'openui'
      ? ['', '## 生成式 UI', '', openuiSystemPrompt(input.openuiTools)]
      : []),
    '',
  ].join('\n');

  return [
    `# ${agent.name}`,
    '',
    agent.systemPrompt.trim(),
    '',
    GENERATED_SUFFIX_START,
    escapeGeneratedBoundaryLines(generatedBody),
    GENERATED_SUFFIX_END,
    '',
  ].join('\n');
}

function renderAgentMd<TEntry extends McpJsonArtifactEntry | PreviewMcpJsonArtifactEntry>(
  input: WorkspaceInput<TEntry>,
  standalone = false,
): string {
  const { agent, servers, skills = [] } = input;
  const bound = agent.serverNames;
  const ownNames = bound ?? servers.map((s) => s.name);
  const ownServers = servers.filter((s) => ownNames.includes(s.name));
  const tools = [
    ...new Set([
      'Bash',
      ...(input.toolsAllow && input.toolsAllow.length > 0
        ? input.toolsAllow
        : ownServers.map((s) => `mcp__${s.name}__*`)),
    ]),
  ];
  const hasSubAgents = (input.subAgents ?? []).length > 0;
  const foreignServers =
    bound === undefined ? [] : servers.filter((s) => !ownNames.includes(s.name));
  const disallowed = [
    ...new Set([
      // 文件工具禁用只留给主定义；子定义靠官方 memory: project 读写自己的记忆目录，
      // 平台默认禁用会覆盖 SDK 对这三个工具的自动启用。用户显式 deny 仍在末尾合并。
      ...disallowedToolsFor({
        allowedTools: input.toolsAllow ?? [],
        allowSubAgents: !standalone && hasSubAgents,
        keepFileTools: standalone,
      }),
      ...foreignServers.map((s) => `mcp__${s.name}`),
      ...(input.toolsDeny ?? []),
    ]),
  ];
  const description =
    agent.description?.trim() || summarize(agent.systemPrompt, `${agent.name} 智能体`);

  const frontmatterValues: Array<[string, string[]]> = [
    ['name', [yamlString(agent.slug)]],
    ['description', [yamlString(description)]],
    ['model', [yamlString(agent.model)]],
    // 子智能体不能声明 tools：SDK 在派生时先按主会话解析这些名字，MCP 工具此时尚未注册，
    // `mcp__<server>__*` 解析为空会被直接拒绝（"would be spawned with zero tools"）。
    // 省略 tools 即继承父会话工具集；子级靠官方 memory: project 读写自己的记忆目录，文件工具不再默认禁用。
    [
      'tools',
      standalone ? [] : [yamlList(hasSubAgents ? [...new Set([...tools, 'Agent'])] : tools)],
    ],
    // project 作用域即工作区内的 .claude/agent-memory/<slug>/，与平台既有记忆目录对应。
    ['memory', standalone ? ['project'] : []],
    // 子级按名字引用根 .mcp.json 的条目：inline 配置在非交互/未信任目录会被跳过。
    [
      'mcpServers',
      standalone && bound !== undefined && ownServers.length > 0
        ? ownServers.map((s) => `  - ${yamlString(s.name)}`)
        : [],
    ],
    ['disallowedTools', [yamlList(disallowed)]],
    ['maxTurns', [`${agent.maxTurns}`]],
    ['skills', skills.length > 0 ? [yamlList(skills.map((s) => s.slug))] : []],
    ['effort', agent.effort ? [yamlString(agent.effort)] : []],
  ];
  const frontmatter = [
    '---',
    ...frontmatterValues.flatMap(([key, values]) =>
      standalone && !CHILD_AGENT_FRONTMATTER_KEYS.has(key)
        ? []
        : values.length === 0
          ? []
          : key === 'mcpServers'
            ? [`${key}:`, ...values]
            : [`${key}: ${values[0]}`],
    ),
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
          GENERATED_SUFFIX_START,
          '你是被父智能体同步调用的：直接执行任务并返回最终文本。',
          '不要再委派给其他智能体（`Agent`/`TaskStop` 已禁用）。',
          '不能向用户提问（`AskUserQuestion` 仅主会话可用）；缺少关键信息时在最终文本里说明，由父智能体决定是否向用户确认。',
          GENERATED_SUFFIX_END,
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

export function renderSubAgentMd(input: {
  agent: WorkspaceAgent;
  servers: Array<{ name: string; entry: McpJsonArtifactEntry | PreviewMcpJsonArtifactEntry }>;
  skills?: WorkspaceSkill[];
}): string {
  assertDisplayName(input.agent.name);
  return renderAgentMd(
    {
      agent: input.agent,
      servers: input.servers,
      skills: input.skills ?? [],
      ...(input.agent.allowedTools && input.agent.allowedTools.length > 0
        ? { toolsAllow: input.agent.allowedTools }
        : {}),
      ...(input.agent.disallowedTools && input.agent.disallowedTools.length > 0
        ? { toolsDeny: input.agent.disallowedTools }
        : {}),
    },
    true,
  );
}

export function renderSkillMd(skill: WorkspaceSkill): string {
  assertDisplayName(skill.name);
  return [
    '---',
    `name: ${yamlString(skill.slug)}`,
    `description: ${yamlString(skill.description)}`,
    ...(skill.license === undefined ? [] : [`license: ${yamlString(skill.license)}`]),
    ...(skill.compatibility === undefined
      ? []
      : [`compatibility: ${yamlString(skill.compatibility)}`]),
    ...(skill.metadata === undefined ? [] : [`metadata: ${JSON.stringify(skill.metadata)}`]),
    '---',
    '',
    `# ${skill.name}`,
    '',
    skill.body.trim(),
    '',
  ].join('\n');
}

export function unionById<T extends { id: string }>(lists: readonly (readonly T[])[]): T[] {
  const out = new Map<string, T>();
  for (const list of lists) for (const item of list) if (!out.has(item.id)) out.set(item.id, item);
  return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function renderWorkspace<
  TEntry extends McpJsonArtifactEntry | PreviewMcpJsonArtifactEntry = McpJsonArtifactEntry,
>(input: WorkspaceInput<TEntry>): WorkspaceFiles {
  assertDisplayName(input.agent.name);
  const mcpServers: Record<string, TEntry> = {};
  for (const server of input.servers) {
    mcpServers[server.name] = server.entry;
  }

  const allSkills = new Map<string, WorkspaceSkill>();
  for (const skill of [
    ...(input.skills ?? []),
    ...(input.subAgents ?? []).flatMap((subAgent) => subAgent.skills ?? []),
  ]) {
    if (!allSkills.has(skill.slug)) allSkills.set(skill.slug, skill);
  }

  const hooks = input.hooks ?? null;
  if (hooks !== null && !agentHooksConfigSchema.safeParse(hooks).success) {
    fail('INVALID_INPUT', 'hooks 配置无效或超过大小上限', { path: '/hooks' });
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
      content: renderSubAgentMd({
        agent: subAgent,
        servers: input.servers,
        ...(subAgent.skills ? { skills: subAgent.skills } : {}),
      }),
    })),
    workflows: (input.workflows ?? []).map((workflow) => {
      if (!slugSchema.safeParse(workflow.slug).success) {
        fail('INVALID_INPUT', `工作流 slug 无效：${workflow.slug}`, { path: '/workflows' });
      }
      return workflow;
    }),
    rules: (input.rules ?? []).map((rule) => ({
      slug: rule.slug,
      content: renderRuleMd(rule),
    })),
    outputStyles: (input.outputStyles ?? []).map((style) => ({
      slug: style.slug,
      content: renderOutputStyleMd(style),
    })),
    selectedOutputStyle: input.selectedOutputStyle ?? null,
    hookFiles: (input.hookFiles ?? []).map((file) => {
      if (!agentHookFilePathSchema.safeParse(file.path).success) {
        fail('INVALID_INPUT', `hook 脚本路径无效：${file.path}`, { path: '/hooks' });
      }
      return file;
    }),
    plugins: (input.plugins ?? []).map((plugin) => ({
      slug: plugin.slug,
      files: plugin.files,
    })),
    settingsJson: `${JSON.stringify(
      {
        env: SANDBOX_RUNTIME_ENV,
        ...(input.selectedOutputStyle ? { outputStyle: input.selectedOutputStyle } : {}),
        ...(hooks !== null && Object.keys(hooks).length > 0 ? { hooks } : {}),
      },
      null,
      2,
    )}\n`,
  };
}
