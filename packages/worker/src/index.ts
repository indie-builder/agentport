import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { McpJsonEntry, WorkspacePlugin, WorkspaceSkill } from '@agentport/core';
import {
  captureOutputDraft,
  decryptSecrets,
  hashMcpToken,
  installProcessGuards,
  RunFailure,
  renderPlugin,
  renderWorkspace,
  toWorkspaceInput,
  WORKSPACE_DIR_MODE,
  WORKSPACE_FILE_MODE,
} from '@agentport/core';
import { createDb, repo, schema } from '@agentport/db';
import {
  agentRunJobSchema,
  EVAL_RUNS_QUEUE,
  effortSchema,
  evalRunJobSchema,
  knowledgeMcpEntry,
  messageAttachments,
  permissionModeSchema,
  previewMcpEntry,
  RUNS_QUEUE,
  type SandboxTaskInput,
  serverInputSchema,
  wireFailureKind,
} from '@agentport/shared';
import { Worker } from 'bullmq';
import { and, asc, eq, inArray } from 'drizzle-orm';
import pino from 'pino';
import { conversationInputsMount, promptWithAttachments } from './attachments.js';
import { loadConfig } from './config.js';
import { closeEvalRunQueue, executeEvalRun } from './eval-runner.js';
import { readForkUuidMap } from './fork-uuids.js';
import { startKnowledgeWorker } from './knowledge/queue.js';
import { startKnowledgeReconciler } from './knowledge/reconcile.js';
import { startKnowledgeScheduler } from './knowledge/scheduler.js';
import { startMaintenanceWorker } from './maintenance.js';
import { type PersistedMessage, persistRunMessages } from './messages.js';
import { type ModelProxy, startModelProxy } from './model-proxy.js';
import { registerNativePlugins } from './native-plugins.js';
import { promptWithOpenUiAction } from './openui-action.js';
import {
  lastMessageIdOfRun,
  prepareRunOutputs,
  promptWithSelectedOutput,
  publishRunOutputsIfSettled,
  recordOutputSandboxSettlement,
  selectedOutput,
} from './outputs.js';
import { startReconciler } from './reconcile.js';
import type { SandboxRunOutcome } from './runner-client.js';
import {
  acquireSessionSandbox,
  closeRunnerClient,
  configureRunnerClient,
  isRetryable,
  publishRun,
  runInSandbox,
} from './runner-client.js';
import { startRuntimeEnvironmentBuildWorker } from './runtime-environments/build.js';
import {
  ensureDefaultEnvironment,
  startDefaultEnvironmentRetry,
} from './runtime-environments/default.js';
import { startRuntimeEnvironmentBuildReconciler } from './runtime-environments/reconcile.js';
import { createRuntimeEnvironmentResolver } from './runtime-environments/resolve.js';
import { DockerSandboxProvider, resolveLocalImageId } from './sandbox/docker.js';
import { SessionSandboxes, type SessionSandboxLease } from './sandbox/sessions.js';
import { registerSandboxProbe } from './sandbox-probe.js';
import { startScheduleScheduler } from './scheduler.js';
import { loadRunServerBindings } from './server-bindings.js';
import { ensureSessionWorkspace, refreshSessionDirectory } from './session-workspace.js';
import { runShutdown } from './shutdown.js';
import { modelProxyUpstream } from './upstream.js';

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
}

const { db, pool } = createDb(config.DATABASE_URL);
/**
 * 惰性解析：只在真实创建容器时读线上版本。
 * 存活容器不因发布/回退替换，也不会为它重新解析。
 */
const resolveRuntimeEnvironment = createRuntimeEnvironmentResolver((environmentId) =>
  repo.runtimeEnvironments.resolveOnlineRuntimeEnvironment(db, environmentId),
);
/** 关停信号：abort 后 run 线不再新建容器，进行中的拉取/创建按取消语义收尾。 */
const sandboxClosing = new AbortController();
const provider = new DockerSandboxProvider({
  memory: config.SANDBOX_MEMORY,
  cpus: config.SANDBOX_CPUS,
  pids: config.SANDBOX_PIDS,
  egress: config.SANDBOX_EGRESS,
  closing: sandboxClosing.signal,
});

