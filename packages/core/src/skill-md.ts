import { type SkillInput, skillInputSchema } from '@agentport/shared';
import { invalidInput } from './errors.js';
import { parseMarkdownFrontmatter, splitHeading } from './markdown-frontmatter.js';

export interface SkillProvenance {
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
}

export type ParsedSkill = SkillInput & SkillProvenance;

const PROVENANCE_KEYS = new Set(['license', 'compatibility', 'metadata']);

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
    invalidInput(`SKILL.md 的 ${keyPath} 必须是有限数字`, '/metadata');
  }
  return value;
}

function provenanceOf(fields: Map<string, unknown>): SkillProvenance {
  const provenance: SkillProvenance = {};
  for (const key of ['license', 'compatibility'] as const) {
    const value = fields.get(key);
    if (value === undefined) continue;
    if (typeof value !== 'string') invalidInput(`SKILL.md 的 ${key} 必须是字符串`, `/${key}`);
    if (value.length > 200) {
      invalidInput(`SKILL.md 的 ${key} 不能超过 200 个字符`, `/${key}`);
    }
    provenance[key] = value;
  }
  const metadata = fields.get('metadata');
  if (metadata !== undefined) {
    const plain = plainValue(metadata, 'metadata');
    if (typeof plain !== 'object' || plain === null || Array.isArray(plain)) {
      invalidInput('SKILL.md 的 metadata 必须是映射', '/metadata');
    }
    provenance.metadata = plain as Record<string, unknown>;
  }
  return provenance;
}

function fieldOf(path: PropertyKey | undefined): string {
  const field = String(path ?? 'name');
  return field === 'slug' ? 'name' : field;
}

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
    invalidInput(
      `不支持的 SKILL.md 前置字段：${unknown.join('、')}（可能改变运行时行为）`,
      '/skillMd',
    );
  }

  const { body: instructions, displayName } = splitHeading(rawBody);
  const rawName = fields.get('name');
  const parsed = skillInputSchema.safeParse({
    slug: options?.slug ?? rawName,
    name: displayName ?? rawName,
    description: fields.get('description'),
    body: instructions.trim(),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = fieldOf(issue?.path[0]);
    invalidInput(`SKILL.md 的 ${field} 无效：${issue?.message ?? '字段不合法'}`, `/${field}`);
  }

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
