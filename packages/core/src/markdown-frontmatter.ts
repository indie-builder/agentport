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

  const scanned = splitFrontmatter(text);
  if (scanned.kind === 'missingOpen') invalidInput(`${label} 必须以 --- 开头`, path);
  if (scanned.kind === 'missingClose') invalidInput(`${label} 的 frontmatter 缺少闭合的 ---`, path);
  const { frontmatter, body } = scanned;

  const doc = parseDocument(frontmatter, { schema: 'core', uniqueKeys: true });
  const yamlError = doc.errors[0];
  if (yamlError) {
    invalidInput(`${label} 的 frontmatter 不是合法 YAML：${yamlError.message}`, path);
  }
  if (!isMap(doc.contents)) {
    invalidInput(`${label} 的 frontmatter 必须是 YAML 映射`, path);
  }

  let hasAnchor = false;
  visit(doc, {
    Node: (_key, node) => {
      if (isAlias(node) || node.anchor) hasAnchor = true;
    },
  });
  if (hasAnchor) {
    invalidInput(`${label} 不支持 YAML 锚点或别名`, path);
  }

  const fields = doc.toJS({ mapAsMap: true, maxAliasCount: 0 }) as Map<unknown, unknown>;
  for (const key of fields.keys()) {
    if (typeof key !== 'string') invalidInput(`${label} 的 frontmatter 键必须是字符串`, path);
  }
  return { fields: fields as Map<string, unknown>, body };
}
