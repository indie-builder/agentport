import { fail } from '@agentport/core';
import type { Agent, ApiToolInput, ServerInput } from '@agentport/shared';
import { eq, inArray } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { newId } from '../id.js';
import {
  agentHookFiles,
  agentOutputStyles,
  agentRules,
  agentServers,
  agentSkills,
  agents,
  agentWorkflows,
  apiTools,
  servers,
  skillFiles,
  skills,
} from '../schema.js';
import { loadLiveDefinition } from './agent-definitions.js';
import {
  assertDefinitionResources,
  insertAgentVersion,
  recordPublishedVersion,
} from './agent-versions.js';
import { type AgentWrite, toAgent } from './agents.js';
import { isPgCode } from './pg-errors.js';

export interface ImportAgentServerEntry {
  input: ServerInput;
  tools: Array<ApiToolInput & { enabled: boolean }> | undefined;
  secretKeys: string[];
  knowledge: boolean;
  dataDomain: boolean;
}

export interface ImportAgentSkillEntry {
  slug: string;
  name: string;
  description: string;
  body: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  files: Array<{ path: string; content: string }>;
}

export interface ImportAgentRuleInput {
  slug: string;
  content: string;
  globs: string;
}

export interface ImportAgentStyleInput {
  slug: string;
  description: string;
  keepCodingInstructions: boolean;
  body: string;
  isSelected: boolean;
}

export interface ImportAgentWorkflowInput {
  slug: string;
  name: string;
  description: string;
  content: string;
}

export interface ImportAgentPackageInput {
  businessId: string;
  agent: {
    slug: string;
    values: Omit<AgentWrite, 'slug' | 'createdBy' | 'ownerBusinessId' | 'parentId'>;
    serverNames: string[];
    skillSlugs: string[];
  };
  servers: ImportAgentServerEntry[];
  skills: ImportAgentSkillEntry[];
  rules: ImportAgentRuleInput[];
  styles: ImportAgentStyleInput[];
  workflows: ImportAgentWorkflowInput[];
  hooks: {
    config: Record<string, unknown> | null;
    files: Array<{ path: string; content: string; executable: boolean }>;
  };
  children: Array<{
    slug: string;
    values: Omit<
      AgentWrite,
      'slug' | 'createdBy' | 'ownerBusinessId' | 'parentId' | 'runtimeEnvironmentId'
    >;
    serverNames: string[];
    skillSlugs: string[];
    rules: ImportAgentRuleInput[];
    outputStyles: ImportAgentStyleInput[];
  }>;
}

export interface ImportAgentPackageResult {
  agent: Agent;
  createdServers: string[];
  reusedServers: string[];
  createdSkills: string[];
  createdSubAgents: string[];
  warnings: string[];
}

function serverConfig(input: ServerInput): Record<string, unknown> {
  switch (input.kind) {
    case 'stdio':
      return { command: input.command, args: input.args };
    case 'http':
      return { url: input.url };
    case 'generated':
      return {
        baseUrl: input.baseUrl,
        mcpToken: crypto
          .getRandomValues(new Uint8Array(32))
          .toBase64({ alphabet: 'base64url', omitPadding: true }),
      };
  }
}

function nonSecretConfig(input: ServerInput): Record<string, unknown> {
  const { mcpToken: _mcpToken, ...config } = serverConfig(input);
  return config;
}

function configDiffers(input: ServerInput, existing: Record<string, unknown>): boolean {
  return Object.entries(nonSecretConfig(input)).some(
    ([key, value]) => JSON.stringify(existing[key]) !== JSON.stringify(value),
  );
}

