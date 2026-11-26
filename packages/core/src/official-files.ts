import { type AgentInput, agentInputSchema, effortSchema, slugSchema } from '@agentport/shared';
import { fail } from './errors.js';
import { stripBom } from './frontmatter-scan.js';
import { parseMarkdownFrontmatter, splitHeading } from './markdown-frontmatter.js';

export const GENERATED_SUFFIX_START = '<!-- agentport:generated:start -->';
export const GENERATED_SUFFIX_END = '<!-- agentport:generated:end -->';

export function escapeGeneratedBoundaryLines(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      return trimmed === GENERATED_SUFFIX_START || trimmed === GENERATED_SUFFIX_END
        ? line.replace(trimmed, `\\${trimmed}`)
        : line;
    })
    .join('\n');
}

interface LineSpan {
  value: string;
  start: number;
  end: number;
}

function lineSpans(text: string): LineSpan[] {
  const lines: LineSpan[] = [];
  let start = 0;
  for (;;) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    lines.push({ value: text.slice(start, end), start, end });
    if (newline === -1) return lines;
    start = newline + 1;
  }
}

function terminalGeneratedSuffix(text: string): { start: number; end: number } | null {
  const lines = lineSpans(text);
  let last = lines.length - 1;
  while (last >= 0 && lines[last]?.value.trim() === '') last--;
  if (last < 0 || lines[last]?.value.trim() !== GENERATED_SUFFIX_END) return null;
  for (let index = last - 1; index >= 0; index--) {
    if (lines[index]?.value.trim() === GENERATED_SUFFIX_START) {
      return { start: lines[index]?.start ?? 0, end: lines[last]?.end ?? text.length };
    }
  }
  return null;
}

export function parseClaudeMd(content: string): { name: string; systemPrompt: string } {
  const text = stripBom(content).replace(/\r\n/g, '\n');
  const firstLine = text.split('\n', 1)[0] ?? '';
  const heading = /^#[ \t]+(.+?)[ \t]*$/.exec(firstLine);
  if (!heading?.[1]) {
    fail('INVALID_INPUT', 'CLAUDE.md 必须以一行 `# 智能体名称` 开头', { path: '/CLAUDE.md' });
  }
  const afterHeading = text.slice(firstLine.length + 1);
  const suffix = terminalGeneratedSuffix(afterHeading);
  const systemPrompt = afterHeading
    .slice(0, suffix?.start ?? afterHeading.length)
    .replace(/^\r?\n/, '')
    .trim();
  return { name: heading[1].trim(), systemPrompt };
}

interface ParsedChildAgent {
  slug: string;
  name: string;
  description: string;
  model: string;
  maxTurns: number;
  effort?: NonNullable<AgentInput['effort']>;
  skills: string[];
  mcpServers: string[];
  disallowedTools: string[];
  systemPrompt: string;
}

export const CHILD_AGENT_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
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

function stringList(value: unknown, fileLabel: string, field: string, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail('INVALID_INPUT', `${fileLabel}的 ${field} 必须是字符串列表`, { path });
  }
  return value as string[];
}

export function parseChildAgentMd(content: string, path: string): ParsedChildAgent {
  const { fields, body } = parseMarkdownFrontmatter(content, '子智能体文件', path, {
    maxBytes: 200_000,
  });
  const unknown = [...fields.keys()].filter((key) => !CHILD_AGENT_FRONTMATTER_KEYS.has(key));
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
  const effortLevel = effortSchema.options.find((level) => level === effort);
  if (effort !== undefined && effortLevel === undefined) {
    fail('INVALID_INPUT', '子智能体文件的 effort 取值不合法', { path: `${path}/effort` });
  }
  const text = body.replace(/\r\n/g, '\n');
  const suffix = terminalGeneratedSuffix(text);
  const { body: rest, displayName } = splitHeading(text.slice(0, suffix?.start ?? text.length));
  let prompt = rest.replace(/^(?:[ \t]*\n)+/, '');
  if (displayName !== undefined && typeof description === 'string') {
    const paragraph = description.replace(/\r\n/g, '\n');
    if (prompt.replace(/\n+$/, '') === paragraph) prompt = '';
    else if (prompt.startsWith(`${paragraph}\n\n`)) {
      prompt = prompt.slice(paragraph.length + 2);
    }
  }
  prompt = prompt.trim();
  if (prompt === '' && suffix === null) {
    fail('INVALID_INPUT', '子智能体文件的正文不能为空', { path });
  }

  return {
    slug: name,
    name: displayName ?? name,
    description: typeof description === 'string' ? description : '',
    model,
    maxTurns: (maxTurns as number | undefined) ?? agentInputSchema.shape.maxTurns.parse(undefined),
    ...(effortLevel === undefined ? {} : { effort: effortLevel }),
    skills: stringList(fields.get('skills'), '子智能体文件', 'skills', path),
    mcpServers: stringList(fields.get('mcpServers'), '子智能体文件', 'mcpServers', path),
    disallowedTools: stringList(
      fields.get('disallowedTools'),
      '子智能体文件',
      'disallowedTools',
      path,
    ),
    systemPrompt: prompt,
  };
}

export function parseRuleMd(
  content: string,
  slug: string,
  path: string,
): {
  slug: string;
  content: string;
  globs: string;
} {
  const text = stripBom(content);
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
  const globs = stringList(paths, '规则文件', 'paths', path).join(', ');
  return { slug, content: body.trim(), globs };
}

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
