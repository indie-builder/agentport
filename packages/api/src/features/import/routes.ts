import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  fail,
  type ParsedArchive,
  parseWorkspaceArchive,
  unsupportedAllowedTool,
} from '@agentport/core';
import type { Database } from '@agentport/db';
import {
  agentOutputStyles,
  agentRules,
  agentServers,
  agentSkills,
  agents,
  apiTools,
  newId,
  repo,
  servers,
  skillFiles,
  skills,
} from '@agentport/db';
import * as agentRepo from '@agentport/db/repo/agents.js';
import type { AgentInput, ServerInput } from '@agentport/shared';
import {
  AGENT_PACKAGE_MAX_BYTES,
  agentInputSchema,
  apiToolInputSchema,
  outputStyleInputSchema,
  ruleInputSchema,
  serverInputSchema,
  skillFileInputSchema,
  skillInputSchema,
  slugSchema,
} from '@agentport/shared';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { isPgCode } from '../../plugins/errors.js';
import { type TypedApp, typed } from '../../types.js';
import { allowedToolsSchema } from '../agents/validation.js';
import { assertSafeUrl } from '../servers/ssrf.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const importedToolSchema = apiToolInputSchema.extend({
  enabled: z.boolean().default(true),
});

const importedServerSchema = z
  .object({
    name: slugSchema,
    kind: z.enum(['stdio', 'http', 'generated']),
    description: z.string().max(500).default(''),
    config: z.record(z.string(), z.unknown()).default({}),
    secretKeys: z.array(z.string()).default([]),
    /** 旧导出没有这个字段；只有 generated server 能带工具。 */
    tools: z.array(importedToolSchema).max(2000).optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.tools === undefined) return;
    if (entry.kind !== 'generated' && entry.tools.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['tools'],
        message: `「${entry.name}」不是 generated server，不能携带工具`,
      });
    }
    const seen = new Set<string>();
    entry.tools.forEach((tool, index) => {
      if (seen.has(tool.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tools', index, 'name'],
          message: `「${entry.name}」的工具名称「${tool.name}」重复`,
        });
      }
      seen.add(tool.name);
    });
  });

type ImportedServer = z.infer<typeof importedServerSchema>;

const importedRulesSchema = z
  .array(ruleInputSchema.extend({ content: z.string().default(''), globs: z.string().default('') }))
  .max(50);
const importedStylesSchema = z
  .array(
    outputStyleInputSchema.extend({
      description: z.string().default(''),
      body: z.string().default(''),
      isSelected: z.boolean(),
    }),
  )
  .max(20);
const importedFilesSchema = z
  .array(
    skillFileInputSchema.extend({
      path: skillFileInputSchema.shape.path.refine(
        (path) =>
          !path.includes('\\') &&
          path
            .split('/')
            .every((segment) => segment !== '' && segment !== '.' && segment !== '..') &&
          path.toLowerCase().split('/')[0] !== 'skill.md',
        '资源文件路径不能含空段、.、..、反斜杠，且不能占用 SKILL.md（不区分大小写）',
      ),
      content: z.string().default(''),
    }),
  )
  .max(50);
const importedSkillSchema = skillInputSchema.extend({ body: z.string().default('') });
const importedChildSchema = agentInputSchema
  .omit({ serverIds: true, skillIds: true, subAgentIds: true })
  .extend({
    allowedTools: allowedToolsSchema.default([]),
    permissionMode: z.enum(['dontAsk', 'plan', 'default', 'acceptEdits']).default('dontAsk'),
    serverNames: z.array(slugSchema).default([]),
    skillSlugs: z.array(slugSchema).default([]),
  });
const commonBody = {
  agent: agentInputSchema.extend({
    allowedTools: allowedToolsSchema.default([]),
    permissionMode: z.enum(['dontAsk', 'plan', 'default', 'acceptEdits']).default('dontAsk'),
    /** 缺省时沿用旧导出语义：绑定文件里的全部资源。 */
    serverNames: z.array(slugSchema).optional(),
    skillSlugs: z.array(slugSchema).optional(),
  }),
  servers: z.array(importedServerSchema).max(100).default([]),
};

