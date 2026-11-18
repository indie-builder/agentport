import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpJsonEntry, WorkspacePlugin, WorkspaceSkill } from '@agentport/core';
import {
  captureOutputDraft,
  hashMcpToken,
  RunFailure,
  toOutputStyleSelection,
  toRuleEntries,
  toWorkflowEntries,
} from '@agentport/core';
import { runScopedLogger } from '@agentport/core/logger';
import { resolveWorkspaceMemoryPolicy } from '@agentport/core/workspace-input';
import { type createDb, repo, schema } from '@agentport/db';
import {
  type Agent,
  type AgentDefinition,
  type AgentDefinitionServer,
  agentRunJobSchema,
  effortSchema,
  errorText,
  isActiveRunStatus,
  type MemoryPolicy,
  messageAttachments,
  permissionModeSchema,
  type SandboxTaskInput,
  wireFailureKind,
} from '@agentport/shared';
import type { Job } from 'bullmq';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import type { Logger } from 'pino';
import { publishChannelEventSafely } from '../channels/channel-events.js';
import type { Config } from '../config.js';
import { executeMemoryReview } from '../memory/memory-review.js';
import {
  personalMemoryBusinessIdForRun,
  projectPersonalMemory,
} from '../memory/personal-memory.js';
import {
  type PersistedChannelMessage,
  type PersistedMessage,
  persistRunMessages,
} from '../messages.js';
import type { ModelProxy } from '../model-proxy.js';
import {
  acquireSessionSandbox,
  isRetryable,
  publishRun,
  runInSandbox,
  type SandboxRunOutcome,
} from '../runner-client.js';
import type { SessionSandboxes, SessionSandboxLease } from '../sandbox/sessions.js';
import { memoryMountFor } from '../sandbox/sessions.js';
import { loadRunServerBindings } from '../server-bindings.js';
import {
  ensureSessionWorkspace,
  refreshSessionDirectory,
  toHostWorkspacePath,
} from '../session-workspace.js';
import { promptWithAttachments } from './attachments.js';
import { readForkUuidMap } from './fork-uuids.js';
import { promptWithOpenUiAction } from './openui-action.js';
import {
  lastMessageIdOfRun,
  prepareRunOutputs,
  promptWithSelectedOutput,
  publishRunOutputsIfSettled,
  recordOutputSandboxSettlement,
  selectedOutput,
} from './outputs.js';
import {
  checkQueuedAgentActive,
  checkQueuedRunAccess,
  type RunAccessDenial,
  runExecutionSubject,
} from './run-access.js';
import {
  finalizeRun,
  handOffPendingFinish,
  publishRunFinished,
  type RunFinishedEvent,
} from './run-finish.js';

type Db = ReturnType<typeof createDb>['db'];
type ServerRow = AgentDefinitionServer;
type AgentRow = typeof schema.agents.$inferSelect;
type SubAgentRow = AgentRow & { skills?: WorkspaceSkill[] };

function applyAgentDefinition(definition: AgentDefinition): AgentRow {
  const { agent } = definition;
  return {
    id: agent.id,
    slug: agent.slug,
    parentId: agent.parentId,
    enabled: agent.enabled,
    createdBy: agent.createdBy,
    ownerBusinessId: agent.ownerBusinessId,
    isDefault: agent.isDefault,
    visibility: agent.visibility ?? 'private',
    tags: agent.tags ?? [],
    publishedVersion: agent.publishedVersion ?? null,
    publishedAt: agent.publishedAt == null ? null : new Date(agent.publishedAt),
    archivedAt: agent.archivedAt == null ? null : new Date(agent.archivedAt),
    deletedAt: agent.deletedAt == null ? null : new Date(agent.deletedAt),
    createdAt: new Date(agent.createdAt),
    updatedAt: new Date(agent.updatedAt),
    name: agent.name,
    role: agent.role,
    description: agent.description,
    model: agent.model,
    systemPromptMd: agent.systemPrompt,
    allowedTools: agent.allowedTools,
    disallowedTools: agent.disallowedTools,
    permissionMode: agent.permissionMode,
    uiFormat: agent.uiFormat,
    effort: agent.effort ?? null,
    maxTurns: agent.maxTurns,
    maxBudgetUsd: String(agent.maxBudgetUsd),
    monthlyBudgetUsd: agent.monthlyBudgetUsd === null ? null : String(agent.monthlyBudgetUsd),
    budgetAlertRatio: String(agent.budgetAlertRatio),
    timeoutMs: agent.timeoutMs,
    runtimeEnvironmentId: agent.runtimeEnvironmentId,
    memoryPolicy: definition.memoryPolicy,
    hooksEnabled: definition.hooks.enabled,
    hooksConfig: definition.hooks.config,
  };
}

