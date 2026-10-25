import { z } from 'zod';

/**
 * 生成式 UI 的跨端协议：动作回传、表单状态、工具描述。
 * 本文件同时被浏览器、API 与 worker 引入，只依赖 zod。
 */

/** 只允许 http/https；挡掉 javascript:/data: 等可执行协议。 */
export function isSafeOpenUrl(url: string): boolean {
  // shared 的 lib 不含 DOM 类型；用全局构造器在 Node 与浏览器都能解析。
  const UrlCtor = (globalThis as { URL?: new (input: string) => { protocol: string } }).URL;
  if (UrlCtor === undefined) return false;
  try {
    const protocol = new UrlCtor(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** 允许的动作类型；自定义动作必须由组件库注册，未注册一律忽略。 */
export const OPENUI_BUILTIN_ACTIONS = ['continue_conversation', 'open_url'] as const;

/** 动作共有的载荷；前后端与 API 共用这一份，避免字段名再次漂移。 */
const actionPayload = {
  params: z.record(z.string(), z.unknown()).default({}),
  /** 人类可读的说明，直接作为下一条用户消息的正文。 */
  message: z
    .string()
    .min(1)
    .max(64 * 1024),
  /** 动作附带的隐藏上下文，供模型理解点的是哪一项。 */
  context: z.unknown().optional(),
  /** 触发时表单的全部字段值；渲染器给出的是 `{ [formName]: { 字段: 值 } }`。 */
  formState: z.record(z.string(), z.unknown()).optional(),
  formName: z.string().max(256).optional(),
  /**
   * 来源助手消息与 UI 段。实时消息在落库前没有 id，因此可选；
   * 一旦出现就必须非空——空串是「没填」的伪装，不能当成合法来源。
   */
  messageId: z.string().min(1).optional(),
  blockKey: z.string().min(1).max(256).optional(),
};

/**
 * 浏览器回传的完整动作。discriminated union 让 API 能直接复用，
 * 也保证 `open_url` 的地址在边界处就被校验。
 */
export const openUiActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('continue_conversation'), ...actionPayload }),
  z.object({
    type: z.literal('open_url'),
    ...actionPayload,
    params: z.object({ url: z.string().refine(isSafeOpenUrl, '仅支持 http/https 地址') }),
  }),
]);
export type OpenUiAction = z.infer<typeof openUiActionSchema>;

/** `continue_conversation` 的片段：存进用户消息内容数组，与文本并列。 */
export const openUiActionPartSchema = z.object({
  type: z.literal('openui_action'),
  context: z.unknown().optional(),
  formState: z.record(z.string(), z.unknown()).optional(),
  formName: z.string().optional(),
});
export type OpenUiActionPart = z.infer<typeof openUiActionPartSchema>;

/** 单个 UI 段的表单/绑定快照；键是 blockKey（messageId:segmentIndex）。 */
export const openUiStateEnvelopeSchema = z.object({
  version: z.literal(1),
  blocks: z.record(z.string(), z.unknown()),
});
export type OpenUiStateEnvelope = z.infer<typeof openUiStateEnvelopeSchema>;

/** 单个 block 的状态上限；超出返回 413，不静默截断。 */
export const OPENUI_STATE_MAX_BYTES = 64 * 1024;

/** 官方 chat 库自带的提示词文案；由 meta.ts 原样携带，不在这里手抄。 */
export interface OpenUiPromptOptions {
  examples: readonly string[];
  additionalRules: readonly string[];
}

/** 服务端可执行、且会写进提示词的工具描述；两边必须来自同一函数。 */
export interface OpenUiToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

/** 工具调用的返回；错误也是数据，UI 用 Callout 展示。 */
export const openUiToolResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), data: z.unknown() }),
  z.object({ status: z.literal('error'), error: z.string() }),
  z.object({ status: z.literal('approval_required'), approvalId: z.string() }),
]);
export type OpenUiToolResult = z.infer<typeof openUiToolResultSchema>;
