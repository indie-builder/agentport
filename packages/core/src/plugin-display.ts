import { isMap, parseDocument } from 'yaml';

export interface PluginMarkdown {
  name: string;
  description: string;
  /** 去掉 frontmatter 后的正文；frontmatter 畸形时是完整原文。 */
  body: string;
  issue?: string;
}

const DELIMITER = /^---[ \t]*$/;

function withoutBom(content: string): string {
  return content.replace(/^﻿/, '');
}

function raw(content: string, fallbackName: string, issue?: string): PluginMarkdown {
  return {
    name: fallbackName,
    description: '',
    body: content,
    ...(issue === undefined ? {} : { issue }),
  };
}

function textField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 只读展示用解析：frontmatter 只取字符串 name / description，未知字段原样保留。
 * 与 `parseMarkdownFrontmatter` 不同，这里不校验导入规则，也不使用 Buffer，可在浏览器执行。
 * 畸形 frontmatter 不吞内容：正文回退为完整原文并给出 issue。
 */
export function readPluginMarkdown(content: string, fallbackName: string): PluginMarkdown {
  const text = withoutBom(content);
  const openingEnd = text.indexOf('\n');
  const opening = (openingEnd === -1 ? text : text.slice(0, openingEnd)).replace(/\r$/, '');
  if (!DELIMITER.test(opening)) {
    return { name: fallbackName, description: '', body: text };
  }

  let lineStart = openingEnd + 1;
  let frontmatter: string | undefined;
  let body = '';
  while (lineStart <= text.length) {
    const lineEnd = text.indexOf('\n', lineStart);
    const end = lineEnd === -1 ? text.length : lineEnd;
    const line = text.slice(lineStart, end).replace(/\r$/, '');
    if (DELIMITER.test(line)) {
      frontmatter = text.slice(openingEnd + 1, lineStart);
      body = lineEnd === -1 ? '' : text.slice(lineEnd + 1);
      break;
    }
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }
  if (frontmatter === undefined) {
    return raw(text, fallbackName, 'frontmatter 缺少闭合的 ---');
  }

  const doc = parseDocument(frontmatter, { schema: 'core', uniqueKeys: true });
  const yamlError = doc.errors[0];
  if (yamlError) {
    return raw(text, fallbackName, `frontmatter 不是合法 YAML：${yamlError.message}`);
  }
  if (!isMap(doc.contents)) {
    return raw(text, fallbackName, 'frontmatter 必须是 YAML 映射');
  }

  let fields: Map<unknown, unknown>;
  try {
    fields = doc.toJS({ mapAsMap: true }) as Map<unknown, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return raw(text, fallbackName, `frontmatter 无法读取：${message}`);
  }

  return {
    name: textField(fields.get('name')) || fallbackName,
    description: textField(fields.get('description')),
    body,
  };
}
