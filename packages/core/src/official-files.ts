import { type AgentInput, slugSchema } from '@agentport/shared';
import { fail } from './errors.js';
import { parseMarkdownFrontmatter } from './markdown-frontmatter.js';

/**
 * 官方工作区文件的读取端：与 `renderWorkspace` 的写入端一一对应。
 * 只解析官方文件本身，不在这里做平台绑定的推断。
 */

const GENERATED_CLAUDE_SECTION = '\n## 工具使用\n';
const DELEGATION_NOTE = '你是被父智能体同步调用的：直接执行任务并返回最终文本。';

/**
 * 根智能体的显示名与系统提示都来自 CLAUDE.md；其后的工具/技能/委派段落是渲染产物。
 * shortcut: 以渲染器自己的 `## 工具使用` 作为正文边界，手写目录若没有该段落就整篇当提示词。
 */
export function parseClaudeMd(content: string): { name: string; systemPrompt: string } {
  // 导出的文件会被 Windows 编辑器/autocrlf 存成 CRLF，生成段边界与子定义解析统一按 LF 判定。
  const text = content.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const firstLine = text.split('\n', 1)[0] ?? '';
  const heading = /^#[ \t]+(.+?)[ \t]*$/.exec(firstLine);
  if (!heading?.[1]) {
    fail('INVALID_INPUT', 'CLAUDE.md 必须以一行 `# 智能体名称` 开头', { path: '/CLAUDE.md' });
  }
  const afterHeading = text.slice(firstLine.length + 1);
  const markerIndex = afterHeading.indexOf(GENERATED_CLAUDE_SECTION);
  const systemPrompt = (markerIndex === -1 ? afterHeading : afterHeading.slice(0, markerIndex))
    .replace(/^\r?\n/, '')
    .trim();
  return { name: heading[1].trim(), systemPrompt };
}

export interface ParsedChildAgent {
  slug: string;
  name: string;
  description: string;
  model: string;
  maxTurns: number;
  effort?: NonNullable<AgentInput['effort']>;
  skills: string[];
  /** 子定义自己的 MCP 绑定：官方 frontmatter 的 mcpServers（按名字引用根 .mcp.json）。 */
  mcpServers: string[];
  disallowedTools: string[];
  systemPrompt: string;
}

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const CHILD_KEYS = new Set([
  'name',
  'description',
  'model',
  'maxTurns',
  'effort',
  'skills',
  'disallowedTools',
  'mcpServers',
  'memory',
]);

/**
 * 官方子智能体 memory 只接 project：平台的挂载点与定义导出契约只覆盖
 * `.claude/agent-memory/<slug>/`；user 与 local（含工作区内的 `agent-memory-local/`）
 * 未纳入这套契约，导入后无法保证可用，明确拒绝而不是静默降级。
 */
export function assertProjectMemory(value: unknown, label: string, path: string): void {
  if (value === undefined || value === 'project') return;
  fail(
    'INVALID_INPUT',
    `${label}的 memory 仅支持 project；user 与 local 未纳入平台的挂载与导出契约`,
    {
      path,
    },
  );
}

function stringList(value: unknown, field: string, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail('INVALID_INPUT', `子智能体文件的 ${field} 必须是字符串列表`, { path });
  }
  return value as string[];
}

/**
 * `.claude/agents/<slug>.md`：frontmatter 是 SDK 读取的字段，
 * 正文由显示名、描述、系统提示与固定的等待说明组成。
 */
