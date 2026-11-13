import { slugSchema } from '@agentport/shared';
import { parse as parseYaml } from 'yaml';
import { fail } from './errors.js';
import { isRecord } from './record.js';

export interface ImportedHttpTool {
  name: string;
  description: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  pathTemplate: string;
  inputSchema: Record<string, unknown>;
  /** 响应结构的 JSON Schema；MCP outputSchema 要求 object 根，缺失或非 object 时为 undefined。 */
  outputSchema?: Record<string, unknown> | null | undefined;
  paramsIn: 'query' | 'body';
  approvalMode: 'allow' | 'ask' | 'deny';
}

export interface ParsedOpenApi {
  tools: ImportedHttpTool[];
  warnings: string[];
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

const MAX_OPERATIONS = 200;
const MAX_REF_DEPTH = 32;
const MAX_SCHEMA_DEPTH = 32;
const MAX_ALL_OF_BRANCHES = 256;
const MAX_DESCRIPTION = 1000;
const MAX_NAME = 64;

interface Ctx {
  root: Record<string, unknown>;
  warnings: string[];
}

function invalid(message: string): never {
  fail('INVALID_INPUT', message, { path: 'openapi' });
}

function parseDocument(text: string): Record<string, unknown> {
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    try {
      root = parseYaml(body);
    } catch {
      invalid('无法解析 OpenAPI 文档：不是合法的 JSON 或 YAML');
    }
  }
  if (!isRecord(root)) invalid('OpenAPI 文档顶层必须是对象');
  return root;
}

function assertSupportedVersion(root: Record<string, unknown>): boolean {
  const openapi = root.openapi;
  if (typeof openapi === 'string' && openapi.startsWith('3.')) return true;
  if (root.swagger === '2.0') return false;
  invalid('仅支持 OpenAPI 3.x 或 Swagger 2.0 文档');
}

function resolvePointer(root: unknown, ref: string): unknown {
  let current: unknown = root;
  for (const segment of ref.slice(2).split('/')) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else if (isRecord(current) && Object.hasOwn(current, key)) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}

function resolveNode(node: unknown, ctx: Ctx, label: string): Record<string, unknown> | undefined {
  let current = node;
  const seen = new Set<string>();
  for (let depth = 0; ; depth += 1) {
    if (!isRecord(current)) return undefined;
    const ref = current.$ref;
    if (typeof ref !== 'string') return current;
    if (!ref.startsWith('#/')) {
      ctx.warnings.push(`${label}引用了外部 $ref（${ref}），已跳过`);
      return undefined;
    }
    if (seen.has(ref) || depth >= MAX_REF_DEPTH) {
      ctx.warnings.push(`${label}的 $ref 存在循环或层级过深（${ref}），已跳过`);
      return undefined;
    }
    seen.add(ref);
    const target = resolvePointer(ctx.root, ref);
    if (target === undefined) {
      ctx.warnings.push(`${label}的 $ref 无法解析（${ref}），已跳过`);
      return undefined;
    }
    current = target;
  }
}

