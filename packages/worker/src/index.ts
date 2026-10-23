import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { McpJsonEntry, WorkspaceSkill } from '@agentport/core';
import {
  decryptSecrets,
  hashMcpToken,
  installProcessGuards,
  RunFailure,
  renderWorkspace,
  toWorkspaceInput,
  WORKSPACE_DIR_MODE,
  WORKSPACE_FILE_MODE,
} from '@agentport/core';
import { createDb, repo, schema } from '@agentport/db';
import {
  agentRunJobSchema,
  EVAL_RUNS_QUEUE,
  evalRunJobSchema,
  previewMcpEntry,
  RUNS_QUEUE,
  serverInputSchema,
  wireFailureKind,
} from '@agentport/shared';
import { Worker } from 'bullmq';
import { and, asc, eq, inArray } from 'drizzle-orm';
import pino from 'pino';
import { loadConfig } from './config.js';
import { closeEvalRunQueue, executeEvalRun } from './eval-runner.js';
import { startMaintenanceWorker } from './maintenance.js';
import { persistRunMessages } from './messages.js';
import { type ModelProxy, startModelProxy } from './model-proxy.js';
import { startReconciler } from './reconcile.js';
import type { SandboxRunOutcome } from './runner-client.js';
import {
  closeRunnerClient,
  configureRunnerClient,
  isRetryable,
  publishRun,
  runInSandbox,
} from './runner-client.js';
import { DockerSandboxProvider } from './sandbox/docker.js';
import { startScheduleTicker } from './scheduler.js';

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });

// 缺关键配置时 loadConfig 已抛错，进程直接退出。
configureRunnerClient(config.REDIS_URL);

const workspacesDir = resolve(config.WORKSPACES_DIR);
// 沙盒挂载的源路径按宿主 daemon 解析；容器里写文件仍用 workspacesDir。
const hostWorkspacesDir = resolve(config.HOST_WORKSPACES_DIR ?? config.WORKSPACES_DIR);

/** 容器内工作区路径 → 宿主路径，供 docker -v 使用。 */
function toHostWorkspacePath(dir: string): string {
  return join(hostWorkspacesDir, relative(workspacesDir, dir));
}
// 沙盒在 bridge 网络里访问宿主 API；compose 部署时用服务名或宿主网关覆盖。
const sandboxApiUrl = config.SANDBOX_API_URL;

if (config.SANDBOX_EGRESS === 'none') {
  logger.warn(
    'SANDBOX_EGRESS=none: 沙盒无网络，HTTP MCP server、平台 /mcp 端点与模型 API 都将不可用',
  );
} else if (config.SANDBOX_EGRESS === 'proxy' && !config.HTTPS_PROXY && !config.HTTP_PROXY) {
  logger.warn('SANDBOX_EGRESS=proxy but HTTPS_PROXY/HTTP_PROXY is unset: egress stays open');
}

/** proxy 模式没配代理时实际按 open 跑：别让日志声称在走代理。 */
const sandboxEgress =
  config.SANDBOX_EGRESS === 'proxy' && !config.HTTPS_PROXY && !config.HTTP_PROXY
    ? 'open'
    : config.SANDBOX_EGRESS;

const { db, pool } = createDb(config.DATABASE_URL);
const provider = new DockerSandboxProvider({
  memory: config.SANDBOX_MEMORY,
  cpus: config.SANDBOX_CPUS,
  pids: config.SANDBOX_PIDS,
  egress: sandboxEgress,
});

type ServerRow = typeof schema.servers.$inferSelect;
type AgentRow = typeof schema.agents.$inferSelect;
/** 子智能体行带上自己的技能；根智能体的技能单独传，避免混进根配置。 */
type SubAgentRow = AgentRow & { skills?: WorkspaceSkill[] };