const importBodySchema = z
  .discriminatedUnion('format', [
    z.object({
      ...commonBody,
      format: z.literal('agentport/agent@1'),
      rules: importedRulesSchema.default([]),
      outputStyles: importedStylesSchema.default([]),
      skills: z
        .array(importedSkillSchema.extend({ files: importedFilesSchema.default([]) }))
        .max(100)
        .default([]),
      subAgents: z
        .array(
          importedChildSchema
            .extend({
              rules: importedRulesSchema.default([]),
              outputStyles: importedStylesSchema.default([]),
            })
            .strict(),
        )
        .max(20)
        .default([]),
    }),
    z.object({
      ...commonBody,
      format: z.literal('agentport/agent@2'),
      rules: importedRulesSchema,
      outputStyles: importedStylesSchema,
      skills: z
        .array(importedSkillSchema.extend({ files: importedFilesSchema }))
        .max(100)
        .default([]),
      subAgents: z
        .array(
          importedChildSchema
            .extend({
              rules: importedRulesSchema,
              outputStyles: importedStylesSchema,
            })
            .strict(),
        )
        .max(20)
        .default([]),
    }),
  ])
  .superRefine((body, ctx) => {
    const checkFiles = (
      owner: {
        rules: z.infer<typeof importedRulesSchema>;
        outputStyles: z.infer<typeof importedStylesSchema>;
      },
      path: Array<string | number>,
    ) => {
      for (const field of ['rules', 'outputStyles'] as const) {
        const slugs = new Set<string>();
        owner[field].forEach((entry, index) => {
          if (slugs.has(entry.slug))
            ctx.addIssue({
              code: 'custom',
              path: [...path, field, index, 'slug'],
              message: `「${entry.slug}」重复；每个智能体的 ${field} slug 必须唯一`,
            });
          slugs.add(entry.slug);
        });
      }
      if (owner.outputStyles.filter((style) => style.isSelected).length > 1) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'outputStyles'],
          message: '最多只能选中一个输出风格，请将其余 isSelected 设为 false',
        });
      }
    };
    checkFiles(body, []);
    body.subAgents.forEach((child, index) => {
      checkFiles(child, ['subAgents', index]);
    });
    body.skills.forEach((skill, index) => {
      const paths = new Set<string>();
      skill.files.forEach((file, fileIndex) => {
        const foldedPath = file.path.toLowerCase();
        const conflict = [...paths].find(
          (path) => foldedPath.startsWith(`${path}/`) || path.startsWith(`${foldedPath}/`),
        );
        if (paths.has(foldedPath) || conflict)
          ctx.addIssue({
            code: 'custom',
            path: ['skills', index, 'files', fileIndex, 'path'],
            message: conflict
              ? `资源路径「${file.path}」与「${conflict}」存在文件/目录冲突`
              : `资源路径「${file.path}」重复`,
          });
        paths.add(foldedPath);
      });
    });
    // 同名条目无法无损合并，静默取最后一条会悄悄丢配置。
    const seenServers = new Set<string>();
    body.servers.forEach((entry, index) => {
      if (seenServers.has(entry.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['servers', index, 'name'],
          message: `导入文件里 Server 名称「${entry.name}」重复`,
        });
      }
      seenServers.add(entry.name);
    });
    const seenSkills = new Set<string>();
    body.skills.forEach((entry, index) => {
      if (seenSkills.has(entry.slug)) {
        ctx.addIssue({
          code: 'custom',
          path: ['skills', index, 'slug'],
          message: `导入文件里技能 slug「${entry.slug}」重复`,
        });
      }
      seenSkills.add(entry.slug);
    });

    // 引用只能指向文件里的顶层资源：按名字挂到目标库的任意已有资源不可控。
    const checkRefs = (
      refs: { serverNames?: string[] | undefined; skillSlugs?: string[] | undefined },
      path: Array<string | number>,
    ) => {
      for (const field of ['serverNames', 'skillSlugs'] as const) {
        const values = refs[field] ?? [];
        const known = field === 'serverNames' ? seenServers : seenSkills;
        const seen = new Set<string>();
        values.forEach((value, index) => {
          if (seen.has(value)) {
            ctx.addIssue({
              code: 'custom',
              path: [...path, field, index],
              message: `「${value}」被重复引用`,
            });
          }
          seen.add(value);
          if (!known.has(value)) {
            ctx.addIssue({
              code: 'custom',
              path: [...path, field, index],
              message: `引用的「${value}」不在导入文件的 ${field === 'serverNames' ? 'servers' : 'skills'} 中`,
            });
          }
        });
      }
    };
    checkRefs(body.agent, ['agent']);

    const seenChildren = new Set([body.agent.slug]);
    body.subAgents.forEach((entry, index) => {
      if (seenChildren.has(entry.slug)) {
        ctx.addIssue({
          code: 'custom',
          path: ['subAgents', index, 'slug'],
          message: `子智能体 slug「${entry.slug}」与同级或其他子智能体重复`,
        });
      }
      seenChildren.add(entry.slug);
      checkRefs(entry, ['subAgents', index]);
    });
  });

