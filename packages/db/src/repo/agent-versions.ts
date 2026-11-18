import { isDeepStrictEqual } from 'node:util';
import { AppError } from '@agentport/core';
import type { Agent, AgentDefinition } from '@agentport/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database, DbHandle, Transaction } from '../client.js';
import { newId } from '../id.js';
import { agentVersions } from '../schema.js';
import { isPgConstraint } from './pg-errors.js';

export type AgentVersionRow = typeof agentVersions.$inferSelect;

export interface AgentVersionSummary {
  id: string;
  version: number;
  note: string | null;
  createdAt: string;
}

/** 事务内写入快照；版本号靠 (agent_id, version) 唯一约束兜底并发。 */
export async function insertAgentVersion(
  tx: Transaction,
  agentId: string,
  snapshot: Agent,
  definition: AgentDefinition | null = null,
  note: string | null = null,
): Promise<number> {
  const [row] = await tx
    .insert(agentVersions)
    .values({
      id: newId('agentVersion'),
      agentId,
      version: sql`(select coalesce(max(${agentVersions.version}), 0) + 1 from ${agentVersions} where ${agentVersions.agentId} = ${agentId})`,
      snapshot,
      definition,
      note,
    })
    .returning({ version: agentVersions.version });
  if (!row) throw new Error('agent version insert returned no row');
  return row.version;
}

function isVersionConflict(err: unknown): boolean {
  return isPgConstraint(err, ['23505'], 'agent_versions_agent_version_idx');
}

/** 并发下两个事务可能读到同一个 max；唯一约束冲突时整段事务重试一次。 */
export async function retryOnVersionConflict<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isVersionConflict(err)) throw err;
    try {
      return await run();
    } catch (retryErr) {
      if (!isVersionConflict(retryErr)) throw retryErr;
      // 版本冲突可重试：调用方重新读最新版本再写。
      throw new AppError('CONFLICT', 'agent version conflict, retry later', { retryable: true });
    }
  }
}

export async function listAgentVersions(
  db: Database,
  agentId: string,
): Promise<AgentVersionSummary[]> {
  const rows = await db
    .select({
      id: agentVersions.id,
      version: agentVersions.version,
      note: agentVersions.note,
      createdAt: agentVersions.createdAt,
    })
    .from(agentVersions)
    .where(eq(agentVersions.agentId, agentId))
    .orderBy(desc(agentVersions.version));
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

/** 最新快照版本号；智能体尚无快照时返回 null。 */
export async function latestAgentVersion(db: DbHandle, agentId: string): Promise<number | null> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${agentVersions.version})` })
    .from(agentVersions)
    .where(eq(agentVersions.agentId, agentId));
  return row?.max ?? null;
}

export async function getAgentVersion(
  db: DbHandle,
  agentId: string,
  version: number,
): Promise<AgentVersionRow | null> {
  const [row] = await db
    .select()
    .from(agentVersions)
    .where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.version, version)))
    .limit(1);
  return row ?? null;
}

export async function assertDefinitionResources(
  db: DbHandle | Transaction,
  definition: AgentDefinition,
): Promise<void> {
  if (definition.agent.parentId !== null || definition.resources.subAgents.length === 0) return;
  const children = await Promise.all(
    definition.resources.subAgents.map(async ({ id, name, publishedVersion }) => {
      if (publishedVersion === null) {
        throw new AppError(
          'INVALID_INPUT',
          `子智能体「${name}」尚未发布，无法固定版本；请先发布子智能体`,
        );
      }
      const version = await getAgentVersion(db, id, publishedVersion);
      if (!version) {
        throw new AppError(
          'INVALID_INPUT',
          `子智能体「${name}」的发布版本不存在；请重新发布子智能体`,
        );
      }
      return version.definition;
    }),
  );
  const resources = [definition, ...children.filter((child) => child !== null)].map(
    (item) => item.resources,
  );
  const servers = new Map<string, AgentDefinition['resources']['servers'][number]>();
  const serverNames = new Map<string, string>();
  resources
    .flatMap((item) => item.servers)
    .forEach((server) => {
      const snapshot = ({ name, kind, config, secretsEncrypted, tools }: typeof server) => ({
        name,
        kind,
        config,
        secretsEncrypted,
        tools: [...(tools ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
      });
      const nameOwner = serverNames.get(server.name);
      if (nameOwner !== undefined && nameOwner !== server.id) {
        throw new AppError(
          'INVALID_INPUT',
          `父子专家共享的 MCP Server 名称「${server.name}」对应不同资源；请重新命名或重新发布相关专家后再发布`,
        );
      }
      serverNames.set(server.name, server.id);
      const previous = servers.get(server.id);
      if (previous && !isDeepStrictEqual(snapshot(previous), snapshot(server))) {
        throw new AppError(
          'INVALID_INPUT',
          `父子专家共享的 MCP Server「${server.name}」快照内容不一致；请重新发布相关专家后再发布`,
        );
      }
      servers.set(server.id, server);
    });
  const skills = new Map<string, AgentDefinition['resources']['skills'][number]>();
  resources
    .flatMap((item) => item.skills)
    .forEach((skill) => {
      const snapshot = ({
        name,
        description,
        body,
        license,
        compatibility,
        metadata,
        files,
      }: typeof skill) => ({
        name,
        description,
        body,
        license,
        compatibility,
        metadata,
        files: files
          .map(({ path, content }) => ({ path, content }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      });
      const previous = skills.get(skill.slug);
      if (previous && !isDeepStrictEqual(snapshot(previous), snapshot(skill))) {
        throw new AppError(
          'INVALID_INPUT',
          `父子专家共享的技能「${skill.slug}」内容不一致；请重新发布相关专家后再发布`,
        );
      }
      skills.set(skill.slug, skill);
    });
}