function toEntry(
  server: ServerRow,
  apiUrl: string,
  secretKey: string,
  runId: string,
  runToken: string,
): McpJsonEntry {
  const secrets = server.secretsEncrypted ? decryptSecrets(server.secretsEncrypted, secretKey) : {};
  const input = serverInputSchema.parse({
    ...server.config,
    name: server.name,
    description: server.description,
    kind: server.kind,
  });
  // stdio 命令有意由容器内的 SDK 启动，须在沙盒镜像中可用；不在 worker 宿主执行。
  const entry = previewMcpEntry(
    { kind: input.kind, config: input },
    {
      ...(input.kind === 'stdio' ? input.env : input.headers),
      ...(input.kind === 'generated'
        ? { Authorization: `Bearer ${runToken}`, 'x-agentport-run-id': runId }
        : secrets),
    },
  );
  return input.kind === 'generated' && 'url' in entry
    ? { ...entry, url: `${apiUrl}/mcp/${server.id}` }
    : entry;
}

/** 每次 run 重写工作区：文件是 DB 的只读快照，prompt 只走 stdin。 */
async function writeWorkspace(
  agent: AgentRow,
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
): Promise<{ dir: string; hasSubAgents: boolean }> {
  const files = renderWorkspace(
    toWorkspaceInput({
      agent,
      servers,
      skills,
      subAgents,
      rules,
      outputStyles,
      selectedOutputStyle,
    }),
  );

  // 按 run 隔离：同一智能体并发运行时不能互相覆盖 .mcp.json / 技能 / 子智能体。
  const dir = join(workspacesDir, agent.slug, runId);
  const agentsDir = join(dir, '.claude', 'agents');
  const skillsDir = join(dir, '.claude', 'skills');
  // 子智能体每次重建：解绑后旧文件不能残留，否则 SDK 仍会发现它。
  await rm(agentsDir, { recursive: true, force: true });
  await mkdir(agentsDir, { mode: WORKSPACE_DIR_MODE, recursive: true });
  await writeFile(join(dir, '.mcp.json'), files.mcpJson, {
    encoding: 'utf8',
    mode: WORKSPACE_FILE_MODE,
  });
  await writeFile(join(dir, 'CLAUDE.md'), files.claudeMd, 'utf8');
  // 主智能体自己的 md 不落盘：放进 .claude/agents/ 会被 SDK 当成可委派子智能体，
  // 形成自我递归。它只用于 API 预览，CLAUDE.md 已承载主智能体上下文。
  for (const subAgent of files.subAgents) {
    await writeFile(join(agentsDir, `${subAgent.slug}.md`), subAgent.content, {
      encoding: 'utf8',
      mode: WORKSPACE_FILE_MODE,
    });
  }

  // 技能每次重建：先清掉旧目录，避免已解绑的技能残留。
  await rm(skillsDir, { recursive: true, force: true });
  for (const skill of files.skills) {
    const target = join(skillsDir, skill.slug);
    await mkdir(target, { mode: WORKSPACE_DIR_MODE, recursive: true });
    await writeFile(join(target, 'SKILL.md'), skill.content, {
      encoding: 'utf8',
      mode: WORKSPACE_FILE_MODE,
    });
    // 支持资源文件（scripts/、references/ 等）；path 已在写入时校验为安全相对路径。
    for (const file of skill.files) {
      const filePath = join(target, file.path);
      await mkdir(join(filePath, '..'), { mode: WORKSPACE_DIR_MODE, recursive: true });
      await writeFile(filePath, file.content, { encoding: 'utf8', mode: WORKSPACE_FILE_MODE });
    }
  }
  // 项目规则每次重建：写到 .claude/rules/<slug>.md，由 project source 随会话加载。
  const rulesDir = join(dir, '.claude', 'rules');
  await rm(rulesDir, { recursive: true, force: true });
  if (files.rules.length > 0) {
    await mkdir(rulesDir, { mode: WORKSPACE_DIR_MODE, recursive: true });
    for (const rule of files.rules) {
      await writeFile(join(rulesDir, `${rule.slug}.md`), rule.content, {
        encoding: 'utf8',
        mode: WORKSPACE_FILE_MODE,
      });
    }
  }
  // 自定义输出风格：写到 .claude/output-styles/<slug>.md；选中者写进 .claude/settings.json。
  const stylesDir = join(dir, '.claude', 'output-styles');
  await rm(stylesDir, { recursive: true, force: true });
  if (files.outputStyles.length > 0) {
    await mkdir(stylesDir, { mode: WORKSPACE_DIR_MODE, recursive: true });
    for (const style of files.outputStyles) {
      await writeFile(join(stylesDir, `${style.slug}.md`), style.content, {
        encoding: 'utf8',
        mode: WORKSPACE_FILE_MODE,
      });
    }
  }
  // settings.json 每次重写（无选中则删除）。outputStyle 必须写进这里，因为 runner 的
  // inline object-settings 优先级高于磁盘文件；runner 会把这里解析出的 outputStyle 一并带上，
  // 否则磁盘上的 settings.json 会被 inline settings 遮蔽。
  const settingsPath = join(dir, '.claude', 'settings.json');
  if (files.selectedOutputStyle) {
    await writeFile(
      settingsPath,
      `${JSON.stringify({ outputStyle: files.selectedOutputStyle }, null, 2)}\n`,
      { encoding: 'utf8', mode: WORKSPACE_FILE_MODE },
    );
  } else {
    await rm(settingsPath, { force: true });
  }
  // mode 只在创建时生效；已存在的工作区（BullMQ 重试复用）要再 chmod 一次。
  await chmod(dir, WORKSPACE_DIR_MODE);
  await chmod(join(dir, '.claude'), WORKSPACE_DIR_MODE);
  await chmod(join(dir, '.mcp.json'), WORKSPACE_FILE_MODE);
  logger.debug(
    { runId, dir, mode: WORKSPACE_FILE_MODE.toString(8) },
    'workspace permissions applied',
  );
  return { dir, hasSubAgents: files.subAgents.length > 0 };
}