function metadataKey(metadata: Record<string, unknown> | undefined): string {
  if (metadata === undefined || Object.keys(metadata).length === 0) return '';
  return JSON.stringify(metadata, (_key, value: unknown) =>
    value === null || typeof value !== 'object' || Array.isArray(value)
      ? value
      : Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}

async function uniqueSlug(tx: Transaction, base: string): Promise<string> {
  const taken = async (candidate: string): Promise<boolean> => {
    const rows = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.slug, candidate))
      .limit(1);
    return rows.length > 0;
  };
  if (!(await taken(base))) return base;
  const candidate = (n: number) => {
    const suffix = `-${n}`;
    return `${base.slice(0, Math.min(60, 64 - suffix.length))}${suffix}`;
  };
  let n = 2;
  while (await taken(candidate(n))) n += 1;
  return candidate(n);
}

async function insertAgentFiles(
  tx: Transaction,
  agentId: string,
  rules: ImportAgentRuleInput[],
  styles: ImportAgentStyleInput[],
  workflows: ImportAgentWorkflowInput[],
): Promise<void> {
  if (rules.length > 0) {
    await tx
      .insert(agentRules)
      .values(rules.map((rule) => ({ id: newId('rule'), agentId, ...rule })));
  }
  if (styles.length > 0) {
    await tx
      .insert(agentOutputStyles)
      .values(styles.map((style) => ({ id: newId('outputStyle'), agentId, ...style })));
  }
  if (workflows.length > 0) {
    await tx
      .insert(agentWorkflows)
      .values(workflows.map((workflow) => ({ id: newId('agentWorkflow'), agentId, ...workflow })));
  }
}

