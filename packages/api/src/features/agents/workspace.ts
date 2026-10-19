import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { WorkspaceFiles } from '@agentport/core';
import { renderWorkspace, toMcpJsonEntry } from '@agentport/core';
import * as agentRepo from '@agentport/db/repo/agents.js';
import type { ServerInput } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { decryptSecrets } from '../servers/secrets.js';

type ServerRow = Awaited<ReturnType<typeof agentRepo.getBoundServers>>[number];

// 沙盒视角的 API 地址；compose 内是 http://api:3000，本机 Docker 用 host.docker.internal。
function sandboxApiUrl(): string {
  return process.env.SANDBOX_API_URL ?? 'http://host.docker.internal:3000';
}

// 与 worker 共用同一个环境变量；相对路径按进程 cwd 解析。
function workspacesDir(): string {
  return resolve(process.env.WORKSPACES_DIR ?? './data/workspaces');
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * DB 行 → 共享 ServerInput。env/headers 存在加密列里，所以这里留空、由 toMcpJsonEntry 的 secrets 参数合并。
 * generated server 在沙盒里看到的是平台自己的 /mcp/:id，而不是上游 baseUrl。
 */
function toEntry(row: ServerRow, secrets: Record<string, string>) {
  const common = { name: row.name, description: row.description };
  const config = row.config;

  if (row.kind === 'stdio') {
    const input: ServerInput = {
      ...common,
      kind: 'stdio',
      command: str(config.command),
      args: strArray(config.args),
      env: {},
    };
    return toMcpJsonEntry(input, secrets);
  }

  if (row.kind === 'http') {
    const input: ServerInput = { ...common, kind: 'http', url: str(config.url), headers: {} };
    return toMcpJsonEntry(input, secrets);
  }

  const token = str(config.mcpToken);
  return {
    type: 'http' as const,
    // 与 worker 写入的地址保持一致，否则同一次运行里两个进程会渲染出不同的 .mcp.json。
    url: `${sandboxApiUrl()}/mcp/${row.id}`,
    headers: { ...secrets, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  };
}

/** 渲染并落盘工作区；返回内容供文件预览接口直接回显。 */
export async function writeAgentWorkspace(
  app: FastifyInstance,
  agentId: string,
): Promise<WorkspaceFiles | null> {
  const agent = await agentRepo.getAgent(app.db, agentId);
  if (!agent) return null;
  // slug 来自 DB，但它是路径的一部分；越界值绝不能拼进文件系统。
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(agent.slug)) {
    throw Object.assign(new Error(`invalid agent slug: ${agent.slug}`), {
      statusCode: 500,
      code: 'INVALID_SLUG',
    });
  }

  const rows = await agentRepo.getBoundServers(app.db, agent.id);
  const servers = rows.map((row) => {
    const secrets = row.secretsEncrypted
      ? decryptSecrets(row.secretsEncrypted, app.config.APP_SECRET_KEY)
      : {};
    return { name: row.name, entry: toEntry(row, secrets) };
  });

  const files = renderWorkspace({
    agent: {
      slug: agent.slug,
      name: agent.name,
      model: agent.model,
      systemPrompt: agent.systemPromptMd,
      maxTurns: agent.maxTurns,
    },
    servers,
  });

  const dir = join(workspacesDir(), agent.slug);
  await mkdir(join(dir, '.claude', 'agents'), { recursive: true });
  await writeFile(join(dir, '.mcp.json'), files.mcpJson, 'utf8');
  await writeFile(join(dir, 'CLAUDE.md'), files.claudeMd, 'utf8');
  await writeFile(join(dir, '.claude', 'agents', `${agent.slug}.md`), files.agentMd, 'utf8');

  return files;
}