export function parseChildAgentMd(content: string, path: string): ParsedChildAgent {
  const { fields, body } = parseMarkdownFrontmatter(content, '子智能体文件', path, {
    maxBytes: 200_000,
  });
  const unknown = [...fields.keys()].filter((key) => !CHILD_KEYS.has(key));
  if (unknown.length > 0) {
    fail('INVALID_INPUT', `子智能体文件含不支持的字段：${unknown.join('、')}`, {
      path: `${path}/${unknown[0]}`,
    });
  }
  assertProjectMemory(fields.get('memory'), '子智能体文件', `${path}/memory`);
  const name = fields.get('name');
  if (typeof name !== 'string' || !slugSchema.safeParse(name).success) {
    fail('INVALID_INPUT', '子智能体文件的 name 必须是合法 slug', { path: `${path}/name` });
  }
  const model = fields.get('model');
  if (typeof model !== 'string' || model.trim() === '' || model === 'inherit') {
    fail('INVALID_INPUT', '子智能体文件的 model 必须是非空模型名', { path: `${path}/model` });
  }
  const maxTurns = fields.get('maxTurns');
  if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || (maxTurns as number) <= 0)) {
    fail('INVALID_INPUT', '子智能体文件的 maxTurns 必须是正整数', { path: `${path}/maxTurns` });
  }
  const description = fields.get('description');
  const effort = fields.get('effort');
  const effortLevel = EFFORT_LEVELS.find((level) => level === effort);
  if (effort !== undefined && effortLevel === undefined) {
    fail('INVALID_INPUT', '子智能体文件的 effort 取值不合法', { path: `${path}/effort` });
  }
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const headingIndex = lines.findIndex((line) => line.startsWith('# '));
  const displayName =
    headingIndex === -1 ? (description ?? name) : (lines[headingIndex] ?? '').slice(2).trim();
  const rest = headingIndex === -1 ? lines : lines.slice(headingIndex + 1);
  // 去掉紧随标题的描述行（与 frontmatter 一致时才删，避免误删正文）。
  if (typeof description === 'string' && rest[0] === '' && rest[1] === description)
    rest.splice(0, 2);
  const noteIndex = rest.indexOf(DELEGATION_NOTE);
  const prompt = (noteIndex === -1 ? rest : rest.slice(0, noteIndex)).join('\n').trim();
  if (prompt === '') {
    fail('INVALID_INPUT', '子智能体文件的正文不能为空', { path });
  }

  return {
    slug: name,
    name: typeof displayName === 'string' && displayName !== '' ? displayName : name,
    description: typeof description === 'string' ? description : '',
    model,
    maxTurns: (maxTurns as number | undefined) ?? 20,
    ...(effortLevel === undefined ? {} : { effort: effortLevel }),
    skills: stringList(fields.get('skills'), 'skills', path),
    mcpServers: stringList(fields.get('mcpServers'), 'mcpServers', path),
    disallowedTools: stringList(fields.get('disallowedTools'), 'disallowedTools', path),
    systemPrompt: prompt,
  };
}

/** `.claude/rules/<slug>.md`：`paths` frontmatter 存 globs，其余是规则正文。 */
export function parseRuleMd(
  content: string,
  slug: string,
  path: string,
): {
  slug: string;
  content: string;
  globs: string;
} {
  const text = content.replace(/^﻿/, '');
  // 无 frontmatter 的纯 Markdown 规则没有 globs 作用域，正文就是全文。
  if (!/^---[ \t]*\r?\n/.test(text)) {
    return { slug, content: text.trim(), globs: '' };
  }
  const { fields, body } = parseMarkdownFrontmatter(text, '规则文件', path);
  const unknown = [...fields.keys()].filter((key) => key !== 'paths');
  if (unknown.length > 0) {
    fail('INVALID_INPUT', `规则文件含不支持的字段：${unknown.join('、')}`, {
      path: `${path}/${unknown[0]}`,
    });
  }
  const paths = fields.get('paths');
  const globs = stringList(paths, 'paths', path).join(', ');
  return { slug, content: body.trim(), globs };
}

/** `.claude/output-styles/<slug>.md`：官方 frontmatter + 风格正文。 */
export function parseOutputStyleMd(
  content: string,
  slug: string,
  path: string,
): {
  slug: string;
  description: string;
  keepCodingInstructions: boolean;
  body: string;
} {
  const { fields, body } = parseMarkdownFrontmatter(content, '输出风格文件', path);
  const unknown = [...fields.keys()].filter(
    (key) => key !== 'name' && key !== 'description' && key !== 'keep-coding-instructions',
  );
  if (unknown.length > 0) {
    fail('INVALID_INPUT', `输出风格文件含不支持的字段：${unknown.join('、')}`, {
      path: `${path}/${unknown[0]}`,
    });
  }
  const name = fields.get('name');
  if (name !== undefined && name !== slug) {
    fail('INVALID_INPUT', '输出风格文件的 name 必须与文件名一致', { path: `${path}/name` });
  }
  const description = fields.get('description');
  const keep = fields.get('keep-coding-instructions');
  if (keep !== undefined && typeof keep !== 'boolean') {
    fail('INVALID_INPUT', 'keep-coding-instructions 必须是布尔值', {
      path: `${path}/keep-coding-instructions`,
    });
  }
  return {
    slug,
    description: typeof description === 'string' ? description : '',
    keepCodingInstructions: keep === true,
    body: body.trim(),
  };
}
