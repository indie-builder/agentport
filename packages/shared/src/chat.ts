import { z } from 'zod';
import { effortSchema, permissionModeSchema } from './agent.js';
import { ATTACHMENT_LIMITS, chatAttachmentInputsSchema } from './attachments.js';
import { openUiActionSchema } from './openui/protocol.js';
import { outputRefSchema } from './outputs.js';
import { nativeQuestionsSchema, publicRunQuestionSchema } from './questions.js';

/**
 * 官方可移植的 TodoWrite 开关：专家包 `.claude/settings.json` 与沙盒运行时共用这一份值。
 * 导出只带这两项；后台任务、委派深度等沙盒执行约束属于平台，不随定义包迁移。
 */
export const PORTABLE_TODO_ENV = {
  CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
  CLAUDE_CODE_ENABLE_TASKS: '0',
} as const;

/**
 * 沙盒运行时的硬约束：前台执行 + 单层委派。
 * 写进工作区 `.claude/settings.json` 的 env，并由 runner 放进子进程 env；
 * core 渲染文件、sandbox 启动进程共用这一份，避免两处漂移。
 */
export const SANDBOX_RUNTIME_ENV = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
  // 启用原生 TodoWrite（而非四个 Task 工具），平台据此渲染任务进度。
  ...PORTABLE_TODO_ENV,
} as const;

/**
 * shared 不带 Node/DOM lib；按码点手算 UTF-8 字节数，与 TextEncoder 结果一致，
 * 浏览器与 Node 都能用。这里校验的是编码后的字节，不是字符串长度。
 */
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export const chatRequestSchema = z
  .object({
    agentId: z.string(),
    conversationId: z.string().optional(),
    // 沙盒把 prompt 走 stdin，超大输入会拖垮 worker；按 UTF-8 字节统一限制为 64KiB。
    message: z
      .string()
      .refine(
        (value) => utf8Bytes(value) <= ATTACHMENT_LIMITS.messageBytes,
        `消息超过 ${ATTACHMENT_LIMITS.messageBytes / 1024} KiB（UTF-8 编码）`,
      )
      .nullable(),
    /** 本次随消息上传的附件；数据只在这里出现，落库后仅保留元数据。 */
    attachments: chatAttachmentInputsSchema.optional(),
    /**
     * 生成式 UI 的动作上下文：按钮点击额外带回表单值与隐藏上下文。
     * 形状与 `openUiActionSchema` 一致（含 `type`），前后端只认这一份定义。
     * `message` 仍是展示与落库的用户文本。
     */
    openuiAction: openUiActionSchema.optional(),
    /**
     * 「基于此版本修改」：用户选中的已发布快照文件随消息持久化。
     * 归属校验与草稿复制在 API/worker 侧完成，队列格式不变。
     */
    output: outputRefSchema.optional(),
  })
  // 字段名拼错必须报错：这条请求体曾因 strip 模式静默丢掉动作值。
  .strict()
  // 正文与附件至少一项；附件与 openuiAction 的互斥需要 API 结合动作语义判断。
  .refine(
    (value) =>
      (value.message !== null && value.message.trim().length > 0) ||
      (value.attachments?.length ?? 0) > 0,
    { message: '消息正文或附件至少提供一项', path: ['message'] },
  );

export type ChatRequest = z.infer<typeof chatRequestSchema>;

/** 原生 TodoWrite 的一项；状态即模型自己维护的生命周期。 */
export const progressTodoSchema = z.object({
  content: z.string(),
  activeForm: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
});

export type ProgressTodo = z.infer<typeof progressTodoSchema>;