/** 本机代理常监听 127.0.0.1，容器内该地址指向容器自身；改写成宿主别名。 */
function toHostUrl(value: string): string {
  return value.replace(
    /\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(?=[:/]|$)/,
    '//host.docker.internal',
  );
}

/**
 * 模型代理（D-17）。启用后沙盒只拿到代理地址与 run token，真实凭证留在 worker。
 * 未启用时回退到直接注入，启动日志会警告。
 */
let modelProxy: ModelProxy | null = null;

/** 容器只拿凭证与 API 地址；密钥不落盘。 */
function sandboxEnv(apiUrl: string, runId: string): Record<string, string> {
  const env: Record<string, string> = {
    SANDBOX_API_URL: apiUrl,
    // 根文件系统只读；SDK 写会话缓存的目录是 tmpfs（见 docker.ts）。
    CLAUDE_CONFIG_DIR: '/home/node/.claude',
  };
  if (modelProxy) {
    env.ANTHROPIC_BASE_URL = modelProxy.url;
    // 短期 token：run 结束即吊销；沙盒读不到真实模型密钥。
    env.ANTHROPIC_AUTH_TOKEN = modelProxy.issueToken(runId);
    env.ANTHROPIC_API_KEY = '';
  } else {
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const) {
      const value = config[key];
      if (value) env[key] = value;
    }
    if (config.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = toHostUrl(config.ANTHROPIC_BASE_URL);
  }

  // proxy 模式：把宿主上的代理地址传给沙盒，仍由容器自行出站。
  if (sandboxEgress === 'proxy') {
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY'] as const) {
      const value = config[key];
      if (value) env[key] = toHostUrl(value);
    }
    const noProxy = config.NO_PROXY ?? config.no_proxy;
    if (noProxy) env.NO_PROXY = noProxy;
  }
  return env;
}

/**
 * 模型代理必须在 worker 启动前就绪：sandboxEnv 在任务里同步读取它。
 * 未配置凭证时返回 null，随后回退到直接注入并打印警告。
 */
