import { errorText } from '@agentport/shared';
import { isMap, parseDocument } from 'yaml';
import { splitFrontmatter, stripBom } from './frontmatter-scan.js';

interface PluginMarkdown {
  name: string;
  description: string;
  body: string;
  issue?: string;
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
  const text = stripBom(content);
  const scanned = splitFrontmatter(text);
  if (scanned.kind === 'missingOpen') return raw(text, fallbackName);
  if (scanned.kind === 'missingClose') {
    return raw(text, fallbackName, 'frontmatter 缺少闭合的 ---');
  }
  const { frontmatter, body } = scanned;

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
    const message = errorText(error);
    return raw(text, fallbackName, `frontmatter 无法读取：${message}`);
  }

  return {
    name: textField(fields.get('name')) || fallbackName,
    description: textField(fields.get('description')),
    body,
  };
}