export async function runAgentJob(
  job: Job,
  {
    db,
    client,
    config,
    logger,
    workspacesDir,
    hostWorkspacesDir,
    sandboxApiUrl,
    sandboxClosing,
    sessionSandboxes,
    modelProxy,
    denyQueuedRun,
    loadAgentPlugins,
    writeWorkspace,
    toEntry,
    sandboxEnv,
    cleanupSandboxIdOf,
  }: {
    db: Db;
    client: ReturnType<typeof createDb>['client'];
    config: Config;
    logger: Logger;
    workspacesDir: string;
    hostWorkspacesDir: string;
    sandboxApiUrl: string;
    sandboxClosing: AbortController;
    sessionSandboxes: SessionSandboxes;
    modelProxy: ModelProxy | null;
    loadAgentPlugins: (
      agent: AgentRow,
      bindings: Agent['pluginBindings'],
      plugins: AgentDefinition['resources']['plugins'] | null,
    ) => Promise<WorkspacePlugin[]>;
    sandboxEnv: (apiUrl: string, runId: string) => Record<string, string>;
    cleanupSandboxIdOf: (err: unknown) => string | undefined;
    denyQueuedRun: (
      db: Db,
      logger: Logger,
      runId: string,
      denial: RunAccessDenial,
    ) => Promise<void>;
    toEntry: (
      server: ServerRow,
      apiUrl: string,
      secretKey: string,
      runId: string,
      runToken: string,
    ) => McpJsonEntry;
    writeWorkspace: (
      agent: AgentRow & { serverNames: string[] },
      runId: string,
      servers: Array<{ name: string; entry: McpJsonEntry }>,
      skills: Array<{
        slug: string;
        name: string;
        description: string;
        body: string;
        files?: Array<{ path: string; content: string }>;
      }>,
      subAgents: SubAgentRow[],
      rules: Array<{ slug: string; content: string; globs: string }>,
      outputStyles: Array<{
        slug: string;
        description: string;
        keepCodingInstructions: boolean;
        body: string;
      }>,
      selectedOutputStyle: string | null,
      workflows: Array<{ slug: string; content: string }>,
      hooks: Record<string, unknown> | null,
      hookFiles: Array<{ path: string; content: string; executable: boolean }>,
      plugins: WorkspacePlugin[],
      memoryPolicy: MemoryPolicy,
    ) => Promise<{ dir: string; hasSubAgents: boolean; hasWorkflows: boolean }>;
  },
): Promise<void> {
  const parsed = agentRunJobSchema.safeParse(job.data);
  if (!parsed.success) {
    throw new Error(`invalid job payload: ${parsed.error.message}`);
  }
  const { runId, prompt, replacesRunId, forkFromMessageUuid: jobForkFrom } = parsed.data;
  const jobRequestId = parsed.data.requestId;

  const [run] = await db
    .select({
      status: schema.agentRuns.status,
      errorKind: schema.agentRuns.errorKind,
      startedAt: schema.agentRuns.startedAt,
      agentVersion: schema.agentRuns.agentVersion,
      definitionSnapshot: schema.agentRuns.definitionSnapshot,
      trigger: schema.agentRuns.trigger,
      evalRunId: schema.agentRuns.evalRunId,
      agentId: schema.agentRuns.agentId,
      conversationId: schema.agentRuns.conversationId,
      channelId: schema.agentRuns.channelId,
      subjectKind: schema.agentRuns.subjectKind,
      initiatedBy: schema.agentRuns.initiatedBy,
      serviceId: schema.agentRuns.serviceId,
    })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, runId))
    .limit(1);
  // 排队取消由 API 的 queued → cancelled 更新负责发布终态，worker 不重复发布。
  // 入队失败后未启动的 infra 行：API 已投递 job 但尚未恢复 DB 时，worker 也要能领取。
  const retryingEnqueueFailure =
    run?.status === 'failed' && run.errorKind === 'infra' && run.startedAt === null;
  if (!isActiveRunStatus(run?.status) && !retryingEnqueueFailure) {
    logger.info({ runId, status: run?.status }, 'run no longer pending, skipping');
    return;
  }
  // 主体只从 run 行读取；job/client 里的任何用户或管理员字段都不参与判定。
  const subject = runExecutionSubject(run);
  if (run.status === 'queued' || retryingEnqueueFailure) {
    if (subject === null) {
      await denyQueuedRun(db, logger, runId, {
        reason: 'invalid_subject',
        message: '运行缺少有效执行主体，未启动',
      });
      return;
    }
    const denial =
      subject.kind === 'user'
        ? await checkQueuedRunAccess(db, {
            runId,
            trigger: run.trigger,
            evalRunId: run.evalRunId,
            agentId: run.agentId,
            conversationId: run.conversationId,
            businessId: subject.businessId,
            channelId: run.channelId,
          })
        : await checkQueuedAgentActive(db, run.agentId);
    if (denial !== null) {
      logger.warn({ runId, reason: denial.reason }, 'run denied before sandbox start');
      await denyQueuedRun(db, logger, runId, denial);
      return;
    }
  }
  // running 行的重投只会在认领时被拒绝；主体损坏时不继续使用它挂载任何目录。
  if (subject === null) return;
  // 后续会话/专家归属以 run 行为准，不能用 job 里的 ID 改写挂载来源。
  const agentId = run.agentId;
  const conversationId = run.conversationId;
  const runLog = runScopedLogger(logger, {
    runId,
    requestId: jobRequestId,
    agentId,
    conversationId,
  });
  // 只认领 queued 或入队失败且从未启动的 infra 行：BullMQ 在 Redis 抖动后会重投递仍在 running 的任务，
  // 若这里也接受 running，同一 run 会被两个 worker 各跑一遍（重复计费、消息互相覆盖）。
  const claimed = await db
    .update(schema.agentRuns)
    .set({
      status: 'running',
      startedAt: new Date(),
      endedAt: null,
      error: null,
      errorKind: null,
    })
    .where(
      and(
        eq(schema.agentRuns.id, runId),
        or(
          eq(schema.agentRuns.status, 'queued'),
          and(
            eq(schema.agentRuns.status, 'failed'),
            eq(schema.agentRuns.errorKind, 'infra'),
            isNull(schema.agentRuns.startedAt),
          ),
        ),
      ),
    )
    .returning({ id: schema.agentRuns.id });
  if (claimed.length === 0) {
    runLog.info('run externally terminated before claim, skipping');
    return;
  }
  // 记忆审核不是聊天：不建沙盒、不追加消息、不准备成果，直接读快照产出提案。
  if (run.trigger === 'review') {
    await executeMemoryReview(
      db,
      {
        runId,
        redisUrl: config.REDIS_URL,
        signal: sandboxClosing.signal,
      },
      { config, logger: runLog, ...(modelProxy === null ? {} : { modelProxy }) },
    );
    return;
  }
  try {
    await publishRun(runId, { type: 'run_started', runId, conversationId }, runLog);
  } catch (err) {
    // 认领不接受 running；发布失败若不回退，BullMQ 重试会被 running 守卫跳过。
    try {
      await db
        .update(schema.agentRuns)
        .set({ status: 'queued', startedAt: null })
        .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.status, 'running')));
    } catch (revertError) {
      runLog.error({ err: revertError }, 'failed to requeue after publish failure');
    }
    throw err;
  }
  await repo.audit.writeAudit(db, runLog, {
    actor: 'worker',
    actorKind: 'service',
    action: 'agent.run.started',
    target: runId,
    status: 'ok',
    dedupeKey: `aud_started_${runId.slice(4)}`,
  });
  // 认领成功后再广播频道生命周期；发布失败只记日志，不影响执行与重试。
  if (run.channelId !== null) {
    await publishChannelEventSafely(
      run.channelId,
      { type: 'run.started', channelId: run.channelId, runId, agentId },
      runLog,
      { runId },
    );
  }

  let lease: SessionSandboxLease | undefined;
  let leaseReleased = false;
  let reuseSession = false;
  let stableWorkspaceDir: string | undefined;
  let stableOutputsDir: string | undefined;
  let stableOutputsPrepared = false;
  let agentSlugForRun = '';
  try {
    let outcome: SandboxRunOutcome;
    let runStartedAt = 0;
    let runLatencyMs: number | null = null;
    let sessionsDirForRun: string | null = null;
    let userMessageIdForRun: string | null = null;
    /** 本轮草稿的宿主路径；只有准备成功才有值，与是否新建容器无关。 */
    let outputsHostPath: string | null = null;
    /** 本轮智能体的回复格式；在 try 内读取，收尾落库时仍要用。 */
    let runUiFormat: 'markdown' | 'openui' = 'markdown';
    try {
      const [agent] = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId))
        .limit(1);
      if (!agent) throw new Error(`agent ${agentId} not found`);
      const definitionSnapshot = run.definitionSnapshot ?? null;
      const pinnedVersion = run.agentVersion ?? null;
      let definition: AgentDefinition | null = definitionSnapshot;
      if (definitionSnapshot === null && pinnedVersion !== null) {
        const version = await repo.agentVersions.getAgentVersion(db, agentId, pinnedVersion);
        if (!version) {
          throw new Error(`agent ${agentId} version ${pinnedVersion} not found`);
        }
        definition = version.definition;
        if (definition === null) {
          runLog.warn(
            { agentVersion: pinnedVersion },
            'legacy agent version has no definition snapshot',
          );
        }
      }
      const effectiveAgent = definition === null ? agent : applyAgentDefinition(definition);
      agentSlugForRun = effectiveAgent.slug;
      // 同一行已带 memoryPolicy 列：直接解析，避免为本轮再查一次 agent。
      const resolvedMemoryPolicy = resolveWorkspaceMemoryPolicy(
        definition?.memoryPolicy ?? agent.memoryPolicy,
        {
          mode: 'run',
          channelId: run.channelId,
        },
      );
      const runMemoryPolicy: MemoryPolicy =
        definitionSnapshot === null
          ? resolvedMemoryPolicy
          : { ...resolvedMemoryPolicy, writeMode: 'proposal_only' };
      // 单层委派：只取直接子智能体。容器取得前查一次并沿用到结束；A 保证准入到结束集合稳定。
      const childReferences =
        definition === null
          ? await db
              .select({
                id: schema.agents.id,
                publishedVersion: schema.agents.publishedVersion,
              })
              .from(schema.agents)
              .where(eq(schema.agents.parentId, agentId))
              .orderBy(asc(schema.agents.id))
          : definition.resources.subAgents;
      const liveChildById =
        definition === null
          ? null
          : new Map(
              (
                await repo.agents.getAgentsByIds(
                  db,
                  childReferences.map(({ id }) => id),
                )
              ).map((row) => [row.id, row] as const),
            );
      const children = await Promise.all(
        childReferences
          .filter(({ id }) => liveChildById === null || liveChildById.get(id)?.enabled === true)
          .map(async ({ id, publishedVersion }) => {
            const version =
              publishedVersion === null
                ? null
                : await repo.agentVersions.getAgentVersion(db, id, publishedVersion);
            if (publishedVersion !== null && version === null) {
              throw new Error(`agent ${id} version ${publishedVersion} not found`);
            }
            const childDefinition = version?.definition ?? null;
            if (childDefinition !== null) {
              return {
                row: { ...applyAgentDefinition(childDefinition), enabled: true },
                definition: childDefinition,
              };
            }
            const row = liveChildById?.get(id) ?? (await repo.agents.getAgent(db, id));
            if (!row) throw new Error(`agent ${id} not found`);
            return { row, definition: null };
          }),
      );
      const enabledChildren =
        liveChildById === null ? children.filter(({ row }) => row.enabled) : children;
      const childDefinitions = new Map(
        enabledChildren.map(({ row, definition }) => [row.id, definition]),
      );
      const effectiveChildren = enabledChildren.map(({ row }) => row);
      const subAgentSlugs = effectiveChildren.map((row) => row.slug).sort();
      // 频道 run 共享 lane，不投影也不挂载任何参与者偏好；用户 run 先按 DB 重写，崩溃后不带旧投影。
      // 专家策略关闭个人记忆注入时，投影与 /mnt/user 挂载一起跳过（身份边界仍由 helper 保证）。
      const personalBusinessId = personalMemoryBusinessIdForRun({
        subject,
        channelId: run.channelId,
        policy: runMemoryPolicy,
      });
      if (personalBusinessId !== undefined) {
        await projectPersonalMemory(db, client, workspacesDir, personalBusinessId);
      }
      const sessionPaths = await ensureSessionWorkspace({
        workspacesDir,
        slug: effectiveAgent.slug,
        conversationId,
        ...(personalBusinessId === undefined ? {} : { businessId: personalBusinessId }),
        subAgentSlugs,
      });
      if (definition !== null && definition.resources.runtimeEnvironment === null) {
        throw new Error('运行定义缺少固定的运行环境');
      }
      lease = await acquireSessionSandbox({
        runId,
        manager: sessionSandboxes,
        logger: runLog,
        signal: sandboxClosing.signal,
        spec: {
          agentId,
          conversationId,
          runtimeEnvironmentId:
            definition?.resources.runtimeEnvironment?.id ?? effectiveAgent.runtimeEnvironmentId,
          ...(definition === null
            ? {}
            : {
                runtimeEnvironmentVersionId:
                  definition.resources.runtimeEnvironment?.versionId ?? null,
              }),
          workspaceDir: toHostWorkspacePath(
            { workspacesDir, hostWorkspacesDir },
            sessionPaths.workspaceDir,
          ),
          outputsDir: toHostWorkspacePath(
            { workspacesDir, hostWorkspacesDir },
            sessionPaths.outputsDir,
          ),
          inputsDir: toHostWorkspacePath(
            { workspacesDir, hostWorkspacesDir },
            sessionPaths.inputsDir,
          ),
          // 记忆策略决定挂载方式：关闭时不挂 /mnt/agent-memory，只有 native_auto 可写；
          // 容器重建由挂载集合（含 readonly）变化触发。
          ...memoryMountFor(
            runMemoryPolicy,
            toHostWorkspacePath({ workspacesDir, hostWorkspacesDir }, sessionPaths.memoryDir),
          ),
          sessionsDir: toHostWorkspacePath(
            { workspacesDir, hostWorkspacesDir },
            sessionPaths.sessionsDir,
          ),
          ...(sessionPaths.personalDir === undefined
            ? {}
            : {
                personalDir: toHostWorkspacePath(
                  { workspacesDir, hostWorkspacesDir },
                  sessionPaths.personalDir,
                ),
              }),
          subAgentMemoryDirs: sessionPaths.subAgentMemoryDirs.map((dir) => ({
            slug: dir.slug,
            memoryDir: toHostWorkspacePath({ workspacesDir, hostWorkspacesDir }, dir.memoryDir),
          })),
        },
      });
      stableWorkspaceDir = sessionPaths.workspaceDir;
      stableOutputsDir = sessionPaths.outputsDir;

      // 记录容器实际使用的身份：复用存活容器时是旧版本，不谎报当前线上。
      // sandboxId 也在 start 前落库：进程若在运行中崩溃，reconcile 仍知道该销毁哪个容器。
      // 必须落库成功才能开始任务；失败交给外层 catch 释放 lease。
      const runtimeEnvironment = lease.runtimeEnvironment;
      await db
        .update(schema.agentRuns)
        .set({
          sandboxId: lease.sandboxId,
          runtimeEnvironmentId: runtimeEnvironment.environmentId,
          runtimeEnvironmentName: runtimeEnvironment.environmentName,
          runtimeEnvironmentVersionId: runtimeEnvironment.versionId,
          runtimeEnvironmentImageId: runtimeEnvironment.imageId,
        })
        .where(eq(schema.agentRuns.id, runId));

      // 消息级快照：历史渲染按这一轮落库的格式，切换开关不影响已存消息。
      runUiFormat = effectiveAgent.uiFormat === 'openui' ? 'openui' : 'markdown';

      const timeoutMs = effectiveAgent.timeoutMs;
      // 续聊状态只从 DB 取：队列消息不带历史，重试时也不会用陈旧上下文覆盖会话。
      const sdkState = await repo.chat.getConversationSdkState(db, conversationId);
      if (!sdkState) throw new Error(`conversation ${conversationId} not found`);
      // 本轮用户消息在准入时已落库；runner 用它（或这里补生成的 uuid）发首条消息。
      const userMessageRunId = replacesRunId ?? runId;
      const [userMessage] = await db
        .select({
          id: schema.messages.id,
          content: schema.messages.content,
          sdkMessageUuid: schema.messages.sdkMessageUuid,
        })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.runId, userMessageRunId),
            eq(schema.messages.role, 'user'),
            eq(schema.messages.conversationId, conversationId),
          ),
        )
        .limit(1);
      if (!userMessage) throw new Error(`user message for run ${runId} not found`);
      userMessageIdForRun = userMessage.id;
      // 用户可能在消息里选择了一个已交付文件作为修改对象：复制成草稿并在提示里给出路径。
      const chosenOutput = selectedOutput(userMessage.content);
      // 动作回传要把上下文与表单值一起交给模型；纯文本消息仍是原文。
      const regenerated = parsed.data.regenerateContent;
      const openuiContent =
        regenerated === undefined ? userMessage.content : regenerated.openuiAction;
      const taskPrompt = promptWithAttachments(
        promptWithSelectedOutput(promptWithOpenUiAction(openuiContent, prompt), chosenOutput),
        messageAttachments(userMessage.content),
      );
      // 非浏览器入口（定时、评估、外部调用）不经过准入；uuid 由平台生成后显式发给 SDK，
      // 因此它仍是真实 transcript 身份，不是事后拼的映射。
      const userMessageUuid = userMessage.sdkMessageUuid ?? randomUUID();
      if (userMessage.sdkMessageUuid === null) {
        await db
          .update(schema.messages)
          .set({ sdkMessageUuid: userMessageUuid })
          .where(eq(schema.messages.id, userMessage.id));
      }
      const definitionsByAgent: Array<[string, AgentDefinition | null]> = [
        [agentId, definition],
        ...effectiveChildren.map(
          (row) =>
            [row.id, childDefinitions.get(row.id) ?? null] as [string, AgentDefinition | null],
        ),
      ];
      const liveAgents = definitionsByAgent.filter(([, def]) => def === null).map(([id]) => id);
      const liveServerRowsByAgent = await repo.agents.getBoundServersByAgentIds(db, liveAgents);
      const bindingsByAgent = new Map<string, ServerRow[]>(
        definitionsByAgent.map(([id, def]) => [
          id,
          def === null
            ? (liveServerRowsByAgent.get(id) ?? []).map((server) => ({
                ...server,
                updatedAt: server.updatedAt.toISOString(),
              }))
            : def.resources.servers,
        ]),
      );
      // 工作区 .mcp.json 是父 + 启用子级的并集：子级按名字引用根条目，
      // 在非交互会话里无需信任目录即可加载；父级看不到子级工具由渲染与 hook 共同限制。
      const { serverNamesByAgent, serverRows } = loadRunServerBindings(bindingsByAgent);
      // 按 run 签发短期 token：DB 只存 hash，明文只在本工作区的 .mcp.json 里。
      // 过期时间比 run 超时多 5 分钟，避免收尾阶段请求被截断。
      const runToken = randomBytes(32).toString('base64url');
      await repo.runs.setRunMcpToken(
        db,
        runId,
        hashMcpToken(runToken),
        new Date(Date.now() + timeoutMs + 5 * 60_000),
        modelProxy ? hashMcpToken(runId) : null,
        serverRows.map((server) => server.id),
      );
      const parentServerNames = serverNamesByAgent.get(agentId) ?? [];
      const mcpServerIds = Object.fromEntries(serverRows.map((server) => [server.name, server.id]));
      const serverNamesById = new Map(serverRows.map((server) => [server.id, server.name]));
      const liveApprovalServerIds = serverRows
        .filter((server) => server.tools === undefined)
        .map((server) => server.id);
      const approvalModes =
        liveApprovalServerIds.length === 0
          ? []
          : await repo.servers.listToolApprovalModes(db, liveApprovalServerIds);
      const mcpApprovalTools = [
        ...serverRows.flatMap((server) =>
          (server.tools ?? [])
            .filter((tool) => tool.enabled && tool.approvalMode === 'ask')
            .map((tool) => ({ server: server.name, tool: tool.name })),
        ),
        ...approvalModes.flatMap((tool) => {
          const server = serverNamesById.get(tool.serverId);
          return tool.approvalMode === 'ask' && server !== undefined
            ? [{ server, tool: tool.toolName }]
            : [];
        }),
      ];

      const liveSkillRowsByAgent: Map<
        string,
        Array<typeof schema.skills.$inferSelect>
      > = liveAgents.length === 0
        ? new Map()
        : await repo.agents.getBoundSkillsByAgentIds(db, liveAgents);
      const skillFileMap = await repo.skillFiles.getSkillFilesBySkillIds(db, [
        ...new Set([...liveSkillRowsByAgent.values()].flat().map((row) => row.id)),
      ]);
      const skillsByAgent = new Map<string, WorkspaceSkill[]>(
        definitionsByAgent.map(([id, def]) => [
          id,
          def === null
            ? (liveSkillRowsByAgent.get(id) ?? []).map((row) => ({
                ...repo.skills.toSkillDefinition(row),
                files: (skillFileMap.get(row.id) ?? []).map(({ path, content }) => ({
                  path,
                  content,
                })),
              }))
            : def.resources.skills.map(({ license, compatibility, metadata, ...skill }) => ({
                ...skill,
                ...(license === undefined ? {} : { license }),
                ...(compatibility === undefined ? {} : { compatibility }),
                ...(metadata === undefined ? {} : { metadata }),
              })),
        ]),
      );
      const skillsWithFiles = skillsByAgent.get(agentId) ?? [];
      const childSkills = new Map(
        effectiveChildren.map((row) => [row.id, skillsByAgent.get(row.id) ?? []]),
      );
      const subAgents = effectiveChildren.map((row) => ({
        ...row,
        skills: childSkills.get(row.id) ?? [],
        serverNames: serverNamesByAgent.get(row.id) ?? [],
      }));

      // injectRules=false 时不渲染也不查询规则；writeWorkspace 仍会先清理旧 .claude/rules。
      const rules = runMemoryPolicy.injectRules
        ? toRuleEntries(definition ? definition.rules : await repo.rules.listRules(db, agentId))
        : [];

      const styleRows = definition
        ? definition.outputStyles
        : await repo.outputStyles.listOutputStyles(db, agentId);
      const { outputStyles, selectedOutputStyle } = toOutputStyleSelection(styleRows);
      const workflows =
        effectiveAgent.parentId === null
          ? toWorkflowEntries(
              definition ? definition.workflows : await repo.workflows.listWorkflows(db, agentId),
            )
          : [];
      const pluginBindings: Agent['pluginBindings'] = definition
        ? definition.agent.pluginBindings
        : (await repo.plugins.listAgentPluginBindings(db, agentId)).map(
            ({ plugin, allowHooks, allowMcp }) => ({
              pluginId: plugin.id,
              allowHooks,
              allowMcp,
            }),
          );
      const runPlugins = await loadAgentPlugins(
        effectiveAgent,
        pluginBindings,
        definition?.resources.plugins ?? null,
      );
      const hookFiles = effectiveAgent.hooksEnabled
        ? definition
          ? definition.hooks.files.map((row) => ({
              path: row.path,
              content: row.content,
              executable: row.executable,
            }))
          : (await repo.hooks.listHookFiles(db, agentId)).map((row) => ({
              path: row.path,
              content: row.content,
              executable: row.executable,
            }))
        : [];

      const {
        dir: workspaceDir,
        hasSubAgents,
        hasWorkflows,
      } = await writeWorkspace(
        { ...effectiveAgent, serverNames: parentServerNames },
        runId,
        serverRows.map((server) => ({
          name: server.name,
          entry: toEntry(server, sandboxApiUrl, config.APP_SECRET_KEY, runId, runToken),
        })),
        skillsWithFiles,
        subAgents,
        rules,
        outputStyles,
        selectedOutputStyle,
        workflows,
        effectiveAgent.hooksEnabled ? effectiveAgent.hooksConfig : null,
        hookFiles,
        runPlugins,
        runMemoryPolicy,
      );
      await refreshSessionDirectory(workspaceDir, stableWorkspaceDir, {
        preserveMemoryMount: true,
      });
      runLog.info({ workspaceDir }, 'agent run started');

      sessionsDirForRun = sessionPaths.sessionsDir;

      // 草稿以最新完整快照为基线，仅用用户所选旧版覆盖指定文件。
      // 独立 rw 挂载到 /mnt/outputs，定义挂载 /workspace 仍只读。
      const preparedOutputs = await prepareRunOutputs({
        workspacesDir,
        hostWorkspacesDir,
        slug: effectiveAgent.slug,
        conversationId,
        runId,
        ...(chosenOutput === null
          ? {}
          : { sourceRunId: chosenOutput.runId, sourcePath: chosenOutput.path }),
      });
      outputsHostPath = preparedOutputs.hostPath;
      await refreshSessionDirectory(preparedOutputs.dir, stableOutputsDir);

      stableOutputsPrepared = true;
      runStartedAt = Date.now();
      const resumeSessionId =
        replacesRunId !== undefined
          ? jobForkFrom === undefined
            ? null
            : sdkState.sdkSessionId
          : sdkState.sdkSessionId;
      const forkFromMessageUuid =
        replacesRunId !== undefined ? jobForkFrom : (sdkState.forkFromSdkMessageUuid ?? undefined);
      const task: SandboxTaskInput = {
        prompt: taskPrompt,
        model: effectiveAgent.model,
        maxTurns: effectiveAgent.maxTurns,
        maxBudgetUsd: Number(effectiveAgent.maxBudgetUsd),
        permissionMode: permissionModeSchema.parse(effectiveAgent.permissionMode),
        mcpServers: parentServerNames,
        mcpServerIds,
        mcpApprovalTools,
        skills: skillsWithFiles.map((skill) => skill.slug),
        hasWorkflows,
        extraAllowedTools: effectiveAgent.allowedTools,
        extraDisallowedTools: effectiveAgent.disallowedTools,
        ...(effectiveAgent.effort === null
          ? {}
          : { effort: effortSchema.parse(effectiveAgent.effort) }),
        allowSubAgents: hasSubAgents,
        maxFieldBytes: config.SANDBOX_MAX_FIELD_BYTES,
        plugins: runPlugins.map((plugin) => ({
          path: `/workspace/.claude/plugins/${plugin.slug}`,
          runtimeName: plugin.runtimeName,
          skills: plugin.skillNames,
          mcpServers: plugin.mcpServerNames,
          hasAgents: plugin.hasAgents,
        })),
        subAgents: effectiveChildren.map((row) => ({
          slug: row.slug,
          servers: serverNamesByAgent.get(row.id) ?? [],
          skills: (childSkills.get(row.id) ?? []).map((skill) => skill.slug),
        })),
        userMessageUuid,
        memoryPolicy: runMemoryPolicy,
        // 首次空会话不 resume：没有 transcript 时传了只会让 CLI 找不到会话。
        ...(resumeSessionId === null ? {} : { resumeSessionId }),
        ...(forkFromMessageUuid === undefined ? {} : { forkFromMessageUuid }),
      };
      outcome = await runInSandbox({
        runId,
        timeoutMs,
        task,
        lease,
        signal: sandboxClosing.signal,
        // 真实 run 来源元数据，只给频道 run；私聊 env 保持原样。
        env:
          run.channelId === null
            ? sandboxEnv(sandboxApiUrl, runId)
            : { ...sandboxEnv(sandboxApiUrl, runId), PACE_RUN_TRIGGER: 'channel' },
        logger: runLog,
        // 问题先落库再推界面；轮询答案也只读这条 run 的记录。
        questions: {
          // 期限由 runner 在容器实际开始时给出，创建耗时不计入。
          request: async (event, expiresAt) => {
            const question = await repo.questions.createQuestion(db, {
              runId,
              requestId: event.requestId,
              toolUseId: event.toolUseId,
              questions: event.questions,
              expiresAt,
            });
            if (run.initiatedBy !== null) {
              await repo.notifications
                .createNotification(db, {
                  businessId: run.initiatedBy,
                  kind: 'question',
                  title: '运行需要你的回答',
                  body: event.questions[0]?.question ?? '运行正在等待你的回答',
                  link: run.channelId === null ? `/runs/${runId}` : `/channels/${run.channelId}`,
                  sourceId: `question:${runId}:${event.requestId}`,
                })
                .catch((err: unknown) => {
                  runLog.warn(
                    { err, runId, requestId: event.requestId },
                    'question notification failed',
                  );
                });
            }
            return question;
          },
          list: () => repo.questions.listQuestions(db, runId),
          close: (reason, requestId) => repo.questions.closeQuestions(db, runId, reason, requestId),
          expireStale: () =>
            repo.questions.expireStaleQuestions(db, { runId }).then(() => undefined),
        },
        ...(run.channelId === null
          ? {}
          : {
              instructions: {
                list: () => repo.runInstructions.listPendingRunInstructions(db, runId),
                markDelivered: (id) => repo.runInstructions.markRunInstructionDelivered(db, id),
              },
            }),
      });
      runLatencyMs = Date.now() - runStartedAt;
      leaseReleased = outcome.leaseReleased === true;
      reuseSession =
        outcome.settlement.state === 'stopped' &&
        (outcome.status === 'succeeded' || outcome.status === 'cancelled') &&
        !leaseReleased;
    } catch (err) {
      const error = err instanceof RunFailure || err instanceof Error ? err.message : String(err);
      runLog.error({ err }, 'agent run crashed');
      // 只有确认容器仍可能存活时才记 unconfirmed：准备阶段和普通 acquire 失败没有遗留，
      // 误判会禁掉 infra 重试与延迟取消。typed 清理失败由 cause 携带 sandbox id。
      const cleanupSandboxId = cleanupSandboxIdOf(err);
      outcome = {
        status: err instanceof RunFailure && err.reason === 'cancelled' ? 'cancelled' : 'failed',
        ...(err instanceof RunFailure ? { failure: err } : {}),
        sandboxId: cleanupSandboxId ?? lease?.sandboxId ?? '',
        settlement:
          cleanupSandboxId === undefined
            ? { state: 'stopped', code: null, signal: null }
            : { state: 'unconfirmed', error },
        ...(cleanupSandboxId === undefined ? {} : { cleanupError: error }),
        error,
        events: [],
      };
      if (lease && !leaseReleased) {
        leaseReleased = true;
        try {
          await lease.release({ reuse: false });
          outcome.settlement = { state: 'stopped', code: null, signal: null };
        } catch (cleanupError) {
          outcome.cleanupError = errorText(cleanupError);
          outcome.settlement = { state: 'unconfirmed', error: outcome.cleanupError };
        }
      }
    }

    // 停稳后移除空闲工作区凭证文件；无论销毁是否成功，运行凭证都立即吊销。
    if (outcome.settlement.state === 'stopped') {
      if (stableWorkspaceDir) {
        try {
          await rm(join(stableWorkspaceDir, '.mcp.json'), { force: true });
        } catch (err) {
          reuseSession = false;
          runLog.error({ err }, 'failed to remove idle workspace mcp credentials');
          if (lease && !leaseReleased) {
            leaseReleased = true;
            try {
              await lease.release({ reuse: false });
            } catch (cleanupError) {
              outcome.cleanupError = errorText(cleanupError);
              outcome.settlement = { state: 'unconfirmed', error: outcome.cleanupError };
              runLog.error({ err: cleanupError }, 'sandbox cleanup failed');
            }
          }
        }
      }
    }
    await repo.runs.clearRunTokens(db, runId).catch((err: unknown) => {
      runLog.warn({ err }, 'failed to clear run tokens');
    });
    modelProxy?.revokeToken(runId);

    let outputSettlementError: string | undefined;
    if (outputsHostPath !== null) {
      try {
        if (
          outcome.settlement.state === 'stopped' &&
          stableOutputsDir !== undefined &&
          stableOutputsPrepared
        ) {
          await captureOutputDraft({
            root: workspacesDir,
            slug: agentSlugForRun,
            conversationId,
            runId,
            sourceDir: stableOutputsDir,
          });
        }
        await recordOutputSandboxSettlement(
          { workspacesDir, hostWorkspacesDir, slug: agentSlugForRun, conversationId, runId },
          outcome,
        );
      } catch (err) {
        outputSettlementError = errorText(err);
        runLog.error({ err }, 'failed to record output sandbox settlement');
      }
    }

    // 把本次 run 的 assistant 文本与工具调用写入会话，刷新后历史才完整。
    // SDK session 与 fork 后的 uuid 映射同事务落库：只存一半会让续聊对不上 transcript。
    // 写库失败不能抛出：抛出会让 BullMQ 重跑整个沙盒并最终只留 reconcile 的
    // "worker lost track of this run"，真实原因反而被覆盖。记日志，继续写终态。
    // 落库前先判定是否还会重试：失败轮次的 SDK session 与 fork 映射不能污染下一次续聊。
    const retryable = isRetryable(outcome);
    const willRetry = retryable && job.attemptsMade + 1 < (job.opts.attempts ?? 1);
    // 成功结果、正 token 或工具事件都证明模型已执行；频道游标与 session 边界共用这一判据。
    const modelExecuted =
      outcome.status === 'succeeded' ||
      (outcome.inputTokens ?? 0) > 0 ||
      (outcome.outputTokens ?? 0) > 0 ||
      outcome.events.some((event) => event.type === 'tool_start' || event.type === 'tool_result');
    // 频道轮没执行时不存 session：游标未推进会在下一轮重注入，恢复这段 transcript 会收到两份同一上下文。
    const sdkSessionId =
      willRetry || (run.channelId !== null && !modelExecuted) ? undefined : outcome.sessionId;
    const forked = outcome.events.find((event) => event.type === 'session_forked');
    let persistedMessages: PersistedMessage[] = [];
    let projectedChannelMessage: PersistedChannelMessage | undefined;
    let messagesWritten = false;
    let messageSaveError: string | undefined;
    const regenerateReplaced =
      replacesRunId !== undefined && !willRetry && outcome.status === 'succeeded';
    const skippedRegeneratePersist = replacesRunId !== undefined && !regenerateReplaced;
    if (!skippedRegeneratePersist) {
      try {
        // 分支首轮：从宿主 transcript 的 forkedFrom 算新旧 uuid 映射，再与消息同事务写入。
        const uuidMap =
          !willRetry &&
          (run.channelId === null || modelExecuted) &&
          forked?.type === 'session_forked' &&
          sessionsDirForRun !== null
            ? await readForkUuidMap(
                sessionsDirForRun,
                forked.sessionId,
                new Set(await repo.chat.listConversationMessageUuids(db, conversationId)),
              )
            : undefined;
        const persisted = await persistRunMessages(db, {
          agentId,
          conversationId,
          runId,
          events: outcome.events,
          ...(sdkSessionId === undefined ? {} : { sdkSessionId }),
          ...(uuidMap === undefined ? {} : { uuidMap }),
          ...(replacesRunId === undefined ? {} : { replacesRunId }),
          uiFormat: runUiFormat,
          // 中间轮投影会占用频道 seq，已订阅者按 seq > cursor 永远读不到最终正文。
          projectChannelReply: !willRetry,
          ...(run.channelId !== null && modelExecuted ? { modelExecuted: true } : {}),
        });
        messagesWritten = persisted.written;
        persistedMessages = persisted.messages;
        projectedChannelMessage = persisted.channelMessage;
        if (!persisted.written) messageSaveError = '消息保存被拒绝，运行或会话已由外部终止';
      } catch (err) {
        messageSaveError = errorText(err);
        runLog.error({ err }, 'failed to persist run messages');
      }
    }

    // DB 已提交的投影才是权威；Redis 只负责唤醒，失败不改变运行结果。
    if (projectedChannelMessage !== undefined) {
      await repo.audit.writeAudit(db, runLog, {
        actor: agentId,
        actorKind: 'agent',
        action: 'channel.message.posted',
        target: projectedChannelMessage.id,
        input: {
          channelId: projectedChannelMessage.channelId,
          runId,
          seq: projectedChannelMessage.seq,
        },
        status: 'ok',
        dedupeKey: `aud_chmsg_${projectedChannelMessage.id.slice(4)}`,
      });
      await publishChannelEventSafely(
        projectedChannelMessage.channelId,
        {
          type: 'message.created',
          channelId: projectedChannelMessage.channelId,
          seq: projectedChannelMessage.seq,
          message: repo.channels.toChannelMessage(projectedChannelMessage),
        },
        runLog,
        { runId },
      );
    }

    if (!messagesWritten && !willRetry && !skippedRegeneratePersist) {
      outcome = {
        ...outcome,
        error: `${outcome.error ?? outcome.status}；消息未保存，产出未发布：${messageSaveError ?? '消息保存被拒绝'}`,
      };
    }
    if (outputSettlementError !== undefined && !willRetry) {
      outcome = {
        ...outcome,
        error: `${outcome.error ?? outcome.status}；产出停稳状态保存失败，产出未发布：${outputSettlementError}`,
      };
    }
    if (
      outputsHostPath !== null &&
      userMessageIdForRun !== null &&
      messagesWritten &&
      outputSettlementError === undefined
    ) {
      try {
        // 消息边界取真实消息行：只有工具调用的轮次没有助手文本，也必须能定位到本轮。
        // 容器停稳且不再重试才发布；否则草稿保留，也不覆盖同 run 已发布的快照。
        const published = await publishRunOutputsIfSettled(
          {
            workspacesDir,
            hostWorkspacesDir,
            slug: agentSlugForRun,
            conversationId,
            runId,
          },
          {
            status: outcome.status,
            userMessageId: userMessageIdForRun,
            afterMessageId: () => lastMessageIdOfRun(db, runId),
            messagesWritten,
            retrying: willRetry,
            ...(outcome.cleanupError === undefined ? {} : { cleanupError: outcome.cleanupError }),
          },
        );
        if (published.problem !== undefined) {
          runLog.warn({ problem: published.problem }, 'run outputs not published');
          // 重试会把这一轮整个重跑；不要把「暂未发布」写进运行错误里干扰重试原因。
          if (!willRetry) {
            outcome = {
              ...outcome,
              error: `${outcome.error ?? outcome.status}；${published.problem}`,
            };
          }
        }
      } catch (err) {
        // 发布失败不掩盖运行本身的结果；草稿仍在，页面据此明确提示没有发布快照。
        const message = errorText(err);
        runLog.error({ err }, 'failed to publish run outputs');
        if (!willRetry) {
          outcome = {
            ...outcome,
            error: `${outcome.error ?? outcome.status}；产出发布失败：${message}`,
          };
        }
      }
    }

    if (willRetry) {
      // 认领不接受 running，所以重试前必须把行改回 queued 再抛错；
      // 否则下一次投递会被自己的守卫当成「外部已终止」而跳过。
      const requeued = await db.transaction(async (tx) => {
        const rows = await tx
          .update(schema.agentRuns)
          .set({ status: 'queued', startedAt: null })
          .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.status, 'running')))
          .returning({ id: schema.agentRuns.id });
        if (rows.length > 0) {
          await repo.runInstructions.resetInstructionDeliveryForRun(tx, runId);
        }
        return rows;
      });
      if (requeued.length > 0) {
        runLog.warn({ attempt: job.attemptsMade + 1 }, 'retrying sandbox failure');
        throw new Error(`retryable sandbox failure: ${outcome.error ?? 'unknown'}`);
      }
    }

    const finishedEvent = (): RunFinishedEvent => ({
      type: 'run_finished',
      status: outcome.status,
      ...(persistedMessages.length === 0 ? {} : { messageIds: persistedMessages }),
      ...(outcome.costUsd === undefined ? {} : { costUsd: outcome.costUsd }),
      ...(outcome.turns === undefined ? {} : { turns: outcome.turns }),
      ...(outcome.inputTokens == null ? {} : { inputTokens: outcome.inputTokens }),
      ...(outcome.outputTokens == null ? {} : { outputTokens: outcome.outputTokens }),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      ...(outcome.failure ? { failureKind: wireFailureKind(outcome.failure.reason) } : {}),
    });
    const finishValues = {
      ...(outcome.sandboxId ? { sandboxId: outcome.sandboxId } : {}),
      latencyMs: runLatencyMs ?? null,
      costUsd: outcome.costUsd === undefined ? null : String(outcome.costUsd),
      turns: outcome.turns ?? null,
      sessionId: outcome.sessionId ?? null,
      inputTokens: outcome.inputTokens ?? null,
      outputTokens: outcome.outputTokens ?? null,
      error: outcome.error ?? null,
      errorKind: outcome.failure?.reason ?? null,
    };
    // 停稳未确认（stop 无 ACK 且销毁失败）：先只交接终态，状态保持 running，
    // 业务占用与 memory 准入不释放；由 reconcile 确认容器销毁后再落终态、发布原事件。
    if (outcome.settlement.state === 'unconfirmed') {
      await handOffPendingFinish({
        db,
        logger: runLog,
        runId,
        event: finishedEvent(),
        values: finishValues,
      });
      runLog.warn(
        { sandboxId: outcome.sandboxId },
        'run stop unconfirmed; terminal state deferred to reconcile',
      );
      return;
    }

    const won = await finalizeRun({
      db,
      logger: runLog,
      runId,
      event: finishedEvent(),
      values: finishValues,
      audit: {
        action: 'agent.run.finished',
        status: outcome.status === 'succeeded' ? 'ok' : 'error',
        dedupeKey: `aud_${runId.slice(4)}`,
        ...(runLatencyMs === null ? {} : { durationMs: runLatencyMs }),
      },
    });
    if (!won) {
      const current = await repo.chat.getRun(db, runId);
      if (!current || isActiveRunStatus(current.status)) {
        runLog.warn({ status: current?.status }, 'run disappeared or is no longer terminal');
        return;
      }
      outcome = {
        settlement: outcome.settlement,
        status: current.status,
        sandboxId: current.sandboxId ?? '',
        events: outcome.events,
        ...(current.costUsd === null ? {} : { costUsd: Number(current.costUsd) }),
        ...(current.turns === null ? {} : { turns: current.turns }),
        ...(current.error === null ? {} : { error: current.error }),
        ...(current.errorKind === null
          ? {}
          : { failure: new RunFailure(current.errorKind, current.error ?? current.status) }),
      };
      await publishRunFinished({
        db,
        logger: runLog,
        runId,
        event: finishedEvent(),
        audit: {
          action: 'agent.run.finished',
          status: outcome.status === 'succeeded' ? 'ok' : 'error',
          dedupeKey: `aud_${runId.slice(4)}`,
          ...(runLatencyMs === null ? {} : { durationMs: runLatencyMs }),
        },
      });
    }

    runLog.info(
      {
        status: outcome.status,
        costUsd: outcome.costUsd,
        latencyMs: runLatencyMs,
      },
      'agent run finished',
    );

    if (retryable && won) {
      throw new Error(`retryable sandbox failure: ${outcome.error ?? 'unknown'}`);
    }
  } finally {
    // run 临时渲染可删；稳定挂载与持久 transcript、附件、记忆留给下一轮。
    await rm(join(workspacesDir, agentSlugForRun, runId), { recursive: true, force: true }).catch(
      (err: unknown) => runLog.warn({ err }, 'workspace cleanup failed'),
    );
    if (lease && !leaseReleased) {
      await lease.release({ reuse: reuseSession }).catch((err: unknown) => {
        runLog.error({ err }, 'session lease release failed');
      });
    }
  }
}
