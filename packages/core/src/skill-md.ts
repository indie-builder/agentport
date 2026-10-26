import { type SkillInput, skillInputSchema } from '@agentport/shared';
import { fail } from './errors.js';
import { parseMarkdownFrontmatter } from './markdown-frontmatter.js';

/** 官方 SKILL.md 的来源描述字段：解析时保留，导出时原样写回 frontmatter。 */
export interface SkillProvenance {
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
}

export type ParsedSkill = SkillInput & SkillProvenance;

const PROVENANCE_KEYS = new Set(['license', 'compatibility', 'metadata']);

function invalid(message: string, path = '/skillMd'): never {
  fail('INVALID_INPUT', message, { path });
}

/** 解析用的 mapAsMap 会把嵌套映射也变成 Map；metadata 要转回普通对象才能写回 JSON/YAML。 */
function plainValue(value: unknown, keyPath: string): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value].map(([key, item]) => [String(key), plainValue(item, `${keyPath}.${String(key)}`)]),
    );
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => plainValue(item, `${keyPath}[${index}]`));
  }
  // JSON.stringify 会把 NaN/Infinity 写成 null，往返后值就变了。
  if (typeof value === 'number' && !Number.isFinite(value)) {
    invalid(`SKILL.md 的 ${keyPath} 必须是有限数字`, '/metadata');
  }
  return value;
}

function provenanceOf(fields: Map<string, unknown>): SkillProvenance {
  const provenance: SkillProvenance = {};
  for (const key of ['license', 'compatibility'] as const) {
    const value = fields.get(key);
    if (value === undefined) continue;
    if (typeof value !== 'string') invalid(`SKILL.md 的 ${key} 必须是字符串`, `/${key}`);
    if (value.length > 200) {
      invalid(`SKILL.md 的 ${key} 不能超过 200 个字符`, `/${key}`);
    }
    provenance[key] = value;
  }
  const metadata = fields.get('metadata');
  if (metadata !== undefined) {
    const plain = plainValue(metadata, 'metadata');
    if (typeof plain !== 'object' || plain === null || Array.isArray(plain)) {
      invalid('SKILL.md 的 metadata 必须是映射', '/metadata');
    }
    provenance.metadata = plain as Record<string, unknown>;
  }
  return provenance;
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
export function parseSkillMd(
  content: string,
  options?: { slug?: string },
): { skill: ParsedSkill; warnings: string[] } {
  const { fields, body: rawBody } = parseMarkdownFrontmatter(content, 'SKILL.md', '/skillMd');
  const unknown: string[] = [];
  for (const key of fields.keys()) {
    if (key === 'name' || key === 'description' || PROVENANCE_KEYS.has(key)) continue;
    unknown.push(key);
  }
  if (unknown.length > 0) {
    invalid(`不支持的 SKILL.md 前置字段：${unknown.join('、')}（可能改变运行时行为）`);
  }

  const { body, displayName } = splitHeading(rawBody);
  const rawName = fields.get('name');
  const parsed = skillInputSchema.safeParse({
    slug: options?.slug ?? rawName,
    name: displayName ?? rawName,
    description: fields.get('description'),
    body,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = fieldOf(issue?.path[0]);
    invalid(`SKILL.md 的 ${field} 无效：${issue?.message ?? '字段不合法'}`, `/${field}`);
  }

  // 逐字段取而非展开 parsed.data：可选来源字段展开后会带上 undefined，与 exactOptionalPropertyTypes 冲突。
  return {
    skill: {
      slug: parsed.data.slug,
      name: parsed.data.name,
      description: parsed.data.description,
      body: parsed.data.body,
      ...provenanceOf(fields),
    },
    warnings: [],
  };
}