const sessionSandboxes = new SessionSandboxes({
  provider,
  idleTimeoutMs: config.SANDBOX_IDLE_TIMEOUT_MS,
  resolveRuntimeEnvironment,
  logger,
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
  // knowledge 不进入 serverInputSchema；URL 由运行时拼，只带 run 短期 token。
  if (server.kind === 'knowledge') {
    return knowledgeMcpEntry({ apiUrl, serverId: server.id, runId, runToken });
  }
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

/**
 * 插件是会话级能力，子智能体不绑定：SDK 的 `plugins` 没有按子智能体隔离的入口。
 * 上游已拒绝，这里只防御性忽略并留日志。
 */
async function loadAgentPlugins(agent: AgentRow): Promise<WorkspacePlugin[]> {
  if (agent.parentId !== null) {
    logger.warn({ agentId: agent.id }, 'sub-agent cannot bind plugins; ignoring bindings');
    return [];
  }
  const bindings = await repo.plugins.listAgentPluginBindings(db, agent.id);
  if (bindings.length === 0) return [];
  const filesByPlugin = await repo.plugins.getPluginFilesByPluginIds(
    db,
    bindings.map(({ plugin }) => plugin.id),
  );
  const plugins = bindings.map(({ plugin, allowHooks, allowMcp }) =>
    renderPlugin({
      slug: plugin.slug,
      runtimeName: plugin.runtimeName,
      allowHooks,
      allowMcp,
      files: (filesByPlugin.get(plugin.id) ?? []).map((file) => ({
        path: file.path,
        content: file.content,
        executable: file.executable,
      })),
    }),
  );
  // 只剩未授权组件时目录为空，交给 SDK 只会变成一次加载失败。
  return plugins.filter((plugin) => {
    if (plugin.files.length > 0) return true;
    logger.warn({ agentId: agent.id, slug: plugin.slug }, 'plugin has nothing authorized; skipped');
    return false;
  });
}

/** 每次 run 重写工作区：文件是 DB 的只读快照，prompt 只走 stdin。 */
async function writeWorkspace(
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
  plugins: WorkspacePlugin[],
): Promise<{ dir: string; hasSubAgents: boolean }> {
  // 生成式 UI 的工具目录与提示词、执行桥同源：这里查一次，渲染时写进 CLAUDE.md。
  const openuiTools =
    agent.uiFormat === 'openui' ? await repo.openui.listOpenUiTools(db, agent.id) : [];
  const files = renderWorkspace(
    toWorkspaceInput({
      agent,
      servers,
      skills,
      subAgents,
      rules,
      outputStyles,
      selectedOutputStyle,
      openuiTools,
      plugins,
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
  // 插件每次重建：解绑或撤销授权后旧组件不能残留，否则 SDK 仍会按目录加载。
  const pluginsDir = join(dir, '.claude', 'plugins');
  await rm(pluginsDir, { recursive: true, force: true });
  if (files.plugins.length > 0) {
    await mkdir(pluginsDir, { mode: WORKSPACE_DIR_MODE, recursive: true });
    for (const plugin of files.plugins) {
      const root = join(pluginsDir, plugin.slug);
      for (const file of plugin.files) {
        const filePath = join(root, file.path);
        await mkdir(join(filePath, '..'), { mode: WORKSPACE_DIR_MODE, recursive: true });
        await writeFile(filePath, file.content, {
          encoding: 'utf8',
          // 可执行脚本用 0700：同一模式下既保留 x 位，也只对属主开放。
          mode: file.executable ? WORKSPACE_DIR_MODE : WORKSPACE_FILE_MODE,
        });
      }
    }
    await chmod(pluginsDir, WORKSPACE_DIR_MODE);
  }
  // settings.json 与预览同源（renderWorkspace），outputStyle 写在这里由 project settings 加载。
  // inline settings 与磁盘文件按 key 合并：只覆盖同名 key，未指定的字段仍继承磁盘值。
  const settingsPath = join(dir, '.claude', 'settings.json');
  if (files.settingsJson !== null) {
    await writeFile(settingsPath, files.settingsJson, {
      encoding: 'utf8',
      mode: WORKSPACE_FILE_MODE,
    });
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

/** 沙盒里的地址：容器内 127.0.0.1 指向容器自身，必须改写成宿主别名。 */
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
    // 会话容器把持久 sessions 目录挂到 /home/node/.claude（见 sessions.ts），
    // 这里指定 SDK 使用同一路径；没有会话挂载的一次性容器由 docker.ts 提供 tmpfs。
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
  if (config.SANDBOX_EGRESS === 'proxy') {
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
  // worker 在容器里时 127.0.0.1 指向容器自身，网关在宿主上；宿主直跑则原样保留。
  upstreamBaseUrl: modelProxyUpstream(config.ANTHROPIC_BASE_URL),
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

/**
 * 默认环境只登记一次：不存在时先确保 SANDBOX_IMAGE 本地可用（缺失则 pull），
 * 再用实际镜像 ID 建首个线上版本；已存在时 repo 原样返回，不随环境变量推进线上指针。
 * 失败不阻塞 worker 起服务，但明确报错并定时重试，直到登记成功或关闭。
 */
const defaultEnvironmentDeps = {
  store: {
    getDefault: () => repo.runtimeEnvironments.getDefaultRuntimeEnvironment(db),
    register: async (image: { imageTag: string; imageId: string }) => {
      await repo.runtimeEnvironments.ensureDefaultRuntimeEnvironment(db, image);
    },
  },
  ensureImage: (image: string, signal: AbortSignal) => provider.ensureImage(image, signal),
  resolveImageId: resolveLocalImageId,
  sandboxImage: config.SANDBOX_IMAGE,
  signal: sandboxClosing.signal,
  logger,
};
let stopDefaultEnvironmentRetry: (() => Promise<void>) | undefined;
try {
  await ensureDefaultEnvironment(defaultEnvironmentDeps);
} catch (err) {
  logger.error(
    { err, image: config.SANDBOX_IMAGE },
    'default runtime environment registration failed; sandbox creation will fail until it succeeds; retrying',
  );
  stopDefaultEnvironmentRetry = startDefaultEnvironmentRetry(defaultEnvironmentDeps);
}

const worker = new Worker(
  RUNS_QUEUE,
  async (job) => {
    const parsed = agentRunJobSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new Error(`invalid job payload: ${parsed.error.message}`);
    }
    const { runId, agentId, conversationId, prompt } = parsed.data;

    const [run] = await db
      .select({ status: schema.agentRuns.status, agentVersion: schema.agentRuns.agentVersion })
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
        agentSlugForRun = agent.slug;
        const sessionPaths = await ensureSessionWorkspace({
          workspacesDir,
          slug: agent.slug,
          conversationId,
        });
        const inputsMount = await conversationInputsMount({
          workspacesDir,
          hostWorkspacesDir,
          slug: agent.slug,
          conversationId,
        });
        if (inputsMount === null) throw new Error('Session inputs directory was not prepared');
        lease = await acquireSessionSandbox({
          runId,
          manager: sessionSandboxes,
          logger,
          signal: sandboxClosing.signal,
          spec: {
            agentId,
            conversationId,
            runtimeEnvironmentId: agent.runtimeEnvironmentId,
            workspaceDir: toHostWorkspacePath(sessionPaths.workspaceDir),
            outputsDir: toHostWorkspacePath(sessionPaths.outputsDir),
            inputsDir: inputsMount.hostPath,
            memoryDir: toHostWorkspacePath(sessionPaths.memoryDir),
            sessionsDir: toHostWorkspacePath(sessionPaths.sessionsDir),
          },
        });
        stableWorkspaceDir = sessionPaths.workspaceDir;
        stableOutputsDir = sessionPaths.outputsDir;

        // 记录容器实际使用的身份：复用存活容器时是旧版本，不谎报当前线上。
        // 必须落库成功才能开始任务；失败交给外层 catch 释放 lease。
        const runtimeEnvironment = lease.runtimeEnvironment;
        await db
          .update(schema.agentRuns)
          .set({
            runtimeEnvironmentId: runtimeEnvironment.environmentId,
            runtimeEnvironmentName: runtimeEnvironment.environmentName,
            runtimeEnvironmentVersionId: runtimeEnvironment.versionId,
            runtimeEnvironmentImageId: runtimeEnvironment.imageId,
          })
          .where(eq(schema.agentRuns.id, runId));

        // 消息级快照：历史渲染按这一轮落库的格式，切换开关不影响已存消息。
        runUiFormat = agent.uiFormat === 'openui' ? 'openui' : 'markdown';

        // 版本只做 provenance：执行始终用当前配置，不一致仅告警。
        try {
          const pinnedVersion = run?.agentVersion ?? null;
          const currentVersion = await repo.agentVersions.latestAgentVersion(db, agentId);
          if (
            pinnedVersion !== null &&
            currentVersion !== null &&
            pinnedVersion !== currentVersion
          ) {
            logger.warn(
              { runId, pinnedVersion, currentVersion },
              'agent config changed since enqueue; executing current config',
            );
          }
        } catch (err) {
          logger.warn({ err, runId }, 'agent version drift check failed');
        }

        const timeoutMs = agent.timeoutMs;
        // 续聊状态只从 DB 取：队列消息不带历史，重试时也不会用陈旧上下文覆盖会话。
        const sdkState = await repo.chat.getConversationSdkState(db, conversationId);
        if (!sdkState) throw new Error(`conversation ${conversationId} not found`);
        // 本轮用户消息在准入时已落库；runner 用它（或这里补生成的 uuid）发首条消息。
        const [userMessage] = await db
          .select({
            id: schema.messages.id,
            content: schema.messages.content,
            sdkMessageUuid: schema.messages.sdkMessageUuid,
          })
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.runId, runId),
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
        const taskPrompt = promptWithAttachments(
          promptWithSelectedOutput(
            promptWithOpenUiAction(userMessage.content, prompt),
            chosenOutput,
          ),
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

        // 单层委派：只取直接子智能体；enabled 过滤在 toWorkspaceInput 里统一做。
        const subAgentRows: SubAgentRow[] = await db
          .select()
          .from(schema.agents)
          .where(eq(schema.agents.parentId, agentId))
          .orderBy(asc(schema.agents.id));
        const enabledChildren = subAgentRows.filter((row) => row.enabled);

        // 工作区 .mcp.json 是父 + 启用子级的并集：子级按名字引用根条目，
        // 在非交互会话里无需信任目录即可加载；父级看不到子级工具由渲染与 hook 共同限制。
        const { serverNamesByAgent, serverRows } = await loadRunServerBindings(
          db,
          agentId,
          subAgentRows,
        );
        const parentServerNames = serverNamesByAgent.get(agentId) ?? [];

        const skillRows = await db
          .select({
            id: schema.skills.id,
            slug: schema.skills.slug,
            name: schema.skills.name,
            description: schema.skills.description,
            body: schema.skills.body,
            license: schema.skills.license,
            compatibility: schema.skills.compatibility,
            metadata: schema.skills.metadata,
          })
          .from(schema.agentSkills)
          .innerJoin(schema.skills, eq(schema.agentSkills.skillId, schema.skills.id))
          .where(eq(schema.agentSkills.agentId, agentId));

        // 子智能体的技能也要落盘，否则它们的 md 里声明的 skills 无从加载。
        const childSkills = await repo.agents.getBoundSkillsByAgentIds(
          db,
          enabledChildren.map((row) => row.id),
        );
        // 根技能和启用子智能体的技能共用一次资源查询，根白名单仍只来自 skillRows。
        const skillFileMap = await repo.skillFiles.getSkillFilesBySkillIds(db, [
          ...new Set([...skillRows, ...[...childSkills.values()].flat()].map((row) => row.id)),
        ]);
        const withFiles = (row: (typeof skillRows)[number]) => ({
          ...repo.skills.toSkillDefinition(row),
          files: (skillFileMap.get(row.id) ?? []).map((f) => ({
            path: f.path,
            content: f.content,
          })),
        });
        const skillsWithFiles = skillRows.map(withFiles);
        const subAgents = subAgentRows.map((row) => ({
          ...row,
          skills: (childSkills.get(row.id) ?? []).map(withFiles),
          // 子级 MCP 归属：渲染只列表自己绑定的，运行时 hook 也按这份校验。
          serverNames: serverNamesByAgent.get(row.id) ?? [],
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
        const runPlugins = await loadAgentPlugins(agent);

        const { dir: workspaceDir, hasSubAgents } = await writeWorkspace(
          { ...agent, serverNames: parentServerNames },
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
          runPlugins,
        );
        await refreshSessionDirectory(workspaceDir, stableWorkspaceDir);
        logger.info({ runId, agentId, workspaceDir }, 'agent run started');

        sessionsDirForRun = sessionPaths.sessionsDir;

        // 草稿以最新完整快照为基线，仅用用户所选旧版覆盖指定文件。
        // 独立 rw 挂载到 /mnt/outputs，定义挂载 /workspace 仍只读。
        const preparedOutputs = await prepareRunOutputs({
          workspacesDir,
          hostWorkspacesDir,
          slug: agent.slug,
          conversationId,
          runId,
          ...(chosenOutput === null
            ? {}
            : { sourceRunId: chosenOutput.runId, sourcePath: chosenOutput.path }),
        });
        outputsHostPath = preparedOutputs.hostPath;
        await refreshSessionDirectory(
          join(workspacesDir, relative(hostWorkspacesDir, preparedOutputs.hostPath)),
          stableOutputsDir,
        );

        stableOutputsPrepared = true;
        runStartedAt = Date.now();
        const task: SandboxTaskInput = {
          prompt: taskPrompt,
          model: agent.model,
          maxTurns: agent.maxTurns,
          maxBudgetUsd: Number(agent.maxBudgetUsd),
          permissionMode: permissionModeSchema.parse(agent.permissionMode),
          mcpServers: parentServerNames,
          skills: skillRows.map((skill) => skill.slug),
          extraAllowedTools: agent.allowedTools,
          extraDisallowedTools: agent.disallowedTools,
          ...(agent.effort === null ? {} : { effort: effortSchema.parse(agent.effort) }),
          ...(agent.maxThinkingTokens === null
            ? {}
            : { maxThinkingTokens: agent.maxThinkingTokens }),
          allowSubAgents: hasSubAgents,
          maxFieldBytes: config.SANDBOX_MAX_FIELD_BYTES,
          plugins: runPlugins.map((plugin) => ({
            path: `/workspace/.claude/plugins/${plugin.slug}`,
            runtimeName: plugin.runtimeName,
            skills: plugin.skillNames,
            mcpServers: plugin.mcpServerNames,
            hasAgents: plugin.hasAgents,
          })),
          subAgents: enabledChildren.map((row) => ({
            slug: row.slug,
            servers: serverNamesByAgent.get(row.id) ?? [],
            skills: (childSkills.get(row.id) ?? []).map((skill) => skill.slug),
          })),
          userMessageUuid,
          // 首次空会话不 resume：没有 transcript 时传了只会让 CLI 找不到会话。
          ...(sdkState.sdkSessionId === null ? {} : { resumeSessionId: sdkState.sdkSessionId }),
          ...(sdkState.forkFromSdkMessageUuid === null
            ? {}
            : { forkFromMessageUuid: sdkState.forkFromSdkMessageUuid }),
        };
        outcome = await runInSandbox({
          runId,
          timeoutMs,
          task,
          lease,
          signal: sandboxClosing.signal,
          env: sandboxEnv(sandboxApiUrl, runId),
          logger: logger.child({ runId }),
          // 问题先落库再推界面；轮询答案也只读这条 run 的记录。
          questions: {
            // 期限由 runner 在容器实际开始时给出，创建耗时不计入。
            request: (event, expiresAt) =>
              repo.questions.createQuestion(db, {
                runId,
                requestId: event.requestId,
                toolUseId: event.toolUseId,
                questions: event.questions,
                expiresAt,
              }),
            list: () => repo.questions.listQuestions(db, runId),
            close: (reason, requestId) =>
              repo.questions.closeQuestions(db, runId, reason, requestId),
          },
        });
        runLatencyMs = Date.now() - runStartedAt;
        leaseReleased = outcome.leaseReleased === true;
        reuseSession =
          outcome.settlement.state === 'stopped' &&
          (outcome.status === 'succeeded' || outcome.status === 'cancelled') &&
          !leaseReleased;
      } catch (err) {
        const error = err instanceof RunFailure || err instanceof Error ? err.message : String(err);
        logger.error({ err, runId }, 'agent run crashed');
        outcome = {
          status: err instanceof RunFailure && err.reason === 'cancelled' ? 'cancelled' : 'failed',
          ...(err instanceof RunFailure ? { failure: err } : {}),
          sandboxId: lease?.sandboxId ?? '',
          settlement: { state: 'unconfirmed', error },
          error,
          events: [],
        };
        if (lease && !leaseReleased) {
          leaseReleased = true;
          try {
            await lease.release({ reuse: false });
            outcome.settlement = { state: 'stopped', code: null, signal: null };
          } catch (cleanupError) {
            outcome.cleanupError =
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
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
            logger.error({ err, runId }, 'failed to remove idle workspace mcp credentials');
            if (lease && !leaseReleased) {
              leaseReleased = true;
              try {
                await lease.release({ reuse: false });
              } catch (cleanupError) {
                outcome.cleanupError =
                  cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
                outcome.settlement = { state: 'unconfirmed', error: outcome.cleanupError };
                logger.error({ err: cleanupError, runId }, 'sandbox cleanup failed');
              }
            }
          }
        }
      }
      await repo.runs.clearRunMcpToken(db, runId).catch((err: unknown) => {
        logger.warn({ err, runId }, 'failed to clear run mcp token');
      });
      modelProxy?.revokeToken(runId);
      await repo.runs.clearModelToken(db, runId).catch((err: unknown) => {
        logger.warn({ err, runId }, 'failed to clear model token');
      });

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
          outputSettlementError = err instanceof Error ? err.message : String(err);
          logger.error({ err, runId }, 'failed to record output sandbox settlement');
        }
      }

      // 把本次 run 的 assistant 文本与工具调用写入会话，刷新后历史才完整。
      // SDK session 与 fork 后的 uuid 映射同事务落库：只存一半会让续聊对不上 transcript。
      // 写库失败不能抛出：抛出会让 BullMQ 重跑整个沙盒并最终只留 reconcile 的
      // "worker lost track of this run"，真实原因反而被覆盖。记日志，继续写终态。
      const forked = outcome.events.find((event) => event.type === 'session_forked');
      let persistedMessages: PersistedMessage[] = [];
      let messagesWritten = false;
      let messageSaveError: string | undefined;
      try {
        // 分支首轮：从宿主 transcript 的 forkedFrom 算新旧 uuid 映射，再与消息同事务写入。
        const uuidMap =
          forked?.type === 'session_forked' && sessionsDirForRun !== null
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
          ...(outcome.sessionId === undefined ? {} : { sdkSessionId: outcome.sessionId }),
          ...(uuidMap === undefined ? {} : { uuidMap }),
          uiFormat: runUiFormat,
        });
        messagesWritten = persisted.written;
        persistedMessages = persisted.messages;
        if (!persisted.written) messageSaveError = '消息保存被拒绝，运行或会话已由外部终止';
      } catch (err) {
        messageSaveError = err instanceof Error ? err.message : String(err);
        logger.error({ err, runId }, 'failed to persist run messages');
      }

      const retryable = isRetryable(outcome);
      const willRetry = retryable && job.attemptsMade + 1 < (job.opts.attempts ?? 1);
      if (!messagesWritten && !willRetry) {
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
            logger.warn({ runId, problem: published.problem }, 'run outputs not published');
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
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err, runId }, 'failed to publish run outputs');
          if (!willRetry) {
            outcome = {
              ...outcome,
              error: `${outcome.error ?? outcome.status}；产出发布失败：${message}`,
            };
          }
        }
      }

      if (willRetry) {
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
          logger.warn(
            { runId, status: current?.status },
            'run disappeared or is no longer terminal',
          );
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
      }

      await publishRun(
        runId,
        {
          type: 'run_finished',
          status: outcome.status,
          ...(persistedMessages.length === 0 ? {} : { messageIds: persistedMessages }),
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

      if (retryable && finished.rowCount !== 0) {
        throw new Error(`retryable sandbox failure: ${outcome.error ?? 'unknown'}`);
      }
    } finally {
      // run 临时渲染可删；稳定挂载与持久 transcript、附件、记忆留给下一轮。
      await rm(join(workspacesDir, agentSlugForRun, runId), { recursive: true, force: true }).catch(
        (err: unknown) => logger.warn({ err, runId }, 'workspace cleanup failed'),
      );
      if (lease && !leaseReleased) {
        await lease.release({ reuse: reuseSession }).catch((err: unknown) => {
          logger.error({ err, runId }, 'session lease release failed');
        });
      }
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

// stdio 试连走独立队列与独立容器入口，不影响 run 消费。
const sandboxProbe = await registerSandboxProbe(config, resolveRuntimeEnvironment);
const nativePlugins = await registerNativePlugins(config, resolveRuntimeEnvironment);

// 运行环境构建：只写版本行，成功不自动发布。
const runtimeEnvironmentBuildStore = {
  claimBuild: async (versionId: string) => {
    const version = await repo.runtimeEnvironments.claimRuntimeEnvironmentBuild(db, versionId);
    return version === null
      ? null
      : {
          versionId: version.id,
          dockerfile: version.dockerfile,
          baseImageId: version.baseImageId,
        };
  },
  appendBuildLog: (versionId: string, chunk: string) =>
    repo.runtimeEnvironments.appendRuntimeEnvironmentBuildLog(db, versionId, chunk),
  completeBuild: async (
    versionId: string,
    image: { imageTag: string; imageId: string; baseImageId: string },
  ) => {
    await repo.runtimeEnvironments.completeRuntimeEnvironmentBuild(db, versionId, image);
  },
  failBuild: async (versionId: string, error: string) => {
    await repo.runtimeEnvironments.failRuntimeEnvironmentBuild(db, versionId, error);
  },
};
const runtimeEnvironmentBuilds = await startRuntimeEnvironmentBuildWorker({
  store: runtimeEnvironmentBuildStore,
  logger,
  redisUrl: config.REDIS_URL,
});
// 崩溃恢复：终态收回卡在 queued/building 的版本，不留下假的构建中。
const stopRuntimeEnvironmentBuildReconciler = startRuntimeEnvironmentBuildReconciler({
  store: {
    ...runtimeEnvironmentBuildStore,
    listPendingBuilds: () => repo.runtimeEnvironments.listPendingRuntimeEnvironmentBuilds(db),
  },
  logger,
  redisUrl: config.REDIS_URL,
});

const stopReconciler = startReconciler({
  db,
  logger,
  agentTimeoutMs: config.AGENT_TIMEOUT_MS,
  redisUrl: config.REDIS_URL,
});

installProcessGuards(logger);

// 知识任务走独立队列，不占聊天 run 的并发额度。
const knowledgeWorker = await startKnowledgeWorker({
  db,
  logger,
  redisUrl: config.REDIS_URL,
  knowledgeDir: config.KNOWLEDGE_DIR,
  wikiModel: config.KNOWLEDGE_WIKI_MODEL,
  decrypt: (payload) => decryptSecrets(payload, config.APP_SECRET_KEY),
  parser: { url: config.DOCLING_URL, key: config.DOCLING_TOKEN },
  trustedHosts: config.KNOWLEDGE_PRIVATE_HOST_ALLOWLIST.split(',')
    .map((host) => host.trim())
    .filter((host) => host !== ''),
});

// 崩溃恢复：DB 的 queued/running 与知识队列实际状态对账。
const stopKnowledgeReconciler = startKnowledgeReconciler({
  db,
  logger,
  redisUrl: config.REDIS_URL,
});

// sync_cron 的权威来源是库：启动同步一次，之后周期对账。
const knowledgeScheduler = startKnowledgeScheduler({
  db,
  logger,
  redisUrl: config.REDIS_URL,
});
await knowledgeScheduler.sync().catch((err: unknown) => {
  logger.error({ err }, 'knowledge scheduler sync failed');
});

logger.info('worker started');

// 启动即对账一次：Redis 里的 Job Scheduler 以库为准补齐/清理。
const scheduleScheduler = startScheduleScheduler({
  db,
  logger,
  redisUrl: config.REDIS_URL,
});
await scheduleScheduler.sync().catch((err: unknown) => {
  logger.error({ err }, 'schedule reconcile failed');
});

let shuttingDown = false;

/**
 * SIGTERM：先让聊天 run 排空最多 10s；其余队列并发关闭（知识任务会 abort 活跃任务），
 * 沙盒不等待它们排空，最后关闭 Redis / PG。
 */
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down');

  const code = await runShutdown({
    // 关停后不再启动新容器；进行中的拉取/创建按取消语义收尾。
    abort: () => sandboxClosing.abort(),
    logError: (label, err) => logger.error({ err }, `${label} cleanup failed`),
    workers: [
      { label: 'main worker', close: () => worker.close() },
      { label: 'eval worker', close: () => evalWorker.close() },
    ],
    provider: {
      label: 'sandbox provider',
      close: async () => {
        try {
          await sessionSandboxes.close();
        } finally {
          await provider.destroyAll();
        }
      },
    },
    steps: [
      { label: 'maintenance worker', close: () => maintenanceWorker.close() },
      { label: 'knowledge worker', close: () => knowledgeWorker.close() },
      { label: 'knowledge scheduler', close: () => knowledgeScheduler.close() },
      { label: 'knowledge reconciler', close: () => stopKnowledgeReconciler() },
      { label: 'sandbox probe', close: () => sandboxProbe.close() },
      { label: 'native plugins', close: () => nativePlugins.close() },
      {
        label: 'default runtime environment retry',
        close: async () => stopDefaultEnvironmentRetry?.(),
      },
      { label: 'runtime environment builds', close: () => runtimeEnvironmentBuilds.close() },
      {
        label: 'runtime environment build reconciler',
        close: () => stopRuntimeEnvironmentBuildReconciler(),
      },
      { label: 'schedule scheduler', close: () => scheduleScheduler.close() },
      { label: 'reconciler', close: () => stopReconciler() },
    ],
    finalSteps: [
      { label: 'eval queue', close: () => closeEvalRunQueue() },
      { label: 'model proxy', close: () => modelProxy?.close() ?? Promise.resolve() },
      { label: 'runner client', close: () => closeRunnerClient() },
    ],
    pool: { label: 'postgres pool', close: () => pool.end() },
  });
  process.exit(code);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
