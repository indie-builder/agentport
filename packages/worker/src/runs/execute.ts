import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpJsonEntry, WorkspacePlugin, WorkspaceSkill } from '@agentport/core';
import {
  captureOutputDraft,
  hashMcpToken,
  RunFailure,
  toOutputStyleSelection,
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
  WORKSPACE_CONTAINER_DIR,
  wireFailureKind,
} from '@agentport/shared';
import type { Job } from 'bullmq';
import { and, asc, eq, or } from 'drizzle-orm';
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
  runWorkspaceDir,
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
import type { WorkspaceAssemblyInput } from './workspace-assembly.js';

type Db = ReturnType<typeof createDb>['db'];
type ServerRow = AgentDefinitionServer;
type AgentRow = typeof schema.agents.$inferSelect;

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
      input: WorkspaceAssemblyInput,
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
  const retryingEnqueueFailure =
    run?.status === 'failed' && run.errorKind === 'infra' && run.startedAt === null;
  if (!isActiveRunStatus(run?.status) && !retryingEnqueueFailure) {
    logger.info({ runId, status: run?.status }, 'run no longer pending, skipping');
    return;
  }
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
  if (subject === null) return;
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
        or(eq(schema.agentRuns.status, 'queued'), repo.runPredicates.neverStartedFailureFilter()),
      ),
    )
    .returning({ id: schema.agentRuns.id });
  if (claimed.length === 0) {
    runLog.info('run externally terminated before claim, skipping');
    return;
  }
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
    let outputsHostPath: string | null = null;
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

      runUiFormat = effectiveAgent.uiFormat === 'openui' ? 'openui' : 'markdown';

      const timeoutMs = effectiveAgent.timeoutMs;
      const sdkState = await repo.chat.getConversationSdkState(db, conversationId);
      if (!sdkState) throw new Error(`conversation ${conversationId} not found`);
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
      const chosenOutput = selectedOutput(userMessage.content);
      const regenerated = parsed.data.regenerateContent;
      const openuiContent =
        regenerated === undefined ? userMessage.content : regenerated.openuiAction;
      const taskPrompt = promptWithAttachments(
        promptWithSelectedOutput(promptWithOpenUiAction(openuiContent, prompt), chosenOutput),
        messageAttachments(userMessage.content),
      );
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
      const { serverNamesByAgent, serverRows } = loadRunServerBindings(bindingsByAgent);
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

      const rules = runMemoryPolicy.injectRules
        ? definition
          ? definition.rules
          : await repo.rules.listRules(db, agentId)
        : [];

      const styleRows = definition
        ? definition.outputStyles
        : await repo.outputStyles.listOutputStyles(db, agentId);
      const { outputStyles, selectedOutputStyle } = toOutputStyleSelection(styleRows);
      const workflows =
        effectiveAgent.parentId === null
          ? definition
            ? definition.workflows
            : await repo.workflows.listWorkflows(db, agentId)
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
      } = await writeWorkspace({
        agent: { ...effectiveAgent, serverNames: parentServerNames },
        runId,
        servers: serverRows.map((server) => ({
          name: server.name,
          entry: toEntry(server, sandboxApiUrl, config.APP_SECRET_KEY, runId, runToken),
        })),
        skills: skillsWithFiles,
        subAgents,
        rules,
        outputStyles,
        selectedOutputStyle,
        workflows,
        hooks: effectiveAgent.hooksEnabled ? effectiveAgent.hooksConfig : null,
        hookFiles,
        plugins: runPlugins,
        memoryPolicy: runMemoryPolicy,
      });
      await refreshSessionDirectory(workspaceDir, stableWorkspaceDir, {
        preserveMemoryMount: true,
      });
      runLog.info({ workspaceDir }, 'agent run started');

      sessionsDirForRun = sessionPaths.sessionsDir;

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
          path: `${WORKSPACE_CONTAINER_DIR}/.claude/plugins/${plugin.slug}`,
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
        ...(resumeSessionId === null ? {} : { resumeSessionId }),
        ...(forkFromMessageUuid === undefined ? {} : { forkFromMessageUuid }),
      };
      outcome = await runInSandbox({
        runId,
        timeoutMs,
        task,
        lease,
        signal: sandboxClosing.signal,
        env:
          run.channelId === null
            ? sandboxEnv(sandboxApiUrl, runId)
            : { ...sandboxEnv(sandboxApiUrl, runId), PACE_RUN_TRIGGER: 'channel' },
        logger: runLog,
        questions: {
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

    const retryable = isRetryable(outcome);
    const willRetry = retryable && job.attemptsMade + 1 < (job.opts.attempts ?? 1);
    const modelExecuted =
      outcome.status === 'succeeded' ||
      (outcome.inputTokens ?? 0) > 0 ||
      (outcome.outputTokens ?? 0) > 0 ||
      outcome.events.some((event) => event.type === 'tool_start' || event.type === 'tool_result');
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
          if (!willRetry) {
            outcome = {
              ...outcome,
              error: `${outcome.error ?? outcome.status}；${published.problem}`,
            };
          }
        }
      } catch (err) {
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
    await rm(runWorkspaceDir(workspacesDir, agentSlugForRun, runId), {
      recursive: true,
      force: true,
    }).catch((err: unknown) => runLog.warn({ err }, 'workspace cleanup failed'));
    if (lease && !leaseReleased) {
      await lease.release({ reuse: reuseSession }).catch((err: unknown) => {
        runLog.error({ err }, 'session lease release failed');
      });
    }
  }
}
