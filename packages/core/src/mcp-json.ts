import type { ServerInput } from '@agentport/shared';
import { mcpJsonEntrySchema, serverInputSchema, slugSchema } from '@agentport/shared';
import type { z } from 'zod';
import { invalidInput } from './errors.js';
import { isRecord } from './record.js';

const MCP_JSON_MAX_BYTES = 1_048_576;
const MCP_JSON_MAX_SERVERS = 100;

const ENTRY_FIELDS = new Set(['type', 'command', 'args', 'env', 'url', 'headers']);

function fieldPath(path: PropertyKey[]): string {
  const parts: string[] = [];
  for (const segment of path) {
    if (typeof segment === 'number') parts.push(`[${segment}]`);
    else if (typeof segment === 'string' && ENTRY_FIELDS.has(segment)) parts.push(segment);
  }
  return parts.join('.') || '条目';
}

function safeNames(keys: string[]): string {
  const names = keys.filter((key) => /^[\w.-]{1,64}$/.test(key));
  return names.length > 0 ? names.join('、') : '（已省略）';
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const field = fieldPath(issue.path);
  switch (issue.code) {
    case 'unrecognized_keys':
      return `${field} 含未知字段：${safeNames(issue.keys)}`;
    case 'invalid_type':
    case 'invalid_value':
      return `${field} 类型或取值不合法`;
    case 'invalid_format':
      return `${field} 格式不合法`;
    case 'too_small':
    case 'too_big':
      return `${field} 长度不合法`;
    case 'invalid_key':
      return `${field} 的键名不合法`;
    case 'custom':
      return `${field}：${issue.message}`;
    default:
      return `${field} 不合法`;
  }
}

function parseEntry(name: string, entry: Record<string, unknown>): ServerInput {
  if (!slugSchema.safeParse(name).success) {
    invalidInput('Server 名称只能是 1-64 位小写字母、数字、- 或 _', 'mcpJson');
  }

  const type = entry.type;
  if (type !== undefined && type !== 'stdio' && type !== 'http' && type !== 'streamable-http') {
    invalidInput('type 仅支持 http / streamable-http；stdio 条目省略 type', 'mcpJson');
  }

  const parsed = mcpJsonEntrySchema.safeParse(entry);
  if (!parsed.success) {
    invalidInput(
      `「${name}」配置不合法：${parsed.error.issues.map(describeIssue).join('；')}`,
      'mcpJson',
    );
  }

  const input = serverInputSchema.safeParse({
    ...parsed.data,
    name,
    kind: parsed.data.type === 'stdio' ? 'stdio' : 'http',
    description: '',
  });
  if (!input.success) invalidInput(`「${name}」配置不完整`, 'mcpJson');

  return input.data;
}

export function parseMcpJson(text: string): ServerInput[] {
  if (Buffer.byteLength(text, 'utf8') > MCP_JSON_MAX_BYTES) {
    invalidInput('文件超过 1 MiB 上限', 'mcpJson');
  }
  const body = text.startsWith('﻿') ? text.slice(1) : text;

  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    invalidInput('不是合法的 JSON', 'mcpJson');
  }

  if (!isRecord(root)) invalidInput('顶层必须是对象', 'mcpJson');
  const unknownRoot = Object.keys(root).filter((key) => key !== 'mcpServers');
  if (unknownRoot.length > 0) invalidInput(`顶层含未知字段：${safeNames(unknownRoot)}`, 'mcpJson');
  if (!isRecord(root.mcpServers)) invalidInput('缺少 mcpServers 对象', 'mcpJson');

  const entries = Object.entries(root.mcpServers);
  if (entries.length === 0) invalidInput('mcpServers 至少需要一个 Server', 'mcpJson');
  if (entries.length > MCP_JSON_MAX_SERVERS) {
    invalidInput(`mcpServers 最多 ${MCP_JSON_MAX_SERVERS} 个 Server`, 'mcpJson');
  }

  return entries.map(([name, entry]) => {
    if (!isRecord(entry)) invalidInput('Server 条目必须是对象', 'mcpJson');
    return parseEntry(name, entry);
  });
}