modelProxy = await startModelProxy({
  logger,
  port: config.MODEL_PROXY_PORT,
  // worker 可能在容器里：127.0.0.1 指向容器自身，网关在宿主上。
  upstreamBaseUrl: toHostUrl(config.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'),
  ...(config.ANTHROPIC_API_KEY ? { apiKey: config.ANTHROPIC_API_KEY } : {}),
  ...(config.ANTHROPIC_AUTH_TOKEN ? { authToken: config.ANTHROPIC_AUTH_TOKEN } : {}),
  resolveRun: async (token) => {
    // token 明文就是 runId；DB 只存 sha256，且要求 run 仍在 running。
    const row = await repo.runs.findRunByModelToken(db, hashMcpToken(token));
    return row;
  },
});
if (modelProxy) {
  logger.info('model credentials stay in the worker; sandbox gets a per-run proxy token');
} else {
  logger.warn(
    'model proxy disabled (no credential configured); sandbox receives the real model credential',
  );
}

/** Only derived run directories are pruned; queued/running runs may still need them. */
async function sweepStaleWorkspaces(): Promise<number> {
  const liveRuns = await db
    .select({ id: schema.agentRuns.id })
    .from(schema.agentRuns)
    .where(inArray(schema.agentRuns.status, ['queued', 'running']));
  const liveIds = new Set(liveRuns.map((run) => run.id));
  let removed = 0;
  const agents = await readdir(workspacesDir, { withFileTypes: true }).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    },
  );
  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    const agentDir = join(workspacesDir, agent.name);
    for (const run of await readdir(agentDir, { withFileTypes: true })) {
      if (!run.isDirectory() || !run.name.startsWith('run_') || liveIds.has(run.name)) continue;
      await rm(join(agentDir, run.name), { recursive: true, force: true });
      removed += 1;
    }
  }
  logger.info({ removed }, 'stale workspaces removed');
  return removed;
}

await sweepStaleWorkspaces();

