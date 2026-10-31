import { type OpenUiToolDescriptor, SANDBOX_RUNTIME_ENV } from '@agentport/shared';
import {
  escapeGeneratedBoundaryLines,
  GENERATED_SUFFIX_END,
  GENERATED_SUFFIX_START,
} from './official-files.js';
import { openuiSystemPrompt } from './openui-prompt.js';
import type { SkillProvenance } from './skill-md.js';
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
  /**
   * 插件根目录树：渲染到 `.claude/plugins/<slug>/<path>`，运行时整目录交给 SDK `plugins`。
   * 只含本次运行要加载的插件（受绑定的 hooks/MCP 授权过滤）。
   */
  plugins: Array<{
    slug: string;
    files: Array<{ path: string; content: string; executable: boolean }>;
  }>;
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
  /** 'openui' 时系统提示词追加生成式 UI 段；缺省按 markdown。 */
  uiFormat?: string;
  effort?: string | null;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** 该智能体自己绑定的 MCP server 名；缺省视为全部（预览等单一视角）。 */
  serverNames?: string[];
  /** 子智能体的技能；父智能体只声明自己的，子技能仅供子智能体原生加载。 */
  skills?: WorkspaceSkill[];
  /** 独立运行超时；作为子智能体被委派时由主运行总超时约束。 */
  timeoutMs?: number;
}

export interface WorkspaceSkill extends SkillProvenance {
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
  /** 本次运行要加载的插件；调用方已按绑定授权过滤完 hooks/MCP。 */
  plugins?: WorkspacePlugin[];
  toolsAllow?: string[];
  toolsDeny?: string[];
  /** 生成式 UI 可调用的工具；必须与执行桥的工具目录同源，提示词里没有的调用一律拒绝。 */
  openuiTools?: OpenUiToolDescriptor[];
}