/** SSE 事件：前端按 `type` 分派。 */
export const chatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run_started'), runId: z.string(), conversationId: z.string() }),
  z.object({
    type: z.literal('replay_truncated'),
    reason: z.enum(['retention', 'bytes', 'terminal_missing']),
  }),
  /**
   * 助手消息内的内容块边界：一个 SDK assistant 消息可以有多块文本/工具，
   * 前端按 blockIndex 分段渲染，不再把整条消息拼成一个文本块。
   */
  z.object({
    type: z.literal('assistant_block_start'),
    blockIndex: z.number().int().nonnegative(),
    kind: z.enum(['text', 'tool_use']),
    sdkUuid: z.string().optional(),
    parentToolUseId: z.string().optional(),
    /**
     * 运行内稳定的块身份。`blockIndex` 会被后续 SDK 消息重用，
     * 前端对齐实时流必须用这个；缺省表示旧版 runner。
     */
    streamBlockId: z.string().optional(),
  }),
  z.object({
    type: z.literal('assistant_block_stop'),
    blockIndex: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('text_delta'),
    text: z.string(),
    blockIndex: z.number().int().nonnegative().optional(),
    sdkUuid: z.string().optional(),
    parentToolUseId: z.string().optional(),
    streamBlockId: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool_start'),
    toolUseId: z.string(),
    name: z.string(),
    /** SDK 消息 uuid；落库后可用于按历史点 fork。 */
    sdkUuid: z.string().optional(),
    parentToolUseId: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool_input'),
    toolUseId: z.string(),
    json: z.string(),
    parentToolUseId: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool_result'),
    toolUseId: z.string(),
    content: z.string(),
    /**
     * 该工具调用确认后的完整任务清单快照。省略表示本事件不改清单，
     * 空数组表示清空；出现时整体替换，不做增量合并。
     */
    todos: z.array(progressTodoSchema).optional(),
    sdkUuid: z.string().optional(),
    parentToolUseId: z.string().optional(),
  }),
  /** 已完成的 assistant 文本块；用于落库，前端可与 text_delta 去重。 */
  z.object({
    type: z.literal('assistant_text'),
    text: z.string(),
    /** SDK assistant 消息 uuid，落库后作为消息身份。 */
    sdkUuid: z.string().optional(),
    /** 子智能体产生的文本：父侧 Agent 的 tool_use id。 */
    parentToolUseId: z.string().optional(),
    /** 该块在助手消息中的位置；缺省表示旧 runner（整条消息一个块）。 */
    blockIndex: z.number().int().nonnegative().optional(),
    /** 运行内稳定的块身份；与 text_delta 的同名字段一致。 */
    streamBlockId: z.string().optional(),
    /** 超过单块上限被截断：text 是已保留的前缀，不是完整内容。 */
    truncated: z.boolean().optional(),
  }),
  /** 原生 AskUserQuestion 请求：先落库成 RunQuestion，再推给界面。 */
  z.object({
    type: z.literal('question_requested'),
    requestId: z.string(),
    toolUseId: z.string(),
    questions: nativeQuestionsSchema,
  }),
  /** 问题已被关闭（取消/超时/失败）；只发标识，完整记录走 question_updated。 */
  z.object({ type: z.literal('question_closed'), requestId: z.string() }),
  /** 问题的完整快照：worker 落库后推给 SSE 与历史。 */
  z.object({ type: z.literal('question_updated'), question: publicRunQuestionSchema }),
  /**
   * 按历史点 fork 完成，新会话 id 已产生。新旧 uuid 映射由 worker 从宿主
   * transcript 的 `forkedFrom` 字段计算，不经事件传输（避免体积与条数上限）。
   */
  z.object({
    type: z.literal('session_forked'),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal('run_finished'),
    status: z.enum(['succeeded', 'failed', 'cancelled', 'timeout']),
    /**
     * 本轮助手文本块落库后的消息信息（按块序号）。前端用它回填流式项，
     * 之后的表单状态与 Query/Mutation 才有可归属的消息。
     * - `streamBlockId` 与流式事件同名字段对齐；
     * - `uiProgram` 是该消息合并后的完整混合文本，终态直接渲染它；
     * - `uiFormat/uiState` 让实时项立刻拿到与历史消息相同的字段。
     */
    messageIds: z
      .array(
        z.object({
          id: z.string(),
          blockIndex: z.number(),
          streamBlockId: z.string().optional(),
          parentToolUseId: z.string().optional(),
          uiFormat: z.enum(['markdown', 'openui']).optional(),
          uiProgram: z.string().nullable().optional(),
          uiState: z.unknown().optional(),
        }),
      )
      .optional(),
    costUsd: z.number().optional(),
    turns: z.number().optional(),
    sessionId: z.string().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    error: z.string().optional(),
    /** 失败分类，由沙盒 runner 给出；成功时缺省。宿主据此决定是否重试。 */
    failureKind: z.enum(['agent', 'infra', 'cancelled']).optional(),
  }),
  z.object({ type: z.literal('run_unavailable'), message: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);

export type ChatEvent = z.infer<typeof chatEventSchema>;

/** 事件里的失败分类只有三档；sandbox 与 timeout 都归入不可重试的服务端失败。 */
export function wireFailureKind(
  reason: 'cancelled' | 'timeout' | 'sandbox' | 'agent' | 'infra',
): 'agent' | 'infra' | 'cancelled' {
  if (reason === 'cancelled') return 'cancelled';
  if (reason === 'infra') return 'infra';
  return 'agent';
}

/**
 * BullMQ job 载荷，producer 与 consumer 共用。
 * 只传标识与本次用户输入；当前会话的 resume/fork 状态由 worker 从 DB 读取，
 * 队列消息不携带历史文本，避免重试时用陈旧上下文覆盖已落库的会话。
 */
export const agentRunJobSchema = z.object({
  runId: z.string(),
  agentId: z.string(),
  conversationId: z.string(),
  prompt: z.string(),
});

export type AgentRunJob = z.infer<typeof agentRunJobSchema>;

/** 沙盒任务：宿主 → runner 的唯一输入，runner 不再自造 schema。 */
export const sandboxTaskSchema = z
  .object({
    prompt: z.string(),
    model: z.string(),
    maxTurns: z.number().int().positive(),
    maxBudgetUsd: z.number().positive(),
    permissionMode: permissionModeSchema.optional(),
    /** 本会话可用的 MCP server 名（父级自己绑定的）。 */
    mcpServers: z.array(z.string()).default([]),
    /** 主会话可用的技能 slug；子智能体技能由它自己的 frontmatter 声明。 */
    skills: z.array(z.string()).default([]),
    /** 父级显式放行的额外工具（allowedTools）。 */
    extraAllowedTools: z.array(z.string()).default([]),
    /** 父级额外禁用的工具；子级不会继承这一项。 */
    extraDisallowedTools: z.array(z.string()).default([]),
    effort: effortSchema.optional(),
    /** 有启用的子智能体时为真：主会话放行 Agent/TaskStop。 */
    allowSubAgents: z.boolean().default(false),
    /**
     * 单个文本/工具字段的字节上限，缺省 1MiB。超限只截断该块并带上 truncated 标记，
     * 不再静默丢尾部；宿主可按沙盒资源上限收紧或放宽。
     */
    maxFieldBytes: z.number().int().positive().optional(),
    /**
     * 本次运行加载的插件根；runner 直接传给 SDK `plugins`。
     * `skills` 是插件内的技能目录名，runner 拼成 `<runtimeName>:<技能>` 追加进 `skills`；
     * `mcpServers` 只在绑定处授权后才出现，runner 生成 `mcp__plugin_<p>_<s>__*` 规则。
     */
    plugins: z
      .array(
        z.object({
          /** 容器内绝对路径，如 `/workspace/.claude/plugins/<slug>`。 */
          path: z.string().min(1),
          runtimeName: z.string().min(1),
          skills: z.array(z.string()).default([]),
          mcpServers: z.array(z.string()).default([]),
          hasAgents: z.boolean().default(false),
        }),
      )
      .default([]),
    /**
     * 子智能体的绑定：runner 据此在 PreToolUse 里拒绝越界的 MCP 工具与技能。
     * 官方 frontmatter 只能预加载技能、按名引用 server，运行时边界由这里补齐。
     */
    subAgents: z
      .array(
        z.object({
          slug: z.string(),
          servers: z.array(z.string()).default([]),
          skills: z.array(z.string()).default([]),
        }),
      )
      .default([]),
    /**
     * 要恢复的 SDK session。缺省表示空会话：不 resume，直接发首条消息。
     * transcript 文件缺失时 runner 报 infra，不回退成文本历史。
     */
    resumeSessionId: z.string().optional(),
    /** 本次用户消息的 SDK uuid；与页面上的消息一一对应，用于后续按点 fork。 */
    userMessageUuid: z.uuid(),
    /**
     * 按历史点分支：先在该会话内 fork 到指定 SDK 消息 uuid，再从新会话继续。
     * 与 resumeSessionId 同时出现；fork 结果写回会话行。
     */
    forkFromMessageUuid: z.uuid().optional(),
  })
  .strict();

export type SandboxTask = z.infer<typeof sandboxTaskSchema>;
/** 宿主侧构造的形状：默认值由 runner 解析时补齐。 */
export type SandboxTaskInput = z.input<typeof sandboxTaskSchema>;

export const RUNS_QUEUE = 'agent-runs';

/** 评估跑批队列：只传 id，worker 自己读用例，避免 API 重启丢失进程内状态。 */
export const EVAL_RUNS_QUEUE = 'eval-runs';

export const evalRunJobSchema = z.object({ evalRunId: z.string() });

export type EvalRunJob = z.infer<typeof evalRunJobSchema>;

/** 最小判定：expectation 非空则大小写不敏感包含；为空则只要求有文本。 */
export function judge(output: string, expectation: string): boolean {
  if (expectation.trim().length === 0) return output.trim().length > 0;
  return output.toLowerCase().includes(expectation.trim().toLowerCase());
}

export const conversationRenameSchema = z.object({
  title: z.string().trim().min(1).max(128),
});

/** 会话列表项：按 agent 过滤，按最近消息倒序。 */
export const conversationSummarySchema = z.object({
  id: z.string(),
  agentId: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastMessage: z
    .object({ role: z.string(), text: z.string(), createdAt: z.string() })
    .nullable()
    .default(null),
});

export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

/** 会话对外公开的四字段：SDK 续聊状态、归属与分支内部列都不上 wire。 */
export const publicConversationSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  title: z.string(),
  createdAt: z.string(),
});