/** 字段体积超限用 413，与整个包的 bodyLimit 保持一致。 */
function checkSize(value: string, max: number, path: string): void {
  if (value.length > max) {
    fail('PAYLOAD_TOO_LARGE', `${path} 超过 ${max} 字符，请精简后重试`, { path });
  }
}

type AgentFiles = Pick<z.infer<typeof importBodySchema>, 'rules' | 'outputStyles'>;

function checkAgentFileSizes(input: AgentFiles, path: string): void {
  input.rules.forEach((rule, index) => {
    checkSize(rule.content, 100_000, `${path}/rules/${index}/content`);
    checkSize(rule.globs, 1000, `${path}/rules/${index}/globs`);
  });
  input.outputStyles.forEach((style, index) => {
    checkSize(style.body, 50_000, `${path}/outputStyles/${index}/body`);
    checkSize(style.description, 500, `${path}/outputStyles/${index}/description`);
  });
}

async function insertAgentFiles(tx: Tx, agentId: string, input: AgentFiles): Promise<void> {
  if (input.rules.length > 0) {
    await tx.insert(agentRules).values(
      input.rules.map((rule) => ({
        id: newId('rule'),
        agentId,
        ...rule,
      })),
    );
  }
  if (input.outputStyles.length > 0) {
    await tx.insert(agentOutputStyles).values(
      input.outputStyles.map((style) => ({
        id: newId('outputStyle'),
        agentId,
        ...style,
      })),
    );
  }
}

/** 密钥不入库；generated server 需要一个本机可用的新令牌。 */
function toServerConfig(input: ServerInput): Record<string, unknown> {
  switch (input.kind) {
    case 'stdio':
      return { command: input.command, args: input.args };
    case 'http':
      return { url: input.url };
    case 'generated':
      return { baseUrl: input.baseUrl, mcpToken: randomBytes(32).toString('base64url') };
  }
}

/** 路由只关心这些字段；server/skill/sub-agent 引用由绑定关系单独写入。 */
type AgentFields = Omit<AgentInput, 'serverIds' | 'skillIds' | 'subAgentIds'>;

function toAgentValues(input: AgentFields) {
  return {
    name: input.name,
    role: input.role,
    description: input.description,
    model: input.model,
    systemPromptMd: input.systemPrompt,
    allowedTools: input.allowedTools,
    disallowedTools: input.disallowedTools,
    permissionMode: input.permissionMode,
    effort: input.effort ?? null,
    maxThinkingTokens: input.maxThinkingTokens ?? null,
    enabled: input.enabled,
    maxTurns: input.maxTurns,
    maxBudgetUsd: String(input.maxBudgetUsd),
    timeoutMs: input.timeoutMs,
  };
}

/** generated 的 mcpToken 每次调用都会重新生成，不属于可比较的配置。 */
function nonSecretConfig(input: ServerInput): Record<string, unknown> {
  const { mcpToken: _mcpToken, ...config } = toServerConfig(input);
  return config;
}