function convertSchema(
  node: unknown,
  ctx: Ctx,
  label: string,
  refStack: Set<string>,
  depth: number,
): Record<string, unknown> | undefined {
  if (depth > MAX_SCHEMA_DEPTH) {
    ctx.warnings.push(`${label}的 schema 嵌套过深，已省略`);
    return undefined;
  }
  if (!isRecord(node)) return undefined;

  const ref = node.$ref;
  if (typeof ref === 'string') {
    if (!ref.startsWith('#/')) {
      ctx.warnings.push(`${label}引用了外部 $ref（${ref}），已跳过`);
      return undefined;
    }
    if (refStack.has(ref)) {
      ctx.warnings.push(`${label}的 $ref 存在循环（${ref}），已跳过`);
      return undefined;
    }
    const target = resolvePointer(ctx.root, ref);
    if (target === undefined) {
      ctx.warnings.push(`${label}的 $ref 无法解析（${ref}），已跳过`);
      return undefined;
    }
    refStack.add(ref);
    const converted = convertSchema(target, ctx, label, refStack, depth + 1);
    refStack.delete(ref);
    return converted;
  }

  const out: Record<string, unknown> = {};
  if (typeof node.type === 'string') out.type = node.type;
  else if (Array.isArray(node.type) && node.type.every((item) => typeof item === 'string')) {
    out.type = node.type;
  }
  if (typeof node.format === 'string') out.format = node.format;
  if (typeof node.description === 'string') out.description = node.description;
  if (Array.isArray(node.enum)) out.enum = node.enum;
  if (Object.hasOwn(node, 'default')) out.default = node.default;
  if (typeof node.nullable === 'boolean') out.nullable = node.nullable;
  if (Array.isArray(node.required)) {
    const required = node.required.filter((item): item is string => typeof item === 'string');
    if (required.length > 0) out.required = required;
  }
  if (isRecord(node.properties)) {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.properties)) {
      const converted = convertSchema(value, ctx, `${label}.${key}`, refStack, depth + 1);
      if (converted) properties[key] = converted;
    }
    out.properties = properties;
  }
  const items = node.items;
  if (isRecord(items)) {
    const converted = convertSchema(items, ctx, `${label}[]`, refStack, depth + 1);
    if (converted) out.items = converted;
  } else if (Array.isArray(items)) {
    const converted: Record<string, unknown>[] = [];
    for (const item of items) {
      const entry = convertSchema(item, ctx, `${label}[]`, refStack, depth + 1);
      if (entry) converted.push(entry);
    }
    out.items = converted;
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    const subschemas = node[keyword];
    if (!Array.isArray(subschemas)) continue;
    const converted: Record<string, unknown>[] = [];
    for (const item of subschemas) {
      const entry = convertSchema(item, ctx, `${label}.${keyword}`, refStack, depth + 1);
      if (entry) converted.push(entry);
    }
    out[keyword] = converted;
  }
  if (isRecord(node.not)) {
    const converted = convertSchema(node.not, ctx, `${label}.not`, refStack, depth + 1);
    if (converted) out.not = converted;
  }
  const additional = node.additionalProperties;
  if (typeof additional === 'boolean') {
    out.additionalProperties = additional;
  } else if (isRecord(additional)) {
    const converted = convertSchema(
      additional,
      ctx,
      `${label}.additionalProperties`,
      refStack,
      depth + 1,
    );
    if (converted) out.additionalProperties = converted;
  }
  return out;
}

function parameterSchema(
  parameter: Record<string, unknown>,
  ctx: Ctx,
  label: string,
  openapi3: boolean,
): Record<string, unknown> {
  const source = openapi3 ? parameter.schema : parameter;
  const converted = convertSchema(source, ctx, label, new Set(), 0) ?? { type: 'string' };
  if (typeof parameter.description === 'string' && typeof converted.description !== 'string') {
    converted.description = parameter.description;
  }
  return converted;
}

function bodyObjectSchema(
  node: unknown,
  ctx: Ctx,
  label: string,
  bodyRequired: boolean,
): { properties: Record<string, unknown>; required: string[] } | undefined {
  const schema = resolveNode(node, ctx, label);
  if (!schema) return undefined;
  const rootRef = isRecord(node) && typeof node.$ref === 'string' ? node.$ref : undefined;
  const sources: Record<string, unknown>[] = [];
  const pending: { node: unknown; depth: number; refs: Set<string> }[] = [
    { node: schema, depth: 0, refs: rootRef ? new Set([rootRef]) : new Set() },
  ];
  let expanded = 0;
  while (pending.length > 0) {
    const entry = pending.shift();
    if (!entry) break;
    const { node: next, depth, refs } = entry;
    const ref = isRecord(next) && typeof next.$ref === 'string' ? next.$ref : undefined;
    if (
      depth > MAX_SCHEMA_DEPTH ||
      (ref !== undefined && refs.has(ref)) ||
      expanded >= MAX_ALL_OF_BRANCHES
    ) {
      ctx.warnings.push(`${label}存在循环或层级过深的 allOf，已跳过其余分支`);
      break;
    }
    expanded += 1;
    const resolved = resolveNode(next, ctx, label);
    if (!resolved) continue;
    if (resolved.anyOf !== undefined || resolved.oneOf !== undefined) {
      ctx.warnings.push(`${label}包含 anyOf/oneOf 组合，无法可靠展开，未生成 body 参数`);
      return undefined;
    }
    if (sources.includes(resolved)) continue;
    sources.push(resolved);
    if (Array.isArray(resolved.allOf)) {
      const path = ref === undefined ? refs : new Set(refs).add(ref);
      for (const branch of resolved.allOf) {
        pending.push({ node: branch, depth: depth + 1, refs: path });
      }
    }
  }
  const hasProperties = sources.some((source) => isRecord(source.properties));
  if (!hasProperties && schema.type !== 'object') {
    ctx.warnings.push(`${label}不是 object，未生成 body 参数`);
    return undefined;
  }
  const converted: Record<string, unknown> = {};
  const required: string[] = [];
  for (const source of sources) {
    if (isRecord(source.properties)) {
      for (const [key, value] of Object.entries(source.properties)) {
        const entry = convertSchema(value, ctx, `${label}.${key}`, new Set(), 0);
        if (!entry) continue;
        const previous = converted[key];
        if (isRecord(previous)) {
          converted[key] = { ...previous, ...entry };
          ctx.warnings.push(
            `请求体属性「${key}」在多个 allOf 分支中重复，已合并（后者覆盖同名键）`,
          );
        } else {
          converted[key] = entry;
        }
      }
    }
    if (Array.isArray(source.required)) {
      for (const item of source.required) {
        if (typeof item === 'string') required.push(item);
      }
    }
  }
  return { properties: converted, required: bodyRequired ? required : [] };
}