export type PublicConversation = z.infer<typeof publicConversationSchema>;

/** 分支响应只额外公开来源关系；fork 状态与 SDK session 仍是内部列。 */
export const conversationBranchSchema = publicConversationSchema.extend({
  parentId: z.string().nullable(),
  branchOfMessageId: z.string().nullable(),
});

export type ConversationBranch = z.infer<typeof conversationBranchSchema>;

/** 会话详情中的单条消息。 */
export const conversationMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: z.string(),
  content: z.unknown(),
  runId: z.string().nullable().default(null),
  createdAt: z.string(),
  /**
   * 生成该消息时的回复格式快照。历史按消息自身渲染，
   * 不随智能体之后切换 `uiFormat` 变化。
   */
  uiFormat: z.enum(['markdown', 'openui']).default('markdown'),
  /** editMode 合并后的完整 OpenUI 程序；为空时从 content 的围栏提取。 */
  uiProgram: z.string().nullable().default(null),
  /** UI 段的表单/绑定快照：`{ version: 1, blocks: { [blockKey]: state } }`。 */
  uiState: z.unknown().nullable().default(null),
});

export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

/** 一条消息所属运行的读数；只含前端读数行需要的字段。 */
export const conversationRunMetricsSchema = z.object({
  runId: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout']),
  turns: z.number().nullable().default(null),
  durationMs: z.number().nullable().default(null),
  /** 结束时刻；历史轮次用它标出「这轮是什么时候跑完的」。 */
  endedAt: z.string().nullable().default(null),
  tokens: z.number().nullable().default(null),
  costUsd: z.number().nullable().default(null),
  error: z.string().nullable().default(null),
});