function configDiffers(input: ServerInput, existing: Record<string, unknown>): boolean {
  return Object.entries(nonSecretConfig(input)).some(
    ([key, value]) => JSON.stringify(existing[key]) !== JSON.stringify(value),
  );
}

async function uniqueSlug(tx: Tx, base: string): Promise<string> {
  const taken = async (candidate: string): Promise<boolean> => {
    const rows = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.slug, candidate))
      .limit(1);
    return rows.length > 0;
  };
  if (!(await taken(base))) return base;
  const prefix = base.slice(0, 60);
  let n = 2;
  while (await taken(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

/**
 * 导出里的 config 就是 serverInputSchema 去掉密钥后的字段；不一致即视为非法导出。
 * config 是 JSON Schema，无法在 zod 顶层表达，所以在 handler 入口这一行校验一次。
 */
function toServerInput(entry: ImportedServer): ServerInput {
  const parsed = serverInputSchema.safeParse({
    ...entry.config,
    name: entry.name,
    kind: entry.kind,
    description: entry.description,
  });
  if (!parsed.success) fail('INVALID_INPUT', `「${entry.name}」的 Server 配置不完整，无法导入`);
  return parsed.data;
}

type ImportBody = z.infer<typeof importBodySchema>;

const archiveBodySchema = z.object({
  filename: z.string().min(1).max(200),
  dataBase64: z.string().min(1).max(1_500_000),
});

/** 平台导入只接受这几种权限模式；归档里的 auto 会削弱平台约束。 */
const IMPORT_PERMISSION_MODES = new Set(['dontAsk', 'plan', 'default', 'acceptEdits']);

function stringRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 文件名只用于推导新 slug；路径部分一律丢弃，避免借文件名影响落盘位置。 */
function slugFromFilename(filename: string): string {
  const base = filename.replace(/^.*[\\/]/, '');
  if (!base.toLowerCase().endsWith('.zip')) {
    fail('INVALID_INPUT', '归档文件名必须以 .zip 结尾', { path: '/filename' });
  }
  return base
    .slice(0, -4)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** base64 标准编码；非规范输入（空白、URL-safe、多余填充）一律拒绝，不做宽容解码。 */
function decodeArchiveBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    fail('INVALID_INPUT', 'dataBase64 不是合法的 base64 编码', { path: '/dataBase64' });
  }
  const data = Buffer.from(value, 'base64');
  if (data.toString('base64') !== value) {
    fail('INVALID_INPUT', 'dataBase64 不是合法的 base64 编码', { path: '/dataBase64' });
  }
  return new Uint8Array(data);
}

/** `.mcp.json` 只有 command 与 url 两种形态；generated 导出后就是 http，无法还原。 */
function archiveServers(parsed: ParsedArchive) {
  return Object.entries(parsed.mcp).map(([name, raw]) => {
    const entry = stringRecord(raw);
    if (typeof entry.command === 'string') {
      return {
        name,
        kind: 'stdio' as const,
        config: {
          command: entry.command,
          args: Array.isArray(entry.args)
            ? entry.args.filter((arg): arg is string => typeof arg === 'string')
            : [],
        },
        // 值与加密凭据都不属于可移植内容，只把键名带出去提示重新填写。
        secretKeys: Object.keys(stringRecord(entry.env)).sort(),
      };
    }
    if (typeof entry.url === 'string') {
      return {
        name,
        kind: 'http' as const,
        config: { url: entry.url },
        secretKeys: Object.keys(stringRecord(entry.headers)).sort(),
      };
    }
    return fail('INVALID_INPUT', `.mcp.json 的 Server「${name}」缺少 command 或 url`, {
      path: `/mcp/${name}`,
    });
  });
}

/** 平台工具名：MCP 名（可带 * 通配）或裸工具名；带 (specifier) 的权限规则无法映射。 */
const TOOL_NAME = /^(?:mcp__[A-Za-z0-9_-]+(?:__[A-Za-z0-9_*-]+)?|[A-Za-z][A-Za-z0-9_]*)$/;

/** 官方 settings.effortLevel 只持久化这四档；max 仅限会话内，不写文件。 */
const SETTINGS_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh']);

function mappedToolRules(value: unknown, field: string, warnings: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((rule) => typeof rule === 'string')) {
    warnings.push(`settings.permissions.${field} 不是字符串列表，已忽略`);
    return [];
  }
  const kept: string[] = [];
  for (const rule of value) {
    if (!TOOL_NAME.test(rule)) {
      warnings.push(
        `settings.permissions.${field} 中的「${rule}」不是平台工具名（含 specifier 的规则无法映射），已忽略`,
      );
      continue;
    }
    if (field === 'allow' && unsupportedAllowedTool([rule]) !== undefined) {
      warnings.push(`settings.permissions.allow 中的「${rule}」被运行时固定禁用，已忽略`);
      continue;
    }
    kept.push(rule);
  }
  return kept;
}