const worker = new Worker(
  RUNS_QUEUE,
  async (job) => {
    const parsed = agentRunJobSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new Error(`invalid job payload: ${parsed.error.message}`);
    }
    const { runId, agentId, conversationId, prompt, history } = parsed.data;

    const [run] = await db
      .select({ status: schema.agentRuns.status })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, runId))
      .limit(1);
    // 排队取消由 API 的 queued → cancelled 更新负责发布终态，worker 不重复发布。
    if (run?.status !== 'queued' && run?.status !== 'running') {
      logger.info({ runId, status: run?.status }, 'run no longer pending, skipping');
      return;
    }
    // 只认领 queued：BullMQ 在 Redis 抖动后会重投递仍在 running 的任务，
    // 若这里也接受 running，同一 run 会被两个 worker 各跑一遍（重复计费、消息互相覆盖）。
    const claimed = await db
      .update(schema.agentRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.status, 'queued')));
    if (claimed.rowCount === 0) {
      logger.info({ runId }, 'run externally terminated before claim, skipping');
      return;
    }
    await publishRun(runId, { type: 'run_started', runId, conversationId }, logger);
    await repo.audit.writeAudit(db, logger, {
      actor: 'worker',
      action: 'agent.run.started',
      target: runId,
      status: 'ok',
      dedupeKey: `aud_started_${runId.slice(4)}`,
    });

    let outcome: SandboxRunOutcome;
    let runStartedAt = 0;
    let runLatencyMs: number | null = null;
    let workspaceDirForRun: string | null = null;
    try {
      const [agent] = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId))
        .limit(1);
      if (!agent) throw new Error(`agent ${agentId} not found`);

      const timeoutMs = agent.timeoutMs;
      // 按 run 签发短期 token：DB 只存 hash，明文只在本工作区的 .mcp.json 里。
      // 过期时间比 run 超时多 5 分钟，避免收尾阶段请求被截断。
      const runToken = randomBytes(32).toString('base64url');
      await repo.runs.setRunMcpToken(
        db,
        runId,
        hashMcpToken(runToken),
        new Date(Date.now() + timeoutMs + 5 * 60_000),
        modelProxy ? hashMcpToken(runId) : null,
      );

      const rows = await db
        .select({ server: schema.servers })
        .from(schema.agentServers)
        .innerJoin(schema.servers, eq(schema.agentServers.serverId, schema.servers.id))
        .where(eq(schema.agentServers.agentId, agentId));

      const skillRows = await db
        .select({
          id: schema.skills.id,
          slug: schema.skills.slug,
          name: schema.skills.name,
          description: schema.skills.description,
          body: schema.skills.body,
        })
        .from(schema.agentSkills)
        .innerJoin(schema.skills, eq(schema.agentSkills.skillId, schema.skills.id))
        .where(eq(schema.agentSkills.agentId, agentId));

      // 技能的官方支持资源文件（scripts/、references/ 等）随技能一起铺到工作区。
      const skillFileMap = await repo.skillFiles.getSkillFilesBySkillIds(
        db,
        skillRows.map((row) => row.id),
      );
      const skillsWithFiles = skillRows.map((row) => ({
        slug: row.slug,
        name: row.name,
        description: row.description,
        body: row.body,
        files: (skillFileMap.get(row.id) ?? []).map((f) => ({ path: f.path, content: f.content })),
      }));

      // 单层委派：只取直接子智能体；enabled 过滤在 toWorkspaceInput 里统一做。
      const subAgentRows: SubAgentRow[] = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.parentId, agentId))
        .orderBy(asc(schema.agents.id));
      // 子智能体的技能也要落盘，否则它们的 md 里声明的 skills 无从加载。
      const childSkills = await repo.agents.getBoundSkillsByAgentIds(
        db,
        subAgentRows.filter((row) => row.enabled).map((row) => row.id),
      );
      const subAgents = subAgentRows.map((row) => ({
        ...row,
        skills: childSkills.get(row.id) ?? [],
      }));

      const ruleRows = await repo.rules.listRules(db, agentId);
      const rules = ruleRows.map((r) => ({ slug: r.slug, content: r.content, globs: r.globs }));

      const styleRows = await repo.outputStyles.listOutputStyles(db, agentId);
      const outputStyles = styleRows.map((r) => ({
        slug: r.slug,
        description: r.description,
        keepCodingInstructions: r.keepCodingInstructions,
        body: r.body,
      }));
      const selectedOutputStyle = styleRows.find((r) => r.isSelected)?.slug ?? null;

      const { dir: workspaceDir, hasSubAgents } = await writeWorkspace(
        agent,
        runId,
        rows.map(({ server }) => ({
          name: server.name,
          entry: toEntry(server, sandboxApiUrl, config.APP_SECRET_KEY, runId, runToken),
        })),
        skillsWithFiles,
        subAgents,
        rules,
        outputStyles,
        selectedOutputStyle,
      );
      workspaceDirForRun = workspaceDir;
      logger.info({ runId, agentId, workspaceDir }, 'agent run started');

      // 长期记忆：宿主持久目录，跨 run 累积；挂到容器 CLAUDE_CONFIG_DIR/agent-memory，
      // runner 用 settings.autoMemoryDirectory 指过去。API 侧也读写同一目录。
      const memoryHostDir = join(workspacesDir, agent.slug, 'agent-memory');
      // 容器内以 uid 1000 运行并需读写记忆；跨 uid（Linux 下 worker 常为 root）要给足权限。
      await mkdir(memoryHostDir, { recursive: true, mode: 0o777 });
      await chmod(memoryHostDir, 0o777).catch(() => undefined);

      runStartedAt = Date.now();
      outcome = await runInSandbox({
        runId,
        timeoutMs,
        task: {
          prompt,
          ...(history === undefined ? {} : { history }),
          model: agent.model,
          maxTurns: agent.maxTurns,
          maxBudgetUsd: Number(agent.maxBudgetUsd),
          permissionMode: agent.permissionMode,
          mcpServers: rows.map(({ server }) => server.name),
          skills: skillRows.map((skill) => skill.slug),
          ...(agent.allowedTools.length > 0 ? { extraAllowedTools: agent.allowedTools } : {}),
          ...(agent.disallowedTools.length > 0
            ? { extraDisallowedTools: agent.disallowedTools }
            : {}),
          ...(agent.effort === null ? {} : { effort: agent.effort }),
          ...(agent.maxThinkingTokens === null
            ? {}
            : { maxThinkingTokens: agent.maxThinkingTokens }),
          ...(hasSubAgents ? { allowSubAgents: true } : {}),
        },
        workspaceDir: toHostWorkspacePath(workspaceDir),
        image: config.SANDBOX_IMAGE,
        env: sandboxEnv(sandboxApiUrl, runId),
        extraMounts: [
          {
            hostPath: join(hostWorkspacesDir, agent.slug, 'agent-memory'),
            containerPath: '/mnt/agent-memory',
            readonly: false,
          },
        ],
        provider,
        logger: logger.child({ runId }),
      });
      runLatencyMs = Date.now() - runStartedAt;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ err, runId }, 'agent run crashed');
      outcome = { status: 'failed', sandboxId: '', error, events: [] };
    }

    // run 结束（含崩溃）就吊销短期 token；reconcile 对卡死 run 也走同样的收尾。
    await repo.runs.clearRunMcpToken(db, runId).catch((err: unknown) => {
      logger.warn({ err, runId }, 'failed to clear run mcp token');
    });
    modelProxy?.revokeToken(runId);
    await repo.runs.clearModelToken(db, runId).catch((err: unknown) => {
      logger.warn({ err, runId }, 'failed to clear model token');
    });

    // 把本次 run 的 assistant 文本与工具调用写入会话，刷新后历史才完整。
    // 写库失败不能抛出：抛出会让 BullMQ 重跑整个沙盒并最终只留 reconcile 的
    // "worker lost track of this run"，真实原因反而被覆盖。记日志，继续写终态。
    try {
      await persistRunMessages(db, {
        agentId,
        conversationId,
        runId,
        events: outcome.events,
      });
    } catch (err) {
      // agent_runs.error 说明的是沙盒失败原因；消息丢失是另一件事，只进日志。
      logger.error({ err, runId }, 'failed to persist run messages');
    }

    const retryable = isRetryable(outcome);
    if (retryable && job.attemptsMade + 1 < (job.opts.attempts ?? 1)) {
      // 认领只接受 queued，所以重试前必须把行改回 queued 再抛错；
      // 否则下一次投递会被自己的守卫当成「外部已终止」而跳过。
      const requeued = await db
        .update(schema.agentRuns)
        .set({ status: 'queued', startedAt: null })
        .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.status, 'running')))
        .returning({ id: schema.agentRuns.id });
      if (requeued.length > 0) {
        logger.warn({ runId, attempt: job.attemptsMade + 1 }, 'retrying sandbox failure');
        throw new Error(`retryable sandbox failure: ${outcome.error ?? 'unknown'}`);
      }
    }

    const finished = await db
      .update(schema.agentRuns)
      .set({
        status: outcome.status,
        latencyMs: runLatencyMs ?? null,
        ...(outcome.sandboxId ? { sandboxId: outcome.sandboxId } : {}),
        endedAt: new Date(),
        costUsd: outcome.costUsd === undefined ? null : String(outcome.costUsd),
        turns: outcome.turns ?? null,
        sessionId: outcome.sessionId ?? null,
        inputTokens: outcome.inputTokens ?? null,
        outputTokens: outcome.outputTokens ?? null,
        error: outcome.error ?? null,
        errorKind: outcome.failure?.reason ?? null,
      })
      .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.status, 'running')));
    if (finished.rowCount === 0) {
      const current = await repo.chat.getRun(db, runId);
      if (!current || current.status === 'queued' || current.status === 'running') {
        logger.warn({ runId, status: current?.status }, 'run disappeared or is no longer terminal');
        return;
      }
      outcome = {
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
    }

    await publishRun(
      runId,
      {
        type: 'run_finished',
        status: outcome.status,
        ...(outcome.costUsd === undefined ? {} : { costUsd: outcome.costUsd }),
        ...(outcome.turns === undefined ? {} : { turns: outcome.turns }),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(outcome.failure ? { failureKind: wireFailureKind(outcome.failure.reason) } : {}),
      },
      logger,
    );
    // 运行结果进审计表：日志会滚动，审计长期保留。
    // 幂等：基础设施重试会重跑同一次运行，不能为一次运行写多条审计。
    await repo.audit.writeAudit(db, logger, {
      actor: 'worker',
      action: 'agent.run.finished',
      target: runId,
      status: outcome.status === 'succeeded' ? 'ok' : 'error',
      dedupeKey: `aud_${runId.slice(4)}`,
      ...(runLatencyMs === null ? {} : { durationMs: runLatencyMs }),
    });

    logger.info(
      { runId, status: outcome.status, costUsd: outcome.costUsd, latencyMs: runLatencyMs },
      'agent run finished',
    );

    // 能走到这里的运行已经结束；仍可重试的尝试在写终态之前抛出。
    if (workspaceDirForRun) {
      await rm(workspaceDirForRun, { recursive: true, force: true }).catch((err: unknown) => {
        logger.warn({ err, runId }, 'workspace cleanup failed');
      });
    }
    if (retryable && finished.rowCount !== 0) {
      throw new Error(`retryable sandbox failure: ${outcome.error ?? 'unknown'}`);
    }
  },
  { connection: { url: config.REDIS_URL }, concurrency: config.AGENT_MAX_CONCURRENT },
);