function requestBodySchema(
  operation: Record<string, unknown>,
  ctx: Ctx,
  label: string,
): { schema: unknown; required: boolean } | undefined {
  const resolved = resolveNode(operation.requestBody, ctx, `${label}的请求体`);
  if (!resolved) return undefined;
  const content = resolved.content;
  if (!isRecord(content) || !Object.hasOwn(content, 'application/json')) {
    ctx.warnings.push(`${label}缺少 application/json 请求体，未生成 body 参数`);
    return undefined;
  }
  const media = content['application/json'];
  if (!isRecord(media) || media.schema === undefined) {
    ctx.warnings.push(`${label}的 application/json 请求体缺少 schema，未生成 body 参数`);
    return undefined;
  }
  return { schema: media.schema, required: resolved.required === true };
}

/** MCP outputSchema 只接受 object 根；组合类型要求每个分支都是 object 根。 */
function isObjectRoot(schema: Record<string, unknown>): boolean {
  if (schema.type === 'object' || isRecord(schema.properties)) return true;
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) {
      return (
        branches.length > 0 && branches.every((branch) => isRecord(branch) && isObjectRoot(branch))
      );
    }
  }
  return false;
}

/** 取成功响应的 JSON Schema；MCP outputSchema 只接受 object 根，其余按未声明处理。 */
function responseSchema(
  operation: Record<string, unknown>,
  ctx: Ctx,
  label: string,
  openapi3: boolean,
): Record<string, unknown> | undefined {
  const responses = resolveNode(operation.responses, ctx, `${label}的响应`);
  if (!responses) return undefined;
  let status: string | undefined;
  if (openapi3) {
    status = ['200', '201'].find((key) => Object.hasOwn(responses, key));
    status ??= Object.keys(responses).find((key) => /^2\d\d$/.test(key));
    status ??= Object.hasOwn(responses, 'default') ? 'default' : undefined;
  } else if (Object.hasOwn(responses, '200')) {
    status = '200';
  }
  if (!status) return undefined;
  const response = resolveNode(responses[status], ctx, `${label}的响应`);
  if (!response) return undefined;
  let source: unknown;
  if (openapi3) {
    const media = isRecord(response.content) ? response.content['application/json'] : undefined;
    source = isRecord(media) ? media.schema : undefined;
  } else {
    source = response.schema;
  }
  if (source === undefined) return undefined;
  const converted = convertSchema(source, ctx, `${label}的响应`, new Set(), 0);
  if (!converted) return undefined;
  return isObjectRoot(converted) ? converted : undefined;
}

function readParameters(value: unknown, ctx: Ctx, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const result: Record<string, unknown>[] = [];
  for (const entry of value) {
    const resolved = resolveNode(entry, ctx, `${label}的参数`);
    if (resolved) result.push(resolved);
  }
  return result;
}

function slugify(source: string): string {
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[-_]+/, '');
  const candidate = slug.slice(0, MAX_NAME).replace(/[-_]+$/, '') || 'tool';
  const parsed = slugSchema.safeParse(candidate);
  return parsed.success ? parsed.data : 'tool';
}

