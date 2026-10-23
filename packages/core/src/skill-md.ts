import { type SkillInput, skillInputSchema } from '@agentport/shared';
import { fail } from './errors.js';
import { parseMarkdownFrontmatter } from './markdown-frontmatter.js';

/** 这三个字段只描述技能来源，导入时给出警告但不落库。 */
const DESCRIPTIVE_KEYS = new Set(['license', 'compatibility', 'metadata']);

function invalid(message: string, path = '/skillMd'): never {
  fail('INVALID_INPUT', message, { path });
}

/** 首个非空行是 H1 时作为显示名，并且只移除这一行。 */
function splitHeading(body: string): { body: string; displayName?: string } {
  const lines = body.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  const heading = first === -1 ? null : /^#[ \t]+(.+?)[ \t]*\r?$/.exec(lines[first] ?? '');
  if (!heading?.[1]?.trim()) return { body: body.trim() };
  lines.splice(first, 1);
  return { body: lines.join('\n').trim(), displayName: heading[1].trim() };
}

function fieldOf(path: PropertyKey | undefined): string {
  // slug 由 frontmatter 的 name 推导，报错时仍指向用户写的字段。
  const field = String(path ?? 'name');
  return field === 'slug' ? 'name' : field;
}

/**
 * 解析官方 SKILL.md（YAML frontmatter + markdown 正文）。
 * 纯函数：不执行脚本、不落盘，也不接受会改变运行时行为的未声明字段。
 */
export function parseSkillMd(content: string): { skill: SkillInput; warnings: string[] } {
  const { fields, body: rawBody } = parseMarkdownFrontmatter(content, 'SKILL.md', '/skillMd');
  const warnings: string[] = [];
  const unknown: string[] = [];
  for (const key of fields.keys()) {
    if (key === 'name' || key === 'description') continue;
    if (DESCRIPTIVE_KEYS.has(key)) {
      warnings.push(`忽略描述性前置字段 ${key}（不会保存）`);
      continue;
    }
    unknown.push(key);
  }
  if (unknown.length > 0) {
    invalid(`不支持的 SKILL.md 前置字段：${unknown.join('、')}（可能改变运行时行为）`);
  }

  const { body, displayName } = splitHeading(rawBody);
  const rawName = fields.get('name');
  const parsed = skillInputSchema.safeParse({
    slug: rawName,
    name: displayName ?? rawName,
    description: fields.get('description'),
    body,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = fieldOf(issue?.path[0]);
    invalid(`SKILL.md 的 ${field} 无效：${issue?.message ?? '字段不合法'}`, `/${field}`);
  }

  return { skill: parsed.data, warnings };
}
