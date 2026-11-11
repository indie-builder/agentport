import { AGENT_WORKFLOW_CONTENT_MAX, agentWorkflowInputSchema } from '@agentport/shared';
import { fail } from './errors.js';

function invalid(message: string, path = '/workflow'): never {
  fail('INVALID_INPUT', message, { path });
}

function skipTrivia(text: string, start: number): number {
  let index = start;
  for (;;) {
    while (index < text.length && /\s/.test(text[index] ?? '')) index++;
    if (text.startsWith('//', index)) {
      const end = text.indexOf('\n', index);
      if (end === -1) return text.length;
      index = end;
      continue;
    }
    if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      if (end === -1) invalid('注释未闭合');
      index = end + 2;
      continue;
    }
    return index;
  }
}

function readString(text: string, start: number): { value: string; next: number } {
  const quote = text[start];
  if (quote !== '"' && quote !== "'" && quote !== '`') {
    invalid('meta 的字段值必须是字符串字面量');
  }
  let value = '';
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === quote) return { value, next: index + 1 };
    if (quote === '`' && char === '$' && text[index + 1] === '{') {
      invalid('meta 不支持模板插值');
    }
    if (char !== '\\') {
      value += char;
      index++;
      continue;
    }
    const escaped = text[index + 1];
    if (escaped === undefined) break;
    if (escaped === 'n') value += '\n';
    else if (escaped === 'r') value += '\r';
    else if (escaped === 't') value += '\t';
    else if (escaped === 'b') value += '\b';
    else if (escaped === 'f') value += '\f';
    else if (escaped === 'v') value += '\v';
    else if (escaped === '0') value += '\0';
    else if (escaped === '\n') {
      index += 2;
      continue;
    } else if (escaped === 'u' || escaped === 'x') {
      const unicode = escaped === 'u';
      let cursor = index + 2;
      let hex: string;
      if (unicode && text[cursor] === '{') {
        const close = text.indexOf('}', cursor + 1);
        if (close === -1) invalid('Unicode 转义未闭合');
        hex = text.slice(cursor + 1, close);
        cursor = close + 1;
      } else {
        const length = unicode ? 4 : 2;
        hex = text.slice(cursor, cursor + length);
        cursor += length;
      }
      const braced = unicode && text[index + 2] === '{';
      const pattern = unicode
        ? braced
          ? /^[0-9a-fA-F]{1,6}$/
          : /^[0-9a-fA-F]{4}$/
        : /^[0-9a-fA-F]{2}$/;
      if (!pattern.test(hex)) invalid('Unicode 转义不合法');
      let codePoint = Number.parseInt(hex, 16);
      if (unicode && !braced && codePoint >= 0xd800 && codePoint <= 0xdbff) {
        const lowHex =
          text.slice(cursor, cursor + 2) === '\\u' ? text.slice(cursor + 2, cursor + 6) : '';
        if (!/^[0-9a-fA-F]{4}$/.test(lowHex)) invalid('Unicode 转义不在合法码点范围');
        const low = Number.parseInt(lowHex, 16);
        if (low < 0xdc00 || low > 0xdfff) invalid('Unicode 转义不在合法码点范围');
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
        cursor += 6;
      } else if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        invalid('Unicode 转义不在合法码点范围');
      }
      value += String.fromCodePoint(codePoint);
      index = cursor;
      continue;
    } else value += escaped;
    index += 2;
  }
  return invalid('字符串字面量未闭合');
}

const MAX_LITERAL_DEPTH = 64;