export type ConversationRunMetrics = z.infer<typeof conversationRunMetricsSchema>;

export const conversationDetailSchema = z.object({
  conversation: publicConversationSchema,
  messages: z.array(conversationMessageSchema),
  /** 本页消息涉及的 run 读数，按 runId 索引；前端用它给每条历史回复补上读数行。 */
  runMetrics: z.array(conversationRunMetricsSchema).default([]),
  nextBefore: z.string().nullable(),
});

export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

/** 全局历史搜索：q 去空白后 0..200 字；空查询按最近活动返回。 */
export const conversationSearchQuerySchema = z.object({
  q: z.string().trim().max(200).default(''),
  agentId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.string().min(1).optional(),
});

export type ConversationSearchQuery = z.infer<typeof conversationSearchQuerySchema>;

export const conversationSearchMatchSchema = z.object({
  kind: z.enum(['id', 'title', 'message']),
  excerpt: z.string().nullable(),
});

export type ConversationSearchMatch = z.infer<typeof conversationSearchMatchSchema>;

/** 每个会话最多一项；同一会话同时命中多处时按 id → title → message 取优先级最高的一项。 */
export const conversationSearchItemSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  title: z.string(),
  /** 会话活动时间（last_message_at）的 ISO 字符串。 */
  updatedAt: z.string(),
  match: conversationSearchMatchSchema.nullable(),
});

export type ConversationSearchItem = z.infer<typeof conversationSearchItemSchema>;

export const conversationSearchResponseSchema = z.object({
  items: z.array(conversationSearchItemSchema),
  nextBefore: z.string().nullable(),
});

export type ConversationSearchResponse = z.infer<typeof conversationSearchResponseSchema>;