worker.on('failed', async (job, err) => {
  logger.error({ jobId: job?.id, err }, 'job failed');
  // BullMQ increments attemptsMade before emitting failed.
  if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
  const parsed = agentRunJobSchema.safeParse(job.data);
  if (!parsed.success) return;
  const { runId, agentId } = parsed.data;
  try {
    const [agent] = await db
      .select({ slug: schema.agents.slug })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId))
      .limit(1);
    if (agent) await rm(join(workspacesDir, agent.slug, runId), { recursive: true, force: true });
  } catch (cleanupError) {
    logger.warn({ err: cleanupError, runId }, 'workspace cleanup failed');
  }
});

// 评估本身串行：并发固定 1。
const evalWorker = new Worker(
  EVAL_RUNS_QUEUE,
  async (job) => {
    const parsed = evalRunJobSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new Error(`invalid eval job payload: ${parsed.error.message}`);
    }
    await executeEvalRun({
      db,
      logger,
      redisUrl: config.REDIS_URL,
      evalRunId: parsed.data.evalRunId,
    });
  },
  { connection: { url: config.REDIS_URL }, concurrency: 1 },
);

evalWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'eval job failed');
});

const maintenanceWorker = await startMaintenanceWorker({
  db,
  logger,
  redisUrl: config.REDIS_URL,
  retain: {
    runDays: config.RETAIN_RUN_DAYS,
    messageDays: config.RETAIN_MESSAGE_DAYS,
    agentVersions: config.RETAIN_AGENT_VERSIONS,
  },
});

