import { searchContract } from '@agentport/contract/search';
import { repo } from '@agentport/db';
import type { PermissionId, SearchItem } from '@agentport/shared';
import { implement } from '@orpc/server';
import { accessFilter, requireUser, resourceAccessFilter } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { collectPersonalOutputs } from './outputs.js';

const os = implement(searchContract).$context<RequestContext>();

function hasGrant(context: RequestContext, permissionId: PermissionId): boolean {
  return requireUser(context).grants.some((grant) => grant.permissionId === permissionId);
}

async function agentItems(
  context: RequestContext,
  q: string,
  limit: number,
): Promise<SearchItem[]> {
  const rows = await repo.agents.listAgents(
    context.db,
    accessFilter(context, 'agents.read'),
    undefined,
    { q, limit, enabled: true },
  );
  return rows.map((row) => ({
    kind: 'agent',
    id: row.id,
    title: row.name,
    subtitle: row.tags.length === 0 ? row.role : `${row.role} · ${row.tags.join(' / ')}`,
  }));
}

async function conversationItems(
  context: RequestContext,
  q: string,
  limit: number,
): Promise<SearchItem[]> {
  const { items } = await repo.chat.searchConversations(context.db, {
    q,
    limit,
    access: accessFilter(context, 'conversations.read'),
  });
  return items.map((row) => ({
    kind: 'conversation',
    id: row.id,
    title: row.title || '未命名会话',
    subtitle: row.agentName,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

async function knowledgeItems(
  context: RequestContext,
  q: string,
  limit: number,
): Promise<SearchItem[]> {
  const access = await resourceAccessFilter(context, 'knowledge.read', 'knowledge_base', 'read');
  const rows = await repo.search.searchKnowledgeBases(context.db, access, q, limit);
  return rows.map((row) => ({
    kind: 'knowledge',
    id: row.id,
    title: row.name,
    subtitle: row.description,
  }));
}

async function serverItems(
  context: RequestContext,
  q: string,
  limit: number,
): Promise<SearchItem[]> {
  const access = await resourceAccessFilter(context, 'servers.read', 'server', 'read');
  const rows = await repo.search.searchServers(context.db, access, q, limit);
  return rows.map((row) => ({
    kind: 'server',
    id: row.id,
    title: row.name,
    subtitle: row.description,
  }));
}

async function skillItems(
  context: RequestContext,
  q: string,
  limit: number,
): Promise<SearchItem[]> {
  const access = await resourceAccessFilter(context, 'skills.read', 'skill', 'read');
  const rows = await repo.search.searchSkills(context.db, access, q, limit);
  return rows.map((row) => ({
    kind: 'skill',
    id: row.id,
    title: row.name,
    subtitle: row.description,
  }));
}

async function pluginItems(
  context: RequestContext,
  q: string,
  limit: number,
): Promise<SearchItem[]> {
  const access = await resourceAccessFilter(context, 'plugins.read', 'plugin', 'read');
  const rows = await repo.search.searchPlugins(context.db, access, q, limit);
  return rows.map((row) => ({
    kind: 'plugin',
    id: row.id,
    title: row.name,
    subtitle: row.description,
  }));
}

export const searchRouter = os.router({
  search: os.search.handler(async ({ input, context }) => {
    context.responseHeaders.set('cache-control', 'no-store');
    const { q, limit } = input.query;
    const canReadConversations = hasGrant(context, 'conversations.read');
    const [agents, conversations, knowledge, servers, skills, plugins, outputs] = await Promise.all(
      [
        hasGrant(context, 'agents.read') ? agentItems(context, q, limit) : [],
        canReadConversations ? conversationItems(context, q, limit) : [],
        hasGrant(context, 'knowledge.read') ? knowledgeItems(context, q, limit) : [],
        hasGrant(context, 'servers.read') ? serverItems(context, q, limit) : [],
        hasGrant(context, 'skills.read') ? skillItems(context, q, limit) : [],
        hasGrant(context, 'plugins.read') ? pluginItems(context, q, limit) : [],
        canReadConversations
          ? collectPersonalOutputs(context, { q, limit }).then((result) =>
              result.items.map(
                (item): SearchItem => ({
                  kind: 'output',
                  id: `${item.conversationId}:${item.runId}:${item.path}`,
                  title: item.path.split('/').at(-1) ?? item.path,
                  subtitle: item.conversationTitle,
                  updatedAt: item.createdAt,
                  conversationId: item.conversationId,
                  agentId: item.agentId,
                  runId: item.runId,
                  path: item.path,
                }),
              ),
            )
          : [],
      ],
    );

    return {
      items: [
        ...agents,
        ...conversations,
        ...knowledge,
        ...servers,
        ...skills,
        ...plugins,
        ...outputs,
      ],
    };
  }),
});