export async function importAgentPackage(
  db: Database,
  input: ImportAgentPackageInput,
  authorizeResource?: (resource: {
    kind: 'server' | 'skill';
    resourceId: string;
    ownerBusinessId: string | null;
  }) => Promise<void>,
): Promise<ImportAgentPackageResult> {
  const warnings: string[] = [];
  const created = await db
    .transaction(async (tx) => {
      const createdServers: string[] = [];
      const reusedServers: string[] = [];
      const createdSkills: string[] = [];
      const existingServers =
        input.servers.length === 0
          ? []
          : await tx
              .select()
              .from(servers)
              .where(
                inArray(
                  servers.name,
                  input.servers.map((entry) => entry.input.name),
                ),
              );
      const existingByName = new Map(existingServers.map((row) => [row.name, row]));
      const serverIdsByName = new Map(existingServers.map((row) => [row.name, row.id]));
      for (const {
        input: serverInput,
        tools,
        secretKeys,
        knowledge,
        dataDomain,
      } of input.servers) {
        const existing = existingByName.get(serverInput.name);
        if (existing !== undefined) {
          await authorizeResource?.({
            kind: 'server',
            resourceId: existing.id,
            ownerBusinessId: existing.ownerBusinessId,
          });
          if (existing.kind === 'knowledge' && serverInput.kind === 'http') {
            reusedServers.push(serverInput.name);
            warnings.push(
              `「${serverInput.name}」是知识库连接，已复用对应的知识库；凭据由运行时注入，不需要重新填写`,
            );
            continue;
          }
          if (existing.kind === 'data_domain' && serverInput.kind === 'http') {
            reusedServers.push(serverInput.name);
            warnings.push(
              `「${serverInput.name}」是数据域连接，已复用对应的数据域；凭据由运行时注入，不需要重新填写`,
            );
            continue;
          }
          if (existing.kind !== serverInput.kind) {
            fail(
              'INVALID_INPUT',
              `已存在同名 Server「${serverInput.name}」，但类型不同（${existing.kind} / ${serverInput.kind}），无法复用；请先在包内改名`,
            );
          }
          reusedServers.push(serverInput.name);
          if (configDiffers(serverInput, existing.config)) {
            warnings.push(
              `已存在同名 Server「${serverInput.name}」，其配置与导入包不同，已保留原配置`,
            );
          }
          if (tools !== undefined && tools.length > 0) {
            warnings.push(
              `已存在同名 Server「${serverInput.name}」，其 ${tools.length} 个工具保留原配置，未按导入包覆盖`,
            );
          }
          continue;
        }
        const [row] = await tx
          .insert(servers)
          .values({
            id: newId('server'),
            name: serverInput.name,
            kind: serverInput.kind,
            description: serverInput.description,
            config: serverConfig(serverInput),
            secretsEncrypted: null,
            ownerBusinessId: input.businessId,
          })
          .returning();
        if (!row) throw new Error('server insert returned no row');
        if (secretKeys.length > 0) {
          warnings.push(
            knowledge
              ? `「${serverInput.name}」是知识库连接：请在本实例的专家配置里绑定对应知识库，导出的地址与凭据不会生效`
              : dataDomain
                ? `「${serverInput.name}」是数据域连接：请在本实例的专家配置里绑定对应数据域，导出的地址与凭据不会生效`
                : `「${serverInput.name}」的密钥需要重新填写：${secretKeys.join(', ')}`,
          );
        }
        serverIdsByName.set(row.name, row.id);
        createdServers.push(row.name);
        if (tools && tools.length > 0) {
          await tx
            .insert(apiTools)
            .values(tools.map((tool) => ({ id: newId('tool'), serverId: row.id, ...tool })));
        }
      }
      const existingSkills =
        input.skills.length === 0
          ? []
          : await tx
              .select()
              .from(skills)
              .where(
                inArray(
                  skills.slug,
                  input.skills.map((skill) => skill.slug),
                ),
              );
      const existingSkillBySlug = new Map(existingSkills.map((row) => [row.slug, row]));
      const skillIdsBySlug = new Map(existingSkills.map((row) => [row.slug, row.id]));
      const existingFiles =
        existingSkills.length === 0
          ? []
          : await tx
              .select()
              .from(skillFiles)
              .where(
                inArray(
                  skillFiles.skillId,
                  existingSkills.map((skill) => skill.id),
                ),
              );
      const existingFilesBySkillId = new Map<string, typeof existingFiles>();
      for (const file of existingFiles) {
        const files = existingFilesBySkillId.get(file.skillId) ?? [];
        files.push(file);
        existingFilesBySkillId.set(file.skillId, files);
      }
      for (const skillInput of input.skills) {
        const existing = existingSkillBySlug.get(skillInput.slug);
        if (existing) {
          await authorizeResource?.({
            kind: 'skill',
            resourceId: existing.id,
            ownerBusinessId: existing.ownerBusinessId,
          });
          if (
            existing.name !== skillInput.name ||
            existing.description !== skillInput.description ||
            existing.body !== skillInput.body
          ) {
            warnings.push(`已存在同名技能「${skillInput.slug}」，其内容与导入包不同，已保留原配置`);
          }
          if (
            (existing.license ?? null) !== (skillInput.license ?? null) ||
            (existing.compatibility ?? null) !== (skillInput.compatibility ?? null) ||
            metadataKey(existing.metadata) !== metadataKey(skillInput.metadata)
          ) {
            warnings.push(
              `已存在同名技能「${skillInput.slug}」，其来源信息与导入包不同，已保留原配置`,
            );
          }
          const files = existingFilesBySkillId.get(existing.id) ?? [];
          const contents = new Map(files.map((file) => [file.path, file.content]));
          if (
            files.length !== skillInput.files.length ||
            skillInput.files.some((file) => contents.get(file.path) !== file.content)
          ) {
            warnings.push(
              `已存在同名技能「${skillInput.slug}」，其资源文件与导入包不同，已保留原文件`,
            );
          }
          continue;
        }
        const { files, ...skillValues } = skillInput;
        const [row] = await tx
          .insert(skills)
          .values({ id: newId('skill'), ...skillValues, ownerBusinessId: input.businessId })
          .returning();
        if (!row) throw new Error('skill insert returned no row');
        if (files.length > 0) {
          await tx
            .insert(skillFiles)
            .values(files.map((file) => ({ id: newId('skillFile'), skillId: row.id, ...file })));
        }
        skillIdsBySlug.set(row.slug, row.id);
        createdSkills.push(row.slug);
      }
      const slug = await uniqueSlug(tx, input.agent.slug);
      if (slug !== input.agent.slug) {
        warnings.push(`slug "${input.agent.slug}" 已存在，导入为 "${slug}"`);
      }
      const resolve = (names: string[], ids: Map<string, string>): string[] =>
        names.map((name) => ids.get(name)).filter((id): id is string => id !== undefined);
      const serverIds = resolve(input.agent.serverNames, serverIdsByName);
      const skillIds = resolve(input.agent.skillSlugs, skillIdsBySlug);
      const [row] = await tx
        .insert(agents)
        .values({
          id: newId('agent'),
          slug,
          createdBy: input.businessId,
          ownerBusinessId: input.businessId,
          ...input.agent.values,
          hooksEnabled: false,
          hooksConfig: input.hooks.config,
        })
        .returning();
      if (!row) throw new Error('agent insert returned no row');
      if (serverIds.length > 0) {
        await tx
          .insert(agentServers)
          .values(serverIds.map((serverId) => ({ agentId: row.id, serverId })));
      }
      if (skillIds.length > 0) {
        await tx
          .insert(agentSkills)
          .values(skillIds.map((skillId) => ({ agentId: row.id, skillId })));
      }
      await insertAgentFiles(tx, row.id, input.rules, input.styles, input.workflows);
      if (input.hooks.files.length > 0) {
        await tx.insert(agentHookFiles).values(
          input.hooks.files.map((file) => ({
            id: newId('agentHookFile'),
            agentId: row.id,
            ...file,
          })),
        );
      }
      const createdSubAgents: string[] = [];
      const childIds: string[] = [];
      for (const child of input.children) {
        const childSlug = await uniqueSlug(tx, child.slug);
        if (childSlug !== child.slug) {
          warnings.push(`子智能体 slug "${child.slug}" 已存在，导入为 "${childSlug}"`);
        }
        const childServerIds = resolve(child.serverNames, serverIdsByName);
        const childSkillIds = resolve(child.skillSlugs, skillIdsBySlug);
        const [childRow] = await tx
          .insert(agents)
          .values({
            id: newId('agent'),
            slug: childSlug,
            parentId: row.id,
            createdBy: input.businessId,
            ownerBusinessId: input.businessId,
            ...child.values,
          })
          .returning();
        if (!childRow) throw new Error('sub-agent insert returned no row');
        if (childServerIds.length > 0) {
          await tx
            .insert(agentServers)
            .values(childServerIds.map((serverId) => ({ agentId: childRow.id, serverId })));
        }
        if (childSkillIds.length > 0) {
          await tx
            .insert(agentSkills)
            .values(childSkillIds.map((skillId) => ({ agentId: childRow.id, skillId })));
        }
        await insertAgentFiles(tx, childRow.id, child.rules, child.outputStyles, []);
        childIds.push(childRow.id);
        createdSubAgents.push(childRow.slug);
      }
      let rootRow = row;
      for (const id of [...childIds, row.id]) {
        const definition = await loadLiveDefinition(tx, id);
        if (!definition) throw new Error('imported agent disappeared before versioning');
        if (id === row.id) await assertDefinitionResources(tx, definition);
        const version = await insertAgentVersion(tx, id, definition.agent, definition);
        const published = await recordPublishedVersion(tx, id, version);
        if (id === row.id && published) rootRow = published;
      }
      return {
        agent: toAgent(rootRow, serverIds, skillIds, childIds),
        createdServers,
        reusedServers,
        createdSkills,
        createdSubAgents,
      };
    })
    .catch((err: unknown): never => {
      if (isPgCode(err, '23505')) {
        fail('CONFLICT', '导入期间同名 Server、技能或智能体被其他请求占用，请重试');
      }
      throw err;
    });
  return { ...created, warnings };
}