const stopReconciler = startReconciler({
  db,
  logger,
  agentTimeoutMs: config.AGENT_TIMEOUT_MS,
  redisUrl: config.REDIS_URL,
});

installProcessGuards(logger);

logger.info('worker started');

const scheduleTicker = startScheduleTicker({
  db,
  logger,
  redisUrl: config.REDIS_URL,
});

const SHUTDOWN_WAIT_MS = 10_000;
const POOL_WAIT_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms).unref());
}

let shuttingDown = false;

/**
 * SIGTERM：先让 BullMQ 排空在跑的任务（最多 10s），仍未结束的沙盒由
 * docker rm -f 兜底；容器退出会推动任务收尾，再关闭 Redis / PG。
 */
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down');

  const closing = Promise.allSettled([worker.close(), evalWorker.close()]);
  await Promise.race([closing, sleep(SHUTDOWN_WAIT_MS)]);
  await maintenanceWorker.close();
  await scheduleTicker.stop();
  await stopReconciler();
  await provider.destroyAll();
  await Promise.race([closing, sleep(POOL_WAIT_MS)]);
  await closeEvalRunQueue();

  await modelProxy?.close();
  await closeRunnerClient();
  await Promise.race([pool.end(), sleep(POOL_WAIT_MS)]);
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