function settingsAgentDefaults(settings: Record<string, unknown>, warnings: string[]) {
  const model = typeof settings.model === 'string' ? settings.model.trim() : '';
  const permissions = stringRecord(settings.permissions);
  const mode = permissions.defaultMode;
  const effort = settings.effortLevel;
  if (effort !== undefined && !(typeof effort === 'string' && SETTINGS_EFFORT_LEVELS.has(effort))) {
    warnings.push(`settings.effortLevel「${String(effort)}」不是官方持久化支持的推理强度，已忽略`);
  }
  const allowedTools = mappedToolRules(permissions.allow, 'allow', warnings);
  if (allowedTools.length > 0) {
    // 官方 allow 是自动批准规则；平台只把它当工具启用白名单，语义不等价，必须提示。
    warnings.push(
      'settings.permissions.allow 在官方语义中是「自动批准」，平台按「工具启用白名单」解释；如需自动批准请在平台权限设置中配置',
    );
  }
  const disallowedTools = mappedToolRules(permissions.deny, 'deny', warnings);
  return {
    ...(model !== '' && model !== 'inherit' ? { model } : {}),
    ...(typeof mode === 'string' && IMPORT_PERMISSION_MODES.has(mode)
      ? { permissionMode: mode }
      : {}),
    ...(typeof effort === 'string' && SETTINGS_EFFORT_LEVELS.has(effort) ? { effort } : {}),
    ...(allowedTools.length > 0 ? { allowedTools } : {}),
    ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
  };
}

/** 归档 → 现有 @2 导入事务的输入；写入仍只走 registerImportRoutes 里那一条事务。 */
function archiveImportBody(
  parsed: ParsedArchive,
  slug: string,
): { body: ImportBody; warnings: string[] } {
  const warnings: string[] = [];
  const servers = archiveServers(parsed);
  const knownSkills = new Set(parsed.skills.map((skill) => skill.slug));
  // 归档只按目录携带技能，不记录绑定归属；根级保留全部可映射技能，父子共享时不扣除。
  const childSkills = new Set(parsed.subAgents.flatMap((child) => child.skills));
  const skillSlugs = [...knownSkills];
  for (const slug of childSkills) {
    if (knownSkills.has(slug)) {
      warnings.push(`归档不记录技能挂载归属，技能「${slug}」已同时绑定到根智能体与子智能体`);
    }
  }
  // 官方文件没有这三项的归宿，不塞私有字段；用平台默认值并让用户知道。
  warnings.push(
    '归档不携带根智能体的 maxTurns / maxBudgetUsd / timeoutMs，导入后使用默认值（20 轮 / $2 / 600 秒）',
  );
  if (parsed.subAgents.length > 0) {
    warnings.push('归档不携带子智能体的启停状态，导入后全部启用');
    warnings.push('归档不携带子智能体的 maxBudgetUsd / timeoutMs，导入后使用默认值（$2 / 600 秒）');
  }

  const candidate = {
    format: 'agentport/agent@2' as const,
    agent: {
      slug,
      name: parsed.agent.name,
      systemPrompt: parsed.agent.systemPrompt,
      role: '通用助手',
      // 归档把根级 model/permissionMode/tools/effort 写在 settings.json；缺省时用平台默认。
      ...settingsAgentDefaults(parsed.settings, warnings),
      serverNames: servers.map((server) => server.name),
      skillSlugs,
    },
    servers,
    rules: parsed.rules,
    outputStyles: parsed.outputStyles,
    skills: parsed.skills,
    subAgents: parsed.subAgents.map((child) => {
      const supported = IMPORT_PERMISSION_MODES.has(child.permissionMode);
      if (!supported) {
        warnings.push(
          `子智能体「${child.slug}」的权限模式「${child.permissionMode}」不受平台支持，已改为 dontAsk`,
        );
      }
      const childSkillSlugs = child.skills.filter((skill) => {
        if (knownSkills.has(skill)) return true;
        warnings.push(`子智能体「${child.slug}」引用的技能「${skill}」不在归档中，已忽略`);
        return false;
      });
      return {
        slug: child.slug,
        name: child.name,
        description: child.description,
        model: child.model,
        systemPrompt: child.systemPrompt,
        role: '通用助手',
        permissionMode: supported ? child.permissionMode : 'dontAsk',
        maxTurns: child.maxTurns,
        ...(child.effort === undefined ? {} : { effort: child.effort }),
        allowedTools: child.allowedTools,
        disallowedTools: child.disallowedTools,
        // 子定义文件不携带平台资源绑定；根级 .mcp.json 只对应根绑定。
        serverNames: [],
        skillSlugs: childSkillSlugs,
        rules: [],
        outputStyles: [],
      };
    }),
  };

  try {
    return { body: importBodySchema.parse(candidate), warnings };
  } catch (error) {
    if (error instanceof z.ZodError) {
      fail(
        'INVALID_INPUT',
        `归档内容无法映射为智能体定义：${error.issues[0]?.message ?? '字段不合法'}`,
      );
    }
    throw error;
  }
}

