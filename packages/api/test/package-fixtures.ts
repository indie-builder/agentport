import {
  type McpJsonEntry,
  renderOutputStyleMd,
  renderRuleMd,
  renderSkillMd,
  renderSubAgentMd,
} from '@agentport/core';
import type {
  AgentPackageSidecar,
  PackageOutputStyle,
  PackageRule,
  PackageServer,
  PackageSubAgent,
} from '@agentport/shared';
import {
  AGENT_PACKAGE_PATHS,
  AGENT_PACKAGE_SIDECAR,
  AGENT_PACKAGE_SIDECAR_VERSION,
} from '@agentport/shared';
import { unzipSync, zipSync } from 'fflate';
import { encodePackage } from '../src/features/agent-package-zip.js';

export interface SkillSpec {
  slug: string;
  name: string;
  description: string;
  body: string;
  files?: Array<{ path: string; content: string }>;
}

export interface ChildSpec {
  slug: string;
  name?: string;
  description?: string;
  model?: string;
  maxTurns?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  systemPrompt?: string;
  skills?: string[];
  disallowedTools?: string[];
  permissionMode?: 'dontAsk' | 'plan' | 'default' | 'acceptEdits';
  maxBudgetUsd?: number;
  timeoutMs?: number;
  enabled?: boolean;
  allowedTools?: string[];
  serverNames?: string[];
  rules?: PackageRule[];
  outputStyles?: PackageOutputStyle[];
}

export interface AgentSpec {
  slug: string;
  name: string;
  role?: string;
  description?: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: 'dontAsk' | 'plan' | 'default' | 'acceptEdits';
  uiFormat?: 'markdown' | 'openui';
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxThinkingTokens?: number;
  enabled?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  serverNames?: string[];
  skillSlugs?: string[];
}

export interface PackageSpec {
  agent: AgentSpec;
  rules?: PackageRule[];
  outputStyles?: PackageOutputStyle[];
  skills?: SkillSpec[];
  subAgents?: ChildSpec[];
  servers?: PackageServer[];
  /** 额外写入的原始文件，用于构造非法包。 */
  extraFiles?: Record<string, string>;
  /** 不写侧车；此时导入必须靠 ?slug= 或 CLAUDE.md 首行。 */
  omitSidecar?: boolean;
}

const SKILL_MD = (skill: SkillSpec) =>
  renderSkillMd({
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    body: skill.body,
  });

const CHILD_MD = (child: ChildSpec, serverNames: string[]) =>
  renderSubAgentMd({
    agent: {
      slug: child.slug,
      name: child.name ?? `Child ${child.slug}`,
      description: child.description ?? '',
      model: child.model ?? 'claude-sonnet-5-5',
      systemPrompt: child.systemPrompt ?? `prompt for ${child.slug}`,
      maxTurns: child.maxTurns ?? 20,
      permissionMode: child.permissionMode ?? 'dontAsk',
      effort: child.effort ?? null,
      allowedTools: child.allowedTools ?? [],
      disallowedTools: child.disallowedTools ?? [],
      timeoutMs: child.timeoutMs ?? 600_000,
      // 子级 MCP 绑定走官方 mcpServers（根 .mcp.json 里的名字）。
      serverNames: child.serverNames ?? [],
    },
    servers: serverNames.map((name) => ({
      name,
      entry: { type: 'http' as const, url: 'https://placeholder.invalid/mcp', headers: {} },
    })),
    skills: (child.skills ?? []).map((slug) => ({
      slug,
      name: slug,
      description: slug,
      body: '',
    })),
  });

