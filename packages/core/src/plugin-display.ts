import { errorText } from '@agentport/shared';
import { parseYamlFrontmatter } from './markdown-frontmatter.js';

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

export function readPluginMarkdown(content: string, fallbackName: string): PluginMarkdown {
  const parsed = parseYamlFrontmatter(content);
  switch (parsed.kind) {
    case 'missingOpen':
      return raw(parsed.text, fallbackName);
    case 'missingClose':
      return raw(parsed.text, fallbackName, 'frontmatter 缺少闭合的 ---');
    case 'invalidYaml':
      return raw(parsed.text, fallbackName, `frontmatter 不是合法 YAML：${parsed.message}`);
    case 'notMap':
      return raw(parsed.text, fallbackName, 'frontmatter 必须是 YAML 映射');
    case 'hasAnchor':
      return raw(parsed.text, fallbackName, 'frontmatter 不支持 YAML 锚点或别名');
    case 'toJsError':
      return raw(parsed.text, fallbackName, `frontmatter 无法读取：${errorText(parsed.error)}`);
    case 'ok':
      return {
        name: textField(parsed.fields.get('name')) || fallbackName,
        description: textField(parsed.fields.get('description')),
        body: parsed.body,
      };
  }
}
