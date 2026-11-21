import type { ServerInput } from '@agentport/shared';
import { httpUrlSchema, serverInputSchema, slugSchema } from '@agentport/shared';
import { z } from 'zod';
import { fail } from './errors.js';
import { isRecord } from './record.js';

const MCP_JSON_MAX_BYTES = 1_048_576;
const MCP_JSON_MAX_SERVERS = 100;

/** 入口即拒绝 `${...}`：SDK 可能展开模板，导入的配置不能把展开时机留到运行时。 */
const plainString = z.string().refine((value) => !value.includes('${'), '不支持模板占位符');

const stdioEntrySchema = z.strictObject({
  type: z.literal('stdio').optional(),
  command: plainString.min(1),
  args: z.array(plainString).default([]),
  env: z.record(plainString, plainString).default({}),
});

const httpUrl = httpUrlSchema.refine((value) => !value.includes('${'), '不支持模板占位符');

const httpEntrySchema = z.strictObject({
  type: z.enum(['http', 'streamable-http']),
  url: httpUrl,
  headers: z.record(plainString, plainString).default({}),
});

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

function invalid(message: string): never {
  fail('INVALID_INPUT', message, { path: 'mcpJson' });
}

function parseEntry(name: string, entry: Record<string, unknown>): ServerInput {
  if (!slugSchema.safeParse(name).success) {
    invalid('Server 名称只能是 1-64 位小写字母、数字、- 或 _');
  }

  const type = entry.type;
  const schema =
    type === undefined || type === 'stdio'
      ? stdioEntrySchema
      : type === 'http' || type === 'streamable-http'
        ? httpEntrySchema
        : null;
  if (!schema) invalid('type 仅支持 http / streamable-http；stdio 条目省略 type');

  const parsed = schema.safeParse(entry);
  if (!parsed.success) {
    invalid(`「${name}」配置不合法：${parsed.error.issues.map(describeIssue).join('；')}`);
  }

  const input = serverInputSchema.safeParse({
    ...parsed.data,
    name,
    kind: parsed.data.type === undefined || parsed.data.type === 'stdio' ? 'stdio' : 'http',
    description: '',
  });
  if (!input.success) invalid(`「${name}」配置不完整`);

  return input.data;
}

/**
 * 解析 Claude Code `.mcp.json`，只接受平台能安全落盘的子集。
 * 值一律不进错误消息：文件里包含密钥，报错会进日志与响应。
 */
export function parseMcpJson(text: string): ServerInput[] {
  if (Buffer.byteLength(text, 'utf8') > MCP_JSON_MAX_BYTES) {
    invalid('文件超过 1 MiB 上限');
  }
  const body = text.startsWith('﻿') ? text.slice(1) : text;

  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    invalid('不是合法的 JSON');
  }

  if (!isRecord(root)) invalid('顶层必须是对象');
  const unknownRoot = Object.keys(root).filter((key) => key !== 'mcpServers');
  if (unknownRoot.length > 0) invalid(`顶层含未知字段：${safeNames(unknownRoot)}`);
  if (!isRecord(root.mcpServers)) invalid('缺少 mcpServers 对象');

  const entries = Object.entries(root.mcpServers);
  if (entries.length === 0) invalid('mcpServers 至少需要一个 Server');
  if (entries.length > MCP_JSON_MAX_SERVERS) {
    invalid(`mcpServers 最多 ${MCP_JSON_MAX_SERVERS} 个 Server`);
  }

  return entries.map(([name, entry]) => {
    if (!isRecord(entry)) invalid('Server 条目必须是对象');
    return parseEntry(name, entry);
  });
}