/** 把紧凑 spec 渲染成官方 `.claude/` 目录；与导出端共用同一批渲染函数。 */
export function packageFiles(spec: PackageSpec): Record<string, string> {
  const files: Record<string, string> = {};
  const agent = spec.agent;
  const claudeMd = [`# ${agent.name}`, '', agent.systemPrompt ?? `prompt for ${agent.slug}`];
  const childNames = (spec.subAgents ?? []).map((child) => child.slug);
  if (childNames.length > 0) {
    claudeMd.push('', '## 可用子智能体', '', ...childNames.map((slug) => `- ${slug}`));
  }
  files[AGENT_PACKAGE_PATHS.claudeMd] = `${claudeMd.join('\n')}\n`;
  const mcpServers: Record<string, McpJsonEntry> = {};
  files[AGENT_PACKAGE_PATHS.mcpJson] = `${JSON.stringify({ mcpServers }, null, 2)}\n`;

  for (const rule of spec.rules ?? []) {
    files[`${AGENT_PACKAGE_PATHS.rulesDir}${rule.slug}.md`] = renderRuleMd(rule);
  }
  for (const style of spec.outputStyles ?? []) {
    files[`${AGENT_PACKAGE_PATHS.outputStylesDir}${style.slug}.md`] = renderOutputStyleMd(style);
  }
  const selected = (spec.outputStyles ?? []).find((style) => style.isSelected);
  if (selected) {
    files[AGENT_PACKAGE_PATHS.settings] =
      `${JSON.stringify({ outputStyle: selected.slug }, null, 2)}\n`;
  }
  for (const skill of spec.skills ?? []) {
    const base = `${AGENT_PACKAGE_PATHS.skillsDir}${skill.slug}/`;
    files[`${base}SKILL.md`] = SKILL_MD(skill);
    for (const file of skill.files ?? []) files[`${base}${file.path}`] = file.content;
  }
  const serverNames = (spec.servers ?? []).map((server) => server.name);
  for (const child of spec.subAgents ?? []) {
    files[`${AGENT_PACKAGE_PATHS.agentsDir}${child.slug}.md`] = CHILD_MD(child, serverNames);
  }

  if (!spec.omitSidecar) {
    const sidecar: AgentPackageSidecar = {
      version: AGENT_PACKAGE_SIDECAR_VERSION,
      agent: {
        slug: agent.slug,
        name: agent.name,
        role: (agent.role ?? '通用助手') as AgentPackageSidecar['agent']['role'],
        description: agent.description ?? '',
        model: agent.model ?? 'claude-sonnet-5-5',
        permissionMode: agent.permissionMode ?? 'dontAsk',
        uiFormat: agent.uiFormat ?? 'markdown',
        maxTurns: agent.maxTurns ?? 20,
        maxBudgetUsd: agent.maxBudgetUsd ?? 2,
        timeoutMs: agent.timeoutMs ?? 600_000,
        ...(agent.effort === undefined ? {} : { effort: agent.effort }),
        ...(agent.maxThinkingTokens === undefined
          ? {}
          : { maxThinkingTokens: agent.maxThinkingTokens }),
        enabled: agent.enabled ?? true,
        allowedTools: agent.allowedTools ?? [],
        disallowedTools: agent.disallowedTools ?? [],
        serverNames: agent.serverNames ?? [],
        skillSlugs: agent.skillSlugs ?? [],
      },
      servers: spec.servers ?? [],
      subAgents: (spec.subAgents ?? []).map(
        (child): PackageSubAgent => ({
          slug: child.slug,
          permissionMode: child.permissionMode ?? 'dontAsk',
          maxBudgetUsd: child.maxBudgetUsd ?? 2,
          timeoutMs: child.timeoutMs ?? 600_000,
          ...(child.maxThinkingTokens === undefined
            ? {}
            : { maxThinkingTokens: child.maxThinkingTokens }),
          enabled: child.enabled ?? true,
          allowedTools: child.allowedTools ?? [],
          disallowedTools: child.disallowedTools ?? [],
          rules: child.rules ?? [],
          outputStyles: child.outputStyles ?? [],
        }),
      ),
    };
    files[AGENT_PACKAGE_SIDECAR] = `${JSON.stringify(sidecar, null, 2)}\n`;
  }

  return { ...files, ...(spec.extraFiles ?? {}) };
}

/** 构造合法 ZIP；非法路径/符号链接等场景直接用 fflate 打原始包。 */
export function packageZip(spec: PackageSpec): Buffer {
  return encodePackage(packageFiles(spec));
}

/** 不压缩的 ZIP：体积与内容一一对应，用于精确验证字节上限。 */
export function packageZipStored(spec: PackageSpec): Buffer {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(packageFiles(spec))) {
    entries[name] = new TextEncoder().encode(content);
  }
  return Buffer.from(zipSync(entries, { level: 0 }));
}

export interface RawZipEntry {
  name: string;
  content?: string;
  /** Unix 文件类型位，例如 0o120777 表示符号链接。 */
  mode?: number;
}

/** 故意构造的 ZIP：允许重复条目、任意路径与符号链接，用于拒绝路径测试。 */
export function rawZip(entries: RawZipEntry[]): Buffer {
  const data: Record<string, [Uint8Array, { os?: number; attrs?: number }]> = {};
  for (const entry of entries) {
    const encoder = new TextEncoder();
    const value = encoder.encode(entry.content ?? '');
    data[entry.name] = [
      value,
      entry.mode === undefined ? {} : { os: 3, attrs: (entry.mode << 16) >>> 0 },
    ];
  }
  return Buffer.from(zipSync(data));
}

/** @fastify/compress 可能压缩二进制响应，这里统一解出条目内容。 */
export function unzipPackage(body: Buffer | Uint8Array): Map<string, string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const result = new Map<string, string>();
  for (const [name, bytes] of Object.entries(unzipSync(body))) {
    result.set(name, decoder.decode(bytes));
  }
  return result;
}

export function sidecarOf(files: Map<string, string>): AgentPackageSidecar {
  const text = files.get(AGENT_PACKAGE_SIDECAR);
  if (text === undefined) throw new Error('package has no sidecar');
  return JSON.parse(text) as AgentPackageSidecar;
}