/** 插件的已授权形态：文件树已按授权裁剪，manifest 未授权组件不会再出现在里面。 */
export interface WorkspacePlugin {
  slug: string;
  /** SDK 看到的插件名，技能命名空间 `plugin:<runtimeName>`。 */
  runtimeName: string;
  /** 插件技能在本插件内的目录名（不含 `plugin:` 前缀）。 */
  skillNames: string[];
  /** 已授权 MCP server 的原始名（不含 `plugin:<plugin>:` 前缀）。 */
  mcpServerNames: string[];
  hasAgents: boolean;
  files: Array<{ path: string; content: string; executable: boolean }>;
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

/** 只在顶层逗号拆分 glob；花括号、方括号与反斜杠转义内的逗号属于同一个模式。 */
function splitGlobs(value: string): string[] {
  const patterns: string[] = [];
  let depth = 0;
  let inBracket = false;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    // 转义只影响下一个字符：既不是分隔符，也不改变括号深度。
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

/** 渲染一条规则文件：有 globs 时写入 frontmatter 的 paths；否则纯 Markdown。 */
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

/**
 * 未显式启用的内置工具默认禁用。Bash 不在此列：运行时默认在沙箱容器内放行。
 * 限制靠裸工具名从上下文移除；allowedTools 只负责自动批准，不负责限制。
 */
export const DEFAULT_DISALLOWED_TOOLS = [
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

/** 子定义声明 memory: project 后，SDK 会用这三个工具读写自己的记忆目录。 */
const SUBAGENT_FILE_TOOLS = new Set(['Read', 'Write', 'Edit']);

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

/** 根会话绑定的 server；undefined 保持单视角默认（全部），显式 [] 表示根无绑定。 */
function rootServers(input: WorkspaceInput): WorkspaceInput['servers'] {
  const bound = input.agent.serverNames;
  return bound === undefined ? input.servers : input.servers.filter((s) => bound.includes(s.name));
}

/**
 * 智能体间沟通的等待语义。
 *
 * 平台里只有三种形式，调用方都必须等到对方给出结果：
 * 1. 委派给子智能体（Agent 工具）
 * 2. 调用平台内其他智能体（/mcp 暴露的 run_<slug> 工具）
 * 3. 调用外部 HTTP→MCP 工具（可能需要人工审批，批准前调用方挂起）
 *
 * 「必须等待」由运行时 env 保证（见 shared 的 SANDBOX_RUNTIME_ENV：
 * 关闭后台任务、限制委派深度），因此不再要求模型逐次传 run_in_background。
 */
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

function renderClaudeMd(input: WorkspaceInput): string {
  const { agent, skills = [] } = input;
  const servers = rootServers(input);
  const toolsDeny = input.toolsDeny ?? [];
  const bashDenied = toolsDeny.includes('Bash');
  // 命令级 deny（如 `Bash(rm:*)`）只限制具体命令，Bash 本身仍可用。
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

  // 生成区只能由渲染器自己的边界行界定；外来多行文本里的同名行统一在这里消除。
  const generatedBody = [
    '## 工具使用',
    '',
    ...toolLines,
    ...(subAgents.length > 0
      ? ['', '内置的 `Agent` 工具已启用，仅用于委派给上面的子智能体。']
      : []),
    '',
    `业务能力使用 \`mcp__*\` MCP 工具；${bashCapability ?? '`Bash` 已被显式禁用'}，网络工具仍禁用。`,
    '主会话可用 `Read`、`Write`、`Edit` 访问 `/mnt/agent-memory/` 内的 Markdown 原生记忆；只读可用 `Read` 打开 `.claude/skills/<slug>/references/` 下的 Markdown。已登记的子智能体只允许读写自己的 project 记忆（`.claude/agent-memory/<slug>/` 内的 Markdown）；其他目录与未登记子智能体的原生文件工具请求均被拒绝。',
    `交付给用户的文件写到 \`/mnt/outputs/\`。完成后告诉用户打开右上角「会话成果」即可预览或下载，只用这个叫法。修改已有交付时继续用同一路径覆盖，本轮没有新增或修改的文件不必重写；原生文件工具在目录之外不可写${bashCapability ? '，`Bash` 在容器内执行，可访问容器内已挂载的目录' : ''}。`,
    '如需更多能力，请让管理员在平台中为智能体绑定对应的 MCP Server。',
    '',
    '## 任务清单',
    '',
    '多步骤任务（三步以上）用原生 `TodoWrite` 维护清单：每项写 `content` 与进行中的 `activeForm`，完成一步就更新状态，用户会在界面上看到进度。',
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

/** standalone：子智能体文件没有自己的 CLAUDE.md，正文直接放系统提示。 */
function renderAgentMd(input: WorkspaceInput, standalone = false): string {
  const { agent, servers, skills = [] } = input;
  // serverNames 缺省时保持调用方默认：input.servers 全部可见、不显式拒绝；
  // 给出数组则把可见范围限定到该智能体自身绑定的 server，并显式拒绝其余。
  const bound = agent.serverNames;
  const ownNames = bound ?? servers.map((s) => s.name);
  const ownServers = servers.filter((s) => ownNames.includes(s.name));
  // Bash 由运行时默认放行；预览白名单必须与运行一致，即使智能体配置了自己的 allow 列表。
  const tools = [
    ...new Set([
      'Bash',
      ...(input.toolsAllow && input.toolsAllow.length > 0
        ? input.toolsAllow
        : ownServers.map((s) => `mcp__${s.name}__*`)),
    ]),
  ];
  const hasSubAgents = (input.subAgents ?? []).length > 0;
  // 智能体可显式放行 ListAgents/SendMessage（D-19）；其余默认项不能通过配置解除。
  const allowedByConfig = new Set(input.toolsAllow ?? []);
  const mayEnable = (tool: string): boolean =>
    tool === 'Agent' || tool === 'TaskStop'
      ? hasSubAgents
      : tool === 'ListAgents' || tool === 'SendMessage'
        ? allowedByConfig.has(tool)
        : false;
  // 工作区 .mcp.json 是父 + 启用子级的并集；不绑定的 server 必须显式拒绝，
  // 否则 dontAsk 下这些工具仍出现在上下文里，等于把子级工具隐式放行给父级。
  const foreignServers =
    bound === undefined ? [] : servers.filter((s) => !ownNames.includes(s.name));
  // 单层委派：有子智能体时放行 Agent/TaskStop，与 runner 的 options 保持一致；
  // 子智能体本身不传 subAgents，因此仍被禁用，无法继续向下委派。
  const disallowed = [
    ...new Set([
      // 文件工具禁用只留给主定义；子定义靠官方 memory: project 读写自己的记忆目录，
      // 平台默认禁用会覆盖 SDK 对这三个工具的自动启用。用户显式 deny 仍在末尾合并。
      ...DEFAULT_DISALLOWED_TOOLS.filter(
        (tool) => !mayEnable(tool) && !(standalone && SUBAGENT_FILE_TOOLS.has(tool)),
      ),
      // 子智能体的单层约束由这里兜底：API 只拦两层父子，
      // 手工把文件放回 .claude/agents/ 时也必须无法再委派。
      ...(standalone ? ['Agent', 'TaskStop'] : []),
      ...foreignServers.map((s) => `mcp__${s.name}`),
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
    // 省略 tools 即继承父会话工具集；子级靠官方 memory: project 读写自己的记忆目录，文件工具不再默认禁用。
    ...(standalone
      ? []
      : [`tools: ${yamlList(hasSubAgents ? [...new Set([...tools, 'Agent'])] : tools)}`]),
    // project 作用域即工作区内的 .claude/agent-memory/<slug>/，与平台既有记忆目录对应。
    ...(standalone ? ['memory: project'] : []),
    // 子级按名字引用根 .mcp.json 的条目：inline 配置在非交互/未信任目录会被跳过。
    ...(standalone && bound !== undefined && ownServers.length > 0
      ? ['mcpServers:', ...ownServers.map((s) => `  - ${yamlString(s.name)}`)]
      : []),
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
          // 子智能体没有自己的 CLAUDE.md；固定等待语义属于生成后缀，不能混进用户正文。
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

/**
 * 子智能体文件（`.claude/agents/<slug>.md`）。导出专家包时停用的子定义也要落文件，
 * 因此不能只依赖 renderWorkspace 的启用过滤。
 * 子级 allowedTools 不作为 `tools:` 白名单：SDK 在派生时解析不到 MCP 名字会直接拒绝；
 * 它仍用于显式放行 ListAgents/SendMessage 与生成 disallowedTools 的差集。
 */
export function renderSubAgentMd(input: {
  agent: WorkspaceAgent;
  servers: Array<{ name: string; entry: McpJsonEntry }>;
  skills?: WorkspaceSkill[];
}): string {
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

/**
 * 绑定并集：按 id 去重后全局排序。预览、导出与运行各自拿到分组顺序，
 * 不在这里统一就会写出不同顺序的 .mcp.json；三者共用这一处。
 */
export function unionById<T extends { id: string }>(lists: readonly (readonly T[])[]): T[] {
  const out = new Map<string, T>();
  for (const list of lists) for (const item of list) if (!out.has(item.id)) out.set(item.id, item);
  return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
      content: renderSubAgentMd({
        agent: subAgent,
        servers: input.servers,
        ...(subAgent.skills ? { skills: subAgent.skills } : {}),
      }),
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
    plugins: (input.plugins ?? []).map((plugin) => ({
      slug: plugin.slug,
      files: plugin.files,
    })),
    settingsJson: `${JSON.stringify(
      {
        env: SANDBOX_RUNTIME_ENV,
        ...(input.selectedOutputStyle ? { outputStyle: input.selectedOutputStyle } : {}),
      },
      null,
      2,
    )}\n`,
  };
}
