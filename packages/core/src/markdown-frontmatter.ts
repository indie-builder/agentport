import { isAlias, isMap, parseDocument, visit } from 'yaml';
import { fail } from './errors.js';

/** 与 API 导入路由、官方 SKILL.md 的 128 KiB 上限一致（按 UTF-8 字节）。 */
const MAX_BYTES = 131_072;

/** SKILL.md 与智能体定义共用的 frontmatter 解析：BOM、字节上限、YAML 映射与锚点限制。 */
export function parseMarkdownFrontmatter(
  content: string,
  label: string,
  path: string,
  options?: { maxBytes?: number },
): { fields: Map<string, unknown>; body: string } {
  function invalid(message: string): never {
    fail('INVALID_INPUT', message, { path });
  }

  const maxBytes = options?.maxBytes ?? MAX_BYTES;
  const text = content.replace(/^﻿/, '');
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    invalid(`${label} 超过 ${maxBytes} 字节上限`);
  }

  const openingEnd = text.indexOf('\n');
  const opening = (openingEnd === -1 ? text : text.slice(0, openingEnd)).replace(/\r$/, '');
  if (!/^---[ \t]*$/.test(opening)) {
    invalid(`${label} 必须以 --- 开头`);
  }

  let lineStart = openingEnd + 1;
  let frontmatter: string | undefined;
  let body = '';
  while (lineStart <= text.length) {
    const lineEnd = text.indexOf('\n', lineStart);
    const end = lineEnd === -1 ? text.length : lineEnd;
    const line = text.slice(lineStart, end).replace(/\r$/, '');
    if (/^---[ \t]*$/.test(line)) {
      frontmatter = text.slice(openingEnd + 1, lineStart);
      body = lineEnd === -1 ? '' : text.slice(lineEnd + 1);
      break;
    }
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }
  if (frontmatter === undefined) invalid(`${label} 的 frontmatter 缺少闭合的 ---`);

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

  // maxAliasCount: 0 是纵深防御；锚点与别名已在上面拒绝。
  const fields = doc.toJS({ mapAsMap: true, maxAliasCount: 0 }) as Map<unknown, unknown>;
  for (const key of fields.keys()) {
    if (typeof key !== 'string') invalid(`${label} 的 frontmatter 键必须是字符串`);
  }
  return { fields: fields as Map<string, unknown>, body };
}
