import { type ApiToolInput, apiToolInputSchema } from '@agentport/shared';
import { fieldErrors } from './form.js';

/** 一行一个 `KEY=value`，值里允许出现 `=`。 */
export function parsePairs(text: string, kind: 'env' | 'headers'): Record<string, string> {
  const entries: [string, string][] = [];
  const seen = new Map<string, number>();
  for (const [lineNumber, line] of text.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) {
      throw new Error(`第 ${lineNumber + 1} 行需要 KEY=value 格式，且 KEY 不能为空`);
    }
    const key = trimmed.slice(0, index).trim();
    const canonicalKey = kind === 'headers' ? key.toLowerCase() : key;
    const previous = seen.get(canonicalKey);
    if (previous !== undefined) {
      throw new Error(`第 ${lineNumber + 1} 行的 ${key} 与第 ${previous} 行重复，请合并为一行`);
    }
    seen.set(canonicalKey, lineNumber + 1);
    entries.push([key, trimmed.slice(index + 1).trim()]);
  }
  return Object.fromEntries(entries);
}

export function validateToolInput(
  form: ApiToolInput,
  schemaText: string,
): { data: ApiToolInput; errors?: never } | { data?: never; errors: Record<string, string> } {
  let schema: unknown;
  try {
    schema = JSON.parse(schemaText);
  } catch {
    return { errors: { inputSchema: '这里不是合法 JSON，请先修正语法再保存' } };
  }
  const parsed = apiToolInputSchema.safeParse({ ...form, inputSchema: schema });
  if (!parsed.success) return { errors: fieldErrors(parsed.error.issues) };

  if (!form.pathTemplate.trim()) {
    return { errors: { pathTemplate: '路径不能为空，请填写例如 /users/{id}' } };
  }
  const properties = parsed.data.inputSchema.properties;
  const keys =
    properties && typeof properties === 'object' && !Array.isArray(properties)
      ? Object.keys(properties)
      : [];
  const placeholders = [...form.pathTemplate.matchAll(/\{([^{}/]+)\}/g)].map(
    (match) => match[1] ?? '',
  );
  const missing = placeholders.filter((name) => name && !keys.includes(name));
  if (missing.length > 0) {
    return {
      errors: {
        pathTemplate: `路径里的 ${missing.map((name) => `{${name}}`).join('、')} 在 inputSchema.properties 中没有同名属性，请补上后再保存`,
      },
    };
  }
  return { data: parsed.data };
}
