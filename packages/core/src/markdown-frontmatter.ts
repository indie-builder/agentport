import { MARKDOWN_FILE_MAX_BYTES } from '@agentport/shared';
import { isAlias, isMap, parseDocument, visit } from 'yaml';
import { fail } from './errors.js';
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
  function invalid(message: string): never {
    fail('INVALID_INPUT', message, { path });
  }

  const maxBytes = options?.maxBytes ?? MARKDOWN_FILE_MAX_BYTES;
  const text = stripBom(content);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    invalid(`${label} 超过 ${maxBytes} 字节上限`);
  }

  const scanned = splitFrontmatter(text);
  if (scanned.kind === 'missingOpen') invalid(`${label} 必须以 --- 开头`);
  if (scanned.kind === 'missingClose') invalid(`${label} 的 frontmatter 缺少闭合的 ---`);
  const { frontmatter, body } = scanned;

  const doc = parseDocument(frontmatter, { schema: 'core', uniqueKeys: true });
  const yamlError = doc.errors[0];
  if (yamlError) {
    invalid(`${label} 的 frontmatter 不是合法 YAML：${yamlError.message}`);
  }
  if (!isMap(doc.contents)) {
    invalid(`${label} 的 frontmatter 必须是 YAML 映射`);
  }

  let hasAnchor = false;
  visit(doc, {
    Node: (_key, node) => {
      if (isAlias(node) || node.anchor) hasAnchor = true;
    },
  });
  if (hasAnchor) {
    invalid(`${label} 不支持 YAML 锚点或别名`);
  }

  const fields = doc.toJS({ mapAsMap: true, maxAliasCount: 0 }) as Map<unknown, unknown>;
  for (const key of fields.keys()) {
    if (typeof key !== 'string') invalid(`${label} 的 frontmatter 键必须是字符串`);
  }
  return { fields: fields as Map<string, unknown>, body };
}
