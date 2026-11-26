import { AGENT_WORKFLOW_CONTENT_MAX, agentWorkflowInputSchema } from '@agentport/shared';
import {
  type Expression,
  type ObjectExpression,
  parseExpressionAt,
  type SpreadElement,
  tokenizer,
  tokTypes,
} from 'acorn';
import { invalidInput } from './errors.js';
import { stripBom } from './frontmatter-scan.js';

const MAX_LITERAL_DEPTH = 64;

function parseMetaObject(text: string): ObjectExpression {
  const options = { ecmaVersion: 'latest', sourceType: 'module', preserveParens: true } as const;
  try {
    const tokens = tokenizer(text, options);
    const header = [tokTypes._export, tokTypes._const, tokTypes.name, tokTypes.eq, tokTypes.braceL];
    const start = header.map(() => tokens.getToken());
    const name = start[2];
    const object = start[4];
    if (
      !name ||
      !object ||
      start.some((token, index) => token.type !== header[index]) ||
      text.slice(name.start, name.end) !== 'meta'
    ) {
      invalidInput(
        '工作流脚本的第一条语句必须是 `export const meta = { name, description, ... }`',
        '/workflow',
      );
    }

    const meta = parseExpressionAt(text, object.start, options);
    if (meta.type !== 'ObjectExpression') invalidInput('meta 只能包含字面量字段', '/workflow');
    const next = tokenizer(text.slice(meta.end), options).getToken();
    if (
      next.type !== tokTypes.semi &&
      next.type !== tokTypes.eof &&
      !/[\n\r\u2028\u2029]/.test(text.slice(meta.end, meta.end + next.start))
    ) {
      invalidInput('meta 声明未结束', '/workflow');
    }
    return meta;
  } catch (error) {
    if (error instanceof SyntaxError) invalidInput('工作流脚本的 meta 语法不合法', '/workflow');
    if (error instanceof RangeError) invalidInput('meta 字面量嵌套过深', '/workflow');
    throw error;
  }
}

function readLiteral(node: Expression | SpreadElement | null, depth: number): string | undefined {
  if (depth > MAX_LITERAL_DEPTH) invalidInput('meta 字面量嵌套过深', '/workflow');
  switch (node?.type) {
    case 'Literal':
      if (typeof node.value === 'string') return node.value;
      if (
        node.value === null ||
        typeof node.value === 'number' ||
        typeof node.value === 'boolean'
      ) {
        return undefined;
      }
      break;
    case 'TemplateLiteral':
      if (node.expressions.length > 0) invalidInput('meta 不支持模板插值', '/workflow');
      return (
        node.quasis[0]?.value.cooked ?? invalidInput('meta 的字符串字面量转义不合法', '/workflow')
      );
    case 'UnaryExpression':
      if (
        (node.operator === '+' || node.operator === '-') &&
        node.argument.type === 'Literal' &&
        typeof node.argument.value === 'number'
      ) {
        return undefined;
      }
      break;
    case 'ArrayExpression':
      for (const item of node.elements) readLiteral(item, depth + 1);
      return undefined;
    case 'ObjectExpression':
      readFields(node, depth + 1);
      return undefined;
  }
  return invalidInput('meta 只支持字符串、数字、布尔、null 及其数组/对象字面量', '/workflow');
}

function readFields(node: ObjectExpression, depth: number) {
  const fields = new Map<string, string | undefined>();
  for (const property of node.properties) {
    if (
      property.type !== 'Property' ||
      property.kind !== 'init' ||
      property.computed ||
      property.method ||
      property.shorthand
    ) {
      invalidInput('meta 只能包含字面量字段', '/workflow');
    }
    const { key } = property;
    const name = key.type === 'Identifier' ? key.name : key.type === 'Literal' ? key.value : null;
    if (typeof name !== 'string')
      invalidInput('meta 的对象键必须是标识符或字符串字面量', '/workflow');
    if (fields.has(name)) invalidInput(`meta 的 ${name} 重复`, '/workflow');
    const value = readLiteral(property.value, depth);
    if (depth === 0 && (name === 'name' || name === 'description') && value === undefined) {
      invalidInput(`meta 的 ${name} 必须是字符串字面量`, `/workflow/${name}`);
    }
    fields.set(name, value);
  }
  return fields;
}

export function parseWorkflowMeta(content: string): { name: string; description: string } {
  const text = stripBom(content).replace(/\r\n/g, '\n');
  if (text.length > AGENT_WORKFLOW_CONTENT_MAX) {
    invalidInput(`工作流脚本不能超过 ${AGENT_WORKFLOW_CONTENT_MAX} 个字符`, '/workflow');
  }

  const fields = readFields(parseMetaObject(text), 0);
  const name = fields.get('name');
  const description = fields.get('description');
  if (name === undefined) invalidInput('meta 缺少 name', '/workflow/name');
  if (description === undefined) invalidInput('meta 缺少 description', '/workflow/description');
  const parsed = agentWorkflowInputSchema.safeParse({
    slug: 'workflow',
    name,
    description,
    content: text,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = String(issue?.path[0] ?? 'name');
    invalidInput(`meta 的 ${field} 无效：${issue?.message ?? '字段不合法'}`, `/workflow/${field}`);
  }
  return { name: parsed.data.name, description: parsed.data.description };
}