/** 导入事务的唯一入口：JSON 专家包与 zip 归档都走这里。 */
async function runImport(app: TypedApp, body: ImportBody, request: FastifyRequest) {
  const { agent: input, servers: entries, skills: skillInputs, subAgents } = body;
  checkAgentFileSizes(body, '');
  subAgents.forEach((child, index) => {
    checkAgentFileSizes(child, `/subAgents/${index}`);
  });
  skillInputs.forEach((skill, index) => {
    checkSize(skill.body, 200_000, `/skills/${index}/body`);
    skill.files.forEach((file, fileIndex) => {
      checkSize(file.content, 200_000, `/skills/${index}/files/${fileIndex}/content`);
    });
  });
  const serverEntries = entries.map((entry) => ({
    input: toServerInput(entry),
    tools: entry.tools,
    secretKeys: entry.secretKeys,
  }));

  // 导入文件同样不可信：http/generated 的地址与手动创建走同一个 SSRF 校验。
  for (const { input: serverInput } of serverEntries) {
    if (serverInput.kind === 'http') {
      await assertSafeUrl(serverInput.url, app.config.NODE_ENV);
    } else if (serverInput.kind === 'generated') {
      await assertSafeUrl(serverInput.baseUrl, app.config.NODE_ENV);
    }
  }
  const warnings: string[] = [];
  // 源实例的子智能体 ID 在目标库里没有意义；不绑定，但要让用户知道。
  // 新格式带 subAgents 时由文件内容重建关系，旧的 ID 不再是有效输入。
  if (input.subAgentIds.length > 0 && subAgents.length === 0) {
    warnings.push(`导入文件中的 ${input.subAgentIds.length} 个子智能体未绑定，需手动重新选择`);
  }

  const result = await app.db
    .transaction(async (tx) => {
      const createdServers: string[] = [];
      const reusedServers: string[] = [];
      const createdSkills: string[] = [];

      const existingServers =
        serverEntries.length === 0
          ? []
          : await tx
              .select()
              .from(servers)
              .where(
                inArray(
                  servers.name,
                  serverEntries.map((s) => s.input.name),
                ),
              );
      const existingByName = new Map(existingServers.map((row) => [row.name, row]));
      const serverIdsByName = new Map(existingServers.map((row) => [row.name, row.id]));
      for (const { input: serverInput, tools, secretKeys } of serverEntries) {
        const existing = existingByName.get(serverInput.name);
        if (existing !== undefined) {
          // 同名不同 kind 的配置结构不同，复用会得到行为不符的 server。
          if (existing.kind !== serverInput.kind) {
            fail(
              'INVALID_INPUT',
              `已存在同名 Server「${serverInput.name}」，但类型不同（${existing.kind} / ${serverInput.kind}），无法复用；请先在导入文件中改名`,
            );
          }
          reusedServers.push(serverInput.name);
          // 复用不改写已有配置，只提示差异，由用户决定是否手动同步。
          if (configDiffers(serverInput, existing.config)) {
            warnings.push(
              `已存在同名 Server「${serverInput.name}」，其配置与导入文件不同，已保留原配置`,
            );
          }
          // 复用不合并工具，必须让用户知道文件里的工具没有被导入。
          if (tools !== undefined && tools.length > 0) {
            warnings.push(
              `已存在同名 Server「${serverInput.name}」，其 ${tools.length} 个工具保留原配置，未按导入文件覆盖`,
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
            config: toServerConfig(serverInput),
            secretsEncrypted: null,
          })
          .returning();
        if (!row) throw new Error('server insert returned no row');
        // 只有新建的 server 需要填密钥；已存在的不重复提示。
        if (secretKeys.length > 0) {
          warnings.push(`「${serverInput.name}」的密钥需要重新填写：${secretKeys.join(', ')}`);
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
        skillInputs.length === 0
          ? []
          : await tx
              .select()
              .from(skills)
              .where(
                inArray(
                  skills.slug,
                  skillInputs.map((s) => s.slug),
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
      let createdFileCount = 0;
      for (const skillInput of skillInputs) {
        const existing = existingSkillBySlug.get(skillInput.slug);
        if (existing) {
          // license/compatibility 在库里是 '' 表示未设置；metadata 的 jsonb 键序不稳定，按值比较。
          if (
            existing.name !== skillInput.name ||
            existing.description !== skillInput.description ||
            existing.body !== skillInput.body ||
            (existing.license ?? '') !== (skillInput.license ?? '') ||
            (existing.compatibility ?? '') !== (skillInput.compatibility ?? '') ||
            !isDeepStrictEqual(existing.metadata, skillInput.metadata ?? {})
          ) {
            warnings.push(
              `已存在同名技能「${skillInput.slug}」，其内容与导入文件不同，已保留原配置`,
            );
          }
          const files = existingFiles.filter((file) => file.skillId === existing.id);
          const contents = new Map(files.map((file) => [file.path, file.content]));
          if (
            files.length !== skillInput.files.length ||
            skillInput.files.some((file) => contents.get(file.path) !== file.content)
          ) {
            warnings.push(
              `已存在同名技能「${skillInput.slug}」，其资源文件与导入文件不同，已保留原文件`,
            );
          }
          continue;
        }
        const { files, ...skillValues } = skillInput;
        const [row] = await tx
          .insert(skills)
          .values({ id: newId('skill'), ...skillValues })
          .returning();
        if (!row) throw new Error('skill insert returned no row');
        if (files.length > 0) {
          await tx.insert(skillFiles).values(
            files.map((file) => ({
              id: newId('skillFile'),
              skillId: row.id,
              ...file,
            })),
          );
          createdFileCount += files.length;
        }
        skillIdsBySlug.set(row.slug, row.id);
        createdSkills.push(row.slug);
      }

      const slug = await uniqueSlug(tx, input.slug);
      if (slug !== input.slug) {
        warnings.push(`slug "${input.slug}" 已存在，导入为 "${slug}"`);
      }
      /** 旧导出没有 serverNames/skillSlugs：沿用「绑定文件里的全部资源」语义。 */
      const resolve = (
        names: string[] | undefined,
        all: string[],
        ids: Map<string, string>,
      ): string[] =>
        (names ?? all).map((name) => ids.get(name)).filter((id): id is string => id !== undefined);

      const serverIds = resolve(
        input.serverNames,
        serverEntries.map((s) => s.input.name),
        serverIdsByName,
      );
      const skillIds = resolve(
        input.skillSlugs,
        skillInputs.map((s) => s.slug),
        skillIdsBySlug,
      );

      const [row] = await tx
        .insert(agents)
        .values({ id: newId('agent'), slug, ...toAgentValues(input) })
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

      await insertAgentFiles(tx, row.id, body);
      const createdSubAgents: string[] = [];
      const childIds: string[] = [];
      const childSnapshots: ReturnType<typeof agentRepo.toAgent>[] = [];
      for (const childInput of subAgents) {
        // 子智能体始终是新建行：同名已有 agent（可能已属于别的父级）一律加后缀，不复用。
        const childSlug = await uniqueSlug(tx, childInput.slug);
        if (childSlug !== childInput.slug) {
          warnings.push(`子智能体 slug "${childInput.slug}" 已存在，导入为 "${childSlug}"`);
        }
        const childServerIds = resolve(
          childInput.serverNames,
          serverEntries.map((s) => s.input.name),
          serverIdsByName,
        );
        const childSkillIds = resolve(
          childInput.skillSlugs,
          skillInputs.map((s) => s.slug),
          skillIdsBySlug,
        );
        const [childRow] = await tx
          .insert(agents)
          .values({
            id: newId('agent'),
            slug: childSlug,
            parentId: row.id,
            ...toAgentValues(childInput),
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
        await insertAgentFiles(tx, childRow.id, childInput);
        childSnapshots.push(agentRepo.toAgent(childRow, childServerIds, childSkillIds));
        childIds.push(childRow.id);
        createdSubAgents.push(childRow.slug);
      }

      // 父级快照必须等到子智能体落库后写，才能记录最终 ID。
      await repo.agentVersions.insertAgentVersion(
        tx,
        row.id,
        agentRepo.toAgent(row, serverIds, skillIds, childIds),
      );
      for (const snapshot of childSnapshots) {
        await repo.agentVersions.insertAgentVersion(tx, snapshot.id, snapshot);
      }

      return {
        createdFileCount,
        agent: agentRepo.toAgent(row, serverIds, skillIds, childIds),
        createdServers,
        reusedServers,
        createdSkills,
        createdSubAgents,
      };
    })
    .catch((err: unknown): never => {
      // 并发导入撞上同名 server/skill/agent 的唯一索引：只映射成 409，不重试。
      if (isPgCode(err, '23505')) {
        fail('CONFLICT', '导入期间同名 Server、技能或智能体被其他请求占用，请重试');
      }
      throw err;
    });

  await writeAudit(app.db, request.log, {
    actor: 'admin',
    action: 'agent.imported',
    target: result.agent.id,
    input: {
      slug: result.agent.slug,
      servers: { created: result.createdServers.length, reused: result.reusedServers.length },
      skills: result.createdSkills.length,
      files: result.createdFileCount,
      rules: body.rules.length + subAgents.reduce((count, child) => count + child.rules.length, 0),
      outputStyles:
        body.outputStyles.length +
        subAgents.reduce((count, child) => count + child.outputStyles.length, 0),
      subAgents: result.createdSubAgents.length,
    },
    status: 'ok',
    requestId: request.id,
  });

  const { createdFileCount: _createdFileCount, ...response } = result;
  return { ...response, warnings };
}

export function registerImportRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };

  app.post(
    '/api/import/agents',
    { ...auth, bodyLimit: AGENT_PACKAGE_MAX_BYTES, schema: { body: importBodySchema } },
    async (request, reply) => {
      return reply.status(201).send(await runImport(app, request.body, request));
    },
  );

  app.post(
    '/api/import/agents/archive',
    { ...auth, bodyLimit: 1_600_000, schema: { body: archiveBodySchema } },
    async (request, reply) => {
      const parsed = parseWorkspaceArchive(decodeArchiveBase64(request.body.dataBase64));
      const { body, warnings: mappingWarnings } = archiveImportBody(
        parsed,
        slugFromFilename(request.body.filename),
      );
      const result = await runImport(app, body, request);
      return reply.status(201).send({
        ...result,
        warnings: [...parsed.warnings, ...mappingWarnings, ...result.warnings],
      });
    },
  );
}