function uniqueName(base: string, used: Set<string>, warnings: string[]): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let index = 2; ; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, MAX_NAME - suffix.length).replace(/[-_]+$/, '')}${suffix}`;
    if (used.has(candidate)) continue;
    used.add(candidate);
    warnings.push(`工具名「${base}」重复，已改为「${candidate}」`);
    return candidate;
  }
}

function textField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function buildTool(
  path: string,
  method: HttpMethod,
  operation: Record<string, unknown>,
  itemParameters: Record<string, unknown>[],
  ctx: Ctx,
  used: Set<string>,
  openapi3: boolean,
): ImportedHttpTool | undefined {
  const upper = method.toUpperCase() as ImportedHttpTool['method'];
  const operationId = typeof operation.operationId === 'string' ? operation.operationId : '';
  const name = uniqueName(slugify(operationId || `${method}_${path}`), used, ctx.warnings);
  const label = `工具「${name}」`;
  const operationParameters = readParameters(operation.parameters, ctx, label);
  const merged = new Map<string, Record<string, unknown>>();
  for (const parameter of [...itemParameters, ...operationParameters]) {
    const location = parameter.in;
    const paramName = parameter.name;
    if (typeof location !== 'string' || typeof paramName !== 'string') continue;
    merged.set(`${location}:${paramName}`, parameter);
  }

  const pathProperties: Record<string, unknown> = {};
  const payloadProperties: Record<string, unknown> = {};
  const required: string[] = [];
  let bodyParameter: Record<string, unknown> | undefined;

  for (const parameter of merged.values()) {
    const location = parameter.in;
    const paramName = typeof parameter.name === 'string' ? parameter.name : '';
    if (!paramName) continue;
    if (location === 'path') {
      pathProperties[paramName] = parameterSchema(
        parameter,
        ctx,
        `${label}.${paramName}`,
        openapi3,
      );
      required.push(paramName);
    } else if (location === 'query') {
      if (method === 'get' || method === 'delete') {
        payloadProperties[paramName] = parameterSchema(
          parameter,
          ctx,
          `${label}.${paramName}`,
          openapi3,
        );
        if (parameter.required === true) required.push(paramName);
      } else {
        ctx.warnings.push(`${label}的 query 参数「${paramName}」在 body 模式下无法表达，已忽略`);
      }
    } else if (location === 'header' || location === 'cookie') {
      ctx.warnings.push(`${label}的 ${location} 参数「${paramName}」未建模，已忽略`);
    } else if (location === 'body') {
      bodyParameter = parameter;
    } else {
      ctx.warnings.push(`${label}的 ${location} 参数「${paramName}」未支持，已忽略`);
    }
  }

  const isRead = method === 'get' || method === 'delete';
  if (isRead) {
    if (openapi3 && operation.requestBody !== undefined) {
      ctx.warnings.push(`${label}的 ${upper} 请求体已忽略`);
    }
    if (bodyParameter) ctx.warnings.push(`${label}的 body 参数已忽略`);
  } else {
    const requestBody = openapi3 ? requestBodySchema(operation, ctx, label) : undefined;
    const schema = openapi3 ? requestBody?.schema : bodyParameter?.schema;
    const bodyRequired = openapi3
      ? requestBody?.required === true
      : bodyParameter?.required === true;
    if (schema !== undefined) {
      const body = bodyObjectSchema(schema, ctx, `${label}的请求体`, bodyRequired);
      if (body) {
        Object.assign(payloadProperties, body.properties);
        required.push(...body.required);
      }
    }
  }

  for (const key of Object.keys(payloadProperties)) {
    if (Object.hasOwn(pathProperties, key)) {
      ctx.warnings.push(
        `工具「${name}」的参数「${key}」同时出现在路径与请求体/查询中，当前模型无法表达，已跳过`,
      );
      return undefined;
    }
  }

  const description =
    textField(operation.summary) || textField(operation.description) || `${upper} ${path}`;

  return {
    name,
    description:
      description.length > MAX_DESCRIPTION ? description.slice(0, MAX_DESCRIPTION) : description,
    method: upper,
    pathTemplate: path.startsWith('/') ? path : `/${path}`,
    inputSchema: {
      type: 'object',
      properties: { ...pathProperties, ...payloadProperties },
      required: [...new Set(required)],
    },
    outputSchema: responseSchema(operation, ctx, label, openapi3),
    paramsIn: isRead ? 'query' : 'body',
    approvalMode: 'allow',
  };
}

export function parseOpenApiDocument(text: string): ParsedOpenApi {
  const root = parseDocument(text);
  const openapi3 = assertSupportedVersion(root);
  const paths = root.paths;
  if (!isRecord(paths)) invalid('OpenAPI 文档缺少 paths 对象');

  const warnings: string[] = [];
  const ctx: Ctx = { root, warnings };
  const tools: ImportedHttpTool[] = [];
  const used = new Set<string>();

  for (const [path, rawItem] of Object.entries(paths)) {
    const item = resolveNode(rawItem, ctx, `路径「${path}」`);
    if (!item) continue;
    const itemParameters = readParameters(item.parameters, ctx, `路径「${path}」`);
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!isRecord(operation)) continue;
      const tool = buildTool(path, method, operation, itemParameters, ctx, used, openapi3);
      if (!tool) continue;
      if (tools.length >= MAX_OPERATIONS) {
        fail('PAYLOAD_TOO_LARGE', '接口数量超过上限 200，请拆分后再导入', { path: 'openapi' });
      }
      tools.push(tool);
    }
  }

  return { tools, warnings };
}
