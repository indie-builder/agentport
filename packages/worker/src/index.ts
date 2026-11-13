import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { McpJsonEntry, WorkspacePlugin, WorkspaceSkill } from '@agentport/core';
import {
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
  ACTIVE_RUN_STATUSES,
  agentRunJobSchema,
  CONFIG_CONTAINER_DIR,
  EVAL_RUNS_QUEUE,
  effortSchema,
  knowledgeMcpEntry,
  type MemoryPolicy,
  permissionModeSchema,
  previewMcpEntry,
  RUNS_QUEUE,
  SESSION_CLEANUP_TIMEOUT_MS,
  serverInputSchema,
  uiFormatSchema,
} from '@agentport/shared';
import { createBunRedisClient, Worker } from 'bullmq';
import { RedisClient } from 'bun';
import { inArray } from 'drizzle-orm';
import pino, { type Logger } from 'pino';
import { loadConfig } from './config.js';
import { runAgentJob } from './runs/execute.js';
import { handleEvalJobFailed, runEvalJob } from './eval-job.js';
import { closeEvalRunQueue, evalFailureDiagnostics } from './eval-runner.js';
import { startKnowledgeWorker } from './knowledge/queue.js';
import { startKnowledgeReconciler } from './knowledge/reconcile.js';
import { startKnowledgeScheduler } from './knowledge/scheduler.js';
import { startMaintenanceWorker } from './maintenance.js';
import { type ModelProxy, startModelProxy } from './model-proxy.js';
import { registerNativePlugins } from './native-plugins.js';
import { startReconciler } from './scheduling/reconcile.js';
import { type RunAccessDenial } from './runs/run-access.js';
import {
  finalizeRun,
} from './runs/run-finish.js';
import {
  closeRunnerClient,
  configureRunnerClient,
} from './runner-client.js';
import { startRuntimeEnvironmentBuildWorker } from './runtime-environments/build.js';
import {
  ensureDefaultEnvironment,
  startDefaultEnvironmentRetry,
} from './runtime-environments/default.js';
import { startRuntimeEnvironmentBuildReconciler } from './runtime-environments/reconcile.js';
import { createRuntimeEnvironmentResolver } from './runtime-environments/resolve.js';
import { DockerSandboxProvider, resolveLocalImageId } from './sandbox/docker.js';
import { SandboxCleanupError } from './sandbox/provider.js';
import { closeSessionRuntime, startSessionCleanupChannel } from './sandbox/session-cleanup.js';
import { SessionSandboxes } from './sandbox/sessions.js';
import { registerSandboxProbe } from './sandbox-probe.js';
import { startScheduleScheduler } from './scheduling/scheduler.js';
import {
  writeRulesDirectory,
} from './session-workspace.js';
import { runShutdown } from './shutdown.js';
import { modelProxyUpstream } from './upstream.js';
import { version } from './version.js';

const config = loadConfig();
const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'worker', env: config.NODE_ENV, version },
});

// 缺关键配置时 loadConfig 已抛错，进程直接退出。
configureRunnerClient(config.REDIS_URL);

const workspacesDir = resolve(config.WORKSPACES_DIR);
// 沙盒挂载的源路径按宿主 daemon 解析；容器里写文件仍用 workspacesDir。
const hostWorkspacesDir = resolve(config.HOST_WORKSPACES_DIR ?? config.WORKSPACES_DIR);

// 沙盒在 bridge 网络里访问宿主 API；compose 部署时用服务名或宿主网关覆盖。
const sandboxApiUrl = config.SANDBOX_API_URL;

if (config.SANDBOX_EGRESS === 'none') {
  logger.warn(
    'SANDBOX_EGRESS=none: 沙盒无网络，HTTP MCP server、平台 /mcp 端点与模型 API 都将不可用',
  );
}

const { db, client } = createDb(config.DATABASE_URL);
const runConnection = createBunRedisClient(new RedisClient(config.REDIS_URL));
const evalConnection = createBunRedisClient(new RedisClient(config.REDIS_URL));
type Db = typeof db;
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
  maxActive: config.SANDBOX_MAX_ACTIVE,
  resolveRuntimeEnvironment,
  logger,
});

