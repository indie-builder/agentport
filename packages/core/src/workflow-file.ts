import { AGENT_WORKFLOW_CONTENT_MAX, agentWorkflowInputSchema } from '@agentport/shared';
import {
  type Expression,
  type ObjectExpression,
  parseExpressionAt,
  type SpreadElement,
  tokenizer,
  tokTypes,
} from 'acorn';
import { fail } from './errors.js';

const MAX_LITERAL_DEPTH = 64;

function invalid(message: string, path = '/workflow'): never {
  fail('INVALID_INPUT', message, { path });
}

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
      invalid('工作流脚本的第一条语句必须是 `export const meta = { name, description, ... }`');
    }

    const meta = parseExpressionAt(text, object.start, options);
    if (meta.type !== 'ObjectExpression') invalid('meta 只能包含字面量字段');
    const next = tokenizer(text.slice(meta.end), options).getToken();
    if (
      next.type !== tokTypes.semi &&
      next.type !== tokTypes.eof &&
      !/[\n\r\u2028\u2029]/.test(text.slice(meta.end, meta.end + next.start))
    ) {
      invalid('meta 声明未结束');
    }
    return meta;
  } catch (error) {
    if (error instanceof SyntaxError) invalid('工作流脚本的 meta 语法不合法');
    if (error instanceof RangeError) invalid('meta 字面量嵌套过深');
    throw error;
  }
}

function readLiteral(node: Expression | SpreadElement | null, depth: number): string | undefined {
  if (depth > MAX_LITERAL_DEPTH) invalid('meta 字面量嵌套过深');
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
      if (node.expressions.length > 0) invalid('meta 不支持模板插值');
      return node.quasis[0]?.value.cooked ?? invalid('meta 的字符串字面量转义不合法');
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
  return invalid('meta 只支持字符串、数字、布尔、null 及其数组/对象字面量');
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
      invalid('meta 只能包含字面量字段');
    }
    const { key } = property;
    const name = key.type === 'Identifier' ? key.name : key.type === 'Literal' ? key.value : null;
    if (typeof name !== 'string') invalid('meta 的对象键必须是标识符或字符串字面量');
    if (fields.has(name)) invalid(`meta 的 ${name} 重复`);
    const value = readLiteral(property.value, depth);
    if (depth === 0 && (name === 'name' || name === 'description') && value === undefined) {
      invalid(`meta 的 ${name} 必须是字符串字面量`, `/workflow/${name}`);
    }
    fields.set(name, value);
  }
  return fields;
}

export function parseWorkflowMeta(content: string): { name: string; description: string } {
  const text = content.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (text.length > AGENT_WORKFLOW_CONTENT_MAX) {
    invalid(`工作流脚本不能超过 ${AGENT_WORKFLOW_CONTENT_MAX} 个字符`);
  }

  const fields = readFields(parseMetaObject(text), 0);
  const name = fields.get('name');
  const description = fields.get('description');
  if (name === undefined) invalid('meta 缺少 name', '/workflow/name');
  if (description === undefined) invalid('meta 缺少 description', '/workflow/description');
  const parsed = agentWorkflowInputSchema.safeParse({
    slug: 'workflow',
    name,
    description,
    content: text,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = String(issue?.path[0] ?? 'name');
    invalid(`meta 的 ${field} 无效：${issue?.message ?? '字段不合法'}`, `/workflow/${field}`);
  }
  return { name: parsed.data.name, description: parsed.data.description };
}