/** 读取一个纯字面量；只有字符串返回值，数组、对象、数字、布尔与 null 仅校验合法性。 */
function readLiteral(
  text: string,
  start: number,
  depth = 0,
): { value: string | null; next: number } {
  if (depth > MAX_LITERAL_DEPTH) invalid('meta 字面量嵌套过深');
  const char = text[start];
  if (char === '"' || char === "'" || char === '`') {
    const read = readString(text, start);
    return { value: read.value, next: read.next };
  }
  if (char === '[') {
    let index = start + 1;
    for (;;) {
      index = skipTrivia(text, index);
      if (text[index] === ']') return { value: null, next: index + 1 };
      index = readLiteral(text, index, depth + 1).next;
      index = skipTrivia(text, index);
      if (text[index] === ',') {
        index++;
        continue;
      }
      if (text[index] === ']') return { value: null, next: index + 1 };
      invalid('meta 的数组元素必须是纯字面量');
    }
  }
  if (char === '{') {
    let index = start + 1;
    for (;;) {
      index = skipTrivia(text, index);
      if (text[index] === '}') return { value: null, next: index + 1 };
      if (text[index] === '"' || text[index] === "'") {
        index = readString(text, index).next;
      } else {
        const key = /^[A-Za-z_$][\w$]*/.exec(text.slice(index));
        if (!key) invalid('meta 的对象键必须是标识符或字符串字面量');
        index += key[0].length;
      }
      index = skipTrivia(text, index);
      if (text[index] !== ':') invalid('meta 的对象字段缺少冒号');
      index = skipTrivia(text, index + 1);
      index = readLiteral(text, index, depth + 1).next;
      index = skipTrivia(text, index);
      if (text[index] === ',') {
        index++;
        continue;
      }
      if (text[index] === '}') return { value: null, next: index + 1 };
      invalid('meta 的对象字段必须是纯字面量');
    }
  }
  const scalar = /^(?:true|false|null)(?![A-Za-z0-9_$])/.exec(text.slice(start));
  if (scalar) return { value: null, next: start + scalar[0].length };
  const number =
    /^-?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?![A-Za-z0-9_$])/.exec(
      text.slice(start),
    );
  if (number) return { value: null, next: start + number[0].length };
  return invalid('meta 只支持字符串、数字、布尔、null 及其数组/对象字面量');
}

/**
 * 静态解析官方工作流脚本的首条语句 `export const meta = <对象字面量>`。
 * 只取 name/description 字符串，其余字段校验为纯字面量后忽略；不执行脚本。
 */
export function parseWorkflowMeta(content: string): { name: string; description: string } {
  const text = content.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (text.length > AGENT_WORKFLOW_CONTENT_MAX) {
    invalid(`工作流脚本不能超过 ${AGENT_WORKFLOW_CONTENT_MAX} 个字符`);
  }
  let index = skipTrivia(text, 0);
  const header = /^export\s+const\s+meta\s*=\s*\{/.exec(text.slice(index));
  if (!header) {
    invalid('工作流脚本的第一条语句必须是 `export const meta = { name, description, ... }`');
  }
  index += header[0].length;

  const fields = new Map<string, string>();
  const seen = new Set<string>();
  for (;;) {
    index = skipTrivia(text, index);
    if (text[index] === '}') {
      index++;
      break;
    }
    let key: string;
    if (text[index] === '"' || text[index] === "'") {
      const read = readString(text, index);
      key = read.value;
      index = read.next;
    } else {
      const match = /^[A-Za-z_$][\w$]*/.exec(text.slice(index));
      if (!match) invalid('meta 只能包含字面量字段');
      key = match[0];
      index += key.length;
    }
    if (seen.has(key)) invalid(`meta 的 ${key} 重复`);
    seen.add(key);
    index = skipTrivia(text, index);
    if (text[index] !== ':') invalid(`meta 的 ${key} 缺少冒号`);
    index = skipTrivia(text, index + 1);
    const literal = readLiteral(text, index);
    index = literal.next;
    if (key === 'name' || key === 'description') {
      if (literal.value === null) {
        invalid(`meta 的 ${key} 必须是字符串字面量`, `/workflow/${key}`);
      }
      fields.set(key, literal.value);
    }
    index = skipTrivia(text, index);
    if (text[index] === ',') {
      index++;
      continue;
    }
    if (text[index] === '}') {
      index++;
      break;
    }
    invalid('meta 只能包含字面量字段');
  }

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