// 删除 API 在事务内经该信道确认空闲容器已关闭；启动时等待订阅成功，避免请求无监听静默超时。
const sessionCleanup = await startSessionCleanupChannel({
  redisUrl: config.REDIS_URL,
  logger,
  sessions: sessionSandboxes,
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
  workflows: Array<{ slug: string; content: string }>,
  hooks: Record<string, unknown> | null,
  hookFiles: Array<{ path: string; content: string; executable: boolean }>,
  plugins: WorkspacePlugin[],
  /** 本轮已解析的专家记忆策略：CLAUDE.md 的记忆文案必须与记忆挂载权限同源。 */
  memoryPolicy: MemoryPolicy,
): Promise<{ dir: string; hasSubAgents: boolean; hasWorkflows: boolean }> {
  // 生成式 UI 的工具目录与提示词、执行桥同源：这里查一次，渲染时写进 CLAUDE.md。
  const openuiTools =
    agent.uiFormat === 'openui' ? await repo.openui.listOpenUiTools(db, agent.id) : [];
  const files = renderWorkspace(
    toWorkspaceInput({
      agent: {
        ...agent,
        permissionMode: permissionModeSchema.parse(agent.permissionMode),
        uiFormat: uiFormatSchema.parse(agent.uiFormat),
        effort: effortSchema.nullable().parse(agent.effort),
      },
      servers,
      skills,
      subAgents: subAgents.map((row) => ({
        ...row,
        permissionMode: permissionModeSchema.parse(row.permissionMode),
        uiFormat: uiFormatSchema.parse(row.uiFormat),
        effort: effortSchema.nullable().parse(row.effort),
      })),
      rules,
      outputStyles,
      selectedOutputStyle,
      workflows,
      ...(hooks ? { hooks } : {}),
      hookFiles,
      openuiTools,
      plugins,
      memoryPolicy,
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
  // 工作流每次重建：先清旧目录，避免解绑/删除的工作流继续被 SDK 发现。
  const workflowsDir = join(dir, '.claude', 'workflows');
  await rm(workflowsDir, { recursive: true, force: true });
  if (files.workflows.length > 0) {
    await mkdir(workflowsDir, { mode: WORKSPACE_DIR_MODE, recursive: true });
    for (const workflow of files.workflows) {
      await writeFile(join(workflowsDir, `${workflow.slug}.js`), workflow.content, {
        encoding: 'utf8',
        mode: WORKSPACE_FILE_MODE,
      });
    }
  }
  // 项目规则每次重建：写到 .claude/rules/<slug>.md，由 project source 随会话加载。
  await writeRulesDirectory(join(dir, '.claude', 'rules'), files.rules);
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
  const hooksDir = join(dir, '.claude', 'hooks');
  await rm(hooksDir, { recursive: true, force: true });
  if (files.hookFiles.length > 0) {
    await mkdir(hooksDir, { mode: WORKSPACE_DIR_MODE, recursive: true });
    for (const file of files.hookFiles) {
      const filePath = join(hooksDir, file.path);
      await mkdir(join(filePath, '..'), { mode: WORKSPACE_DIR_MODE, recursive: true });
      await writeFile(filePath, file.content, {
        encoding: 'utf8',
        mode: file.executable ? WORKSPACE_DIR_MODE : WORKSPACE_FILE_MODE,
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
  await writeFile(settingsPath, files.settingsJson, {
    encoding: 'utf8',
    mode: WORKSPACE_FILE_MODE,
  });
  // mode 只在创建时生效；已存在的工作区（BullMQ 重试复用）要再 chmod 一次。
  await chmod(dir, WORKSPACE_DIR_MODE);
  await chmod(join(dir, '.claude'), WORKSPACE_DIR_MODE);
  await chmod(join(dir, '.mcp.json'), WORKSPACE_FILE_MODE);
  logger.debug(
    { runId, dir, mode: WORKSPACE_FILE_MODE.toString(8) },
    'workspace permissions applied',
  );
  return {
    dir,
    hasSubAgents: files.subAgents.length > 0,
    hasWorkflows: files.workflows.length > 0,
  };
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
    CLAUDE_CONFIG_DIR: CONFIG_CONTAINER_DIR,
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
    .where(inArray(schema.agentRuns.status, [...ACTIVE_RUN_STATUSES]));
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

/**
 * acquire 阶段已创建但无法确认删除的容器：runner 把 provider 的
 * SandboxCleanupError 放进 RunFailure.cause。普通 acquire 拒绝没有这个 id，说明没有遗留。
 */
function cleanupSandboxIdOf(err: unknown): string | undefined {
  if (err instanceof SandboxCleanupError) return err.sandboxId;
  if (err instanceof RunFailure && err.cause instanceof SandboxCleanupError) {
    return err.cause.sandboxId;
  }
  return undefined;
}

/**
 * 排队期间账户被停用或权限被撤销：在启动前明确失败，不建容器、不降级成服务身份。
 * 只改 queued，已被别的 worker 认领的运行交给现有取消/收尾路径。
 */
async function denyQueuedRun(
  db: Db,
  logger: Logger,
  runId: string,
  denial: RunAccessDenial,
): Promise<void> {
  const won = await finalizeRun({
    db,
    logger,
    runId,
    fromStatus: 'queued',
    event: { type: 'run_finished', status: 'failed', error: denial.message },
    values: { error: denial.message, errorKind: 'agent' },
    audit: {
      action: 'agent.run.denied',
      status: 'error',
      dedupeKey: `aud_denied_${runId.slice(4)}`,
    },
  });
  if (!won) logger.info({ runId }, 'run no longer queued, access denial skipped');
}

const worker = new Worker(
  RUNS_QUEUE,
  (job) =>
    runAgentJob(job, {
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
    }),
  { connection: runConnection, concurrency: config.AGENT_MAX_CONCURRENT },
);

worker.on('failed', async (job, err) => {
  logger.error({ jobId: job?.id, err }, 'job failed');
  // BullMQ increments attemptsMade before emitting failed.
  if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
  const parsed = agentRunJobSchema.safeParse(job.data);
  if (!parsed.success) return;
  const { runId, agentId } = parsed.data;
  try {
    const slug = await repo.agents.findAgentSlug(db, agentId);
    if (slug !== null) await rm(join(workspacesDir, slug, runId), { recursive: true, force: true });
  } catch (cleanupError) {
    logger.warn({ err: cleanupError, runId }, 'workspace cleanup failed');
  }
});

// 评估本身串行：并发固定 1。
const evalWorker = new Worker(
  EVAL_RUNS_QUEUE,
  (job) => runEvalJob({ db, logger, redisUrl: config.REDIS_URL, job }),
  { connection: evalConnection, concurrency: 1 },
);

evalWorker.on('failed', (job, err) => {
  // DB 错误原文可能含 SQL 参数；只记错误类型与 PG code。
  logger.error({ jobId: job?.id, ...evalFailureDiagnostics(err) }, 'eval job failed');
  // processor 前就终止的 deferred stalled failure 也在这里条件收口；事件回调不能留 unhandled rejection。
  handleEvalJobFailed({ db, logger, job, error: err }).catch((settleError: unknown) => {
    logger.error(
      { jobId: job?.id, ...evalFailureDiagnostics(settleError) },
      'eval job failure settlement failed',
    );
  });
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
  workspacesDir: config.WORKSPACES_DIR,
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
  // 必传：reconcile 只有在确认容器销毁后才允许收敛，不能把缺少清理当成成功。
  // expectedRunId 防止旧一轮 candidate 的清理误杀复用同一容器的后一个 run。
  cleanup: ({ conversationId, sandboxId, runId }) =>
    sessionSandboxes.cleanup(conversationId, sandboxId, runId),
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
 * SIGTERM：先 abort 取消进行中的沙盒拉取/创建与知识任务；聊天 run 最多等 10s 排空，
 * 沙盒 stop 与其余队列并发关闭，最后关闭 Redis / PG。
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
      close: () =>
        closeSessionRuntime({
          channel: sessionCleanup,
          sessions: sessionSandboxes,
          provider,
          timeoutMs: SESSION_CLEANUP_TIMEOUT_MS,
        }),
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
    database: {
      label: 'redis/postgres connections',
      close: async () => {
        await Promise.all([runConnection.quit(), evalConnection.quit()]);
        await client.close();
      },
    },
  });
  process.exit(code);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
logger.info('worker started');
