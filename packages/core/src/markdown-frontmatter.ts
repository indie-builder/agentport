import { MARKDOWN_FILE_MAX_BYTES } from '@agentport/shared';
import { isAlias, isMap, parseDocument, visit } from 'yaml';
import { invalidInput } from './errors.js';
import { splitFrontmatter, stripBom } from './frontmatter-scan.js';

export function splitHeading(body: string): { body: string; displayName?: string } {
  const lines = body.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  const heading = first === -1 ? null : /^#[ \t]+(.+?)[ \t]*\r?$/.exec(lines[first] ?? '');
  if (!heading?.[1]?.trim()) return { body };
  lines.splice(first, 1);
  return { body: lines.join('\n'), displayName: heading[1].trim() };
}

export type FrontmatterParseResult =
  | { kind: 'ok'; fields: Map<unknown, unknown>; body: string }
  | { kind: 'missingOpen'; text: string }
  | { kind: 'missingClose'; text: string }
  | { kind: 'invalidYaml'; text: string; message: string }
  | { kind: 'notMap'; text: string }
  | { kind: 'hasAnchor'; text: string }
  | { kind: 'toJsError'; text: string; error: unknown };

export function parseYamlFrontmatter(
  content: string,
  options?: { rejectAnchors?: boolean },
): FrontmatterParseResult {
  const text = stripBom(content);
  const scanned = splitFrontmatter(text);
  if (scanned.kind === 'missingOpen') return { kind: 'missingOpen', text };
  if (scanned.kind === 'missingClose') return { kind: 'missingClose', text };
  const { frontmatter, body } = scanned;

  const doc = parseDocument(frontmatter, { schema: 'core', uniqueKeys: true });
  const yamlError = doc.errors[0];
  if (yamlError) return { kind: 'invalidYaml', text, message: yamlError.message };
  if (!isMap(doc.contents)) return { kind: 'notMap', text };

  if (options?.rejectAnchors) {
    let hasAnchor = false;
    visit(doc, {
      Node: (_key, node) => {
        if (isAlias(node) || node.anchor) hasAnchor = true;
      },
    });
    if (hasAnchor) return { kind: 'hasAnchor', text };
  }

  let fields: Map<unknown, unknown>;
  try {
    fields = doc.toJS(
      options?.rejectAnchors ? { mapAsMap: true, maxAliasCount: 0 } : { mapAsMap: true },
    ) as Map<unknown, unknown>;
  } catch (error) {
    return { kind: 'toJsError', text, error };
  }
  return { kind: 'ok', fields, body };
}

export function parseMarkdownFrontmatter(
  content: string,
  label: string,
  path: string,
  options?: { maxBytes?: number },
): { fields: Map<string, unknown>; body: string } {
  const maxBytes = options?.maxBytes ?? MARKDOWN_FILE_MAX_BYTES;
  const text = stripBom(content);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    invalidInput(`${label} 超过 ${maxBytes} 字节上限`, path);
  }

  const parsed = parseYamlFrontmatter(text, { rejectAnchors: true });
  switch (parsed.kind) {
    case 'missingOpen':
      return invalidInput(`${label} 必须以 --- 开头`, path);
    case 'missingClose':
      return invalidInput(`${label} 的 frontmatter 缺少闭合的 ---`, path);
    case 'invalidYaml':
      return invalidInput(`${label} 的 frontmatter 不是合法 YAML：${parsed.message}`, path);
    case 'notMap':
      return invalidInput(`${label} 的 frontmatter 必须是 YAML 映射`, path);
    case 'hasAnchor':
      return invalidInput(`${label} 不支持 YAML 锚点或别名`, path);
    case 'toJsError':
      throw parsed.error;
    case 'ok':
      break;
  }

  for (const key of parsed.fields.keys()) {
    if (typeof key !== 'string') invalidInput(`${label} 的 frontmatter 键必须是字符串`, path);
  }
  return { fields: parsed.fields as Map<string, unknown>, body: parsed.body };
}
