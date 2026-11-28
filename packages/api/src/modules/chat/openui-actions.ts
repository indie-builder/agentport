import type { Database } from '@agentport/db';
import { repo, schema } from '@agentport/db';
import {
  type OpenUiAction,
  openUiActionPartSchema,
  outputRefSchema,
  segmentOpenUi,
} from '@agentport/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

type OpenUiActionRequest = OpenUiAction;
export const OPENUI_ACTION_MAX_BYTES = 64 * 1024;
export const openUiActionContentSchema = z.tuple([
  z.object({ type: z.literal('text'), text: z.string(), output: outputRefSchema.optional() }),
  openUiActionPartSchema.extend({
    params: z.record(z.string(), z.unknown()).optional(),
    messageId: z.string().optional(),
    blockKey: z.string().optional(),
  }),
]);

export function openUiActionContent(
  action: OpenUiActionRequest,
): z.infer<typeof openUiActionContentSchema> {
  const params: Record<string, unknown> = action.params;
  const context = action.context !== undefined ? action.context : params.context;
  return [
    { type: 'text', text: action.message },
    {
      type: 'openui_action',
      params: action.params,
      ...(context === undefined ? {} : { context }),
      ...(action.formState === undefined ? {} : { formState: action.formState }),
      ...(action.formName === undefined ? {} : { formName: action.formName }),
      ...(action.messageId === undefined ? {} : { messageId: action.messageId }),
      ...(action.blockKey === undefined ? {} : { blockKey: action.blockKey }),
    },
  ];
}
type OpenUiActionPart = z.infer<typeof openUiActionContentSchema>[1];

function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  return value !== null && typeof value === 'object'
    ? Object.values(value).flatMap(stringLeaves)
    : [];
}

function objectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(objectKeys);
  return value !== null && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, child]) => [key, ...objectKeys(child)])
    : [];
}

function applyStringLeaves(value: unknown, next: () => string): unknown {
  if (typeof value === 'string') return next();
  if (Array.isArray(value)) return value.map((item) => applyStringLeaves(item, next));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, applyStringLeaves(child, next)]),
    );
  }
  return value;
}

export function openUiActionPolicyInputs(action: OpenUiActionPart): {
  values: string[];
  keys: string[];
  apply: (redactedValues: readonly string[]) => OpenUiActionPart;
} {
  const values = [
    ...stringLeaves(action.params),
    ...stringLeaves(action.context),
    ...stringLeaves(action.formState),
    ...stringLeaves(action.formName),
  ];
  const keys = [
    ...objectKeys(action.params),
    ...objectKeys(action.context),
    ...objectKeys(action.formState),
  ];
  return {
    values,
    keys,
    apply(redactedValues) {
      let cursor = 0;
      const next = () => redactedValues[cursor++] ?? '';
      return {
        ...action,
        ...(action.params === undefined
          ? {}
          : { params: applyStringLeaves(action.params, next) as Record<string, unknown> }),
        ...(action.context === undefined
          ? {}
          : { context: applyStringLeaves(action.context, next) }),
        ...(action.formState === undefined
          ? {}
          : { formState: applyStringLeaves(action.formState, next) as Record<string, unknown> }),
        ...(action.formName === undefined
          ? {}
          : { formName: applyStringLeaves(action.formName, next) as string }),
      };
    },
  };
}

export function sourcePairingProblem(action: OpenUiActionRequest): string | null {
  const { messageId, blockKey } = action;
  if (messageId === undefined && blockKey === undefined) return null;
  if (messageId === undefined) return '动作缺少来源消息 id，请刷新页面后重试';
  if (blockKey === undefined) return '动作缺少来源 UI 段，请刷新页面后重试';
  return null;
}
export function hasOpenUiBlock(text: string, blockKey: string): boolean {
  return segmentOpenUi(text).some(
    (segment) => segment.kind === 'openui' && segment.blockKey === blockKey,
  );
}
export async function checkOpenUiActionSource(
  db: Database,
  conversationId: string | undefined,
  action: OpenUiActionRequest,
): Promise<string | null> {
  const pairing = sourcePairingProblem(action);
  if (pairing !== null) return pairing;
  const { messageId, blockKey } = action;
  if (messageId === undefined || blockKey === undefined) return null;
  if (conversationId === undefined) return '动作来源不属于任何会话，请刷新页面后重试';
  const [row] = await db
    .select({
      role: schema.messages.role,
      uiFormat: schema.messages.uiFormat,
      uiProgram: schema.messages.uiProgram,
      content: schema.messages.content,
    })
    .from(schema.messages)
    .where(
      and(eq(schema.messages.id, messageId), eq(schema.messages.conversationId, conversationId)),
    )
    .limit(1);
  if (!row) return '动作来源消息不存在或不属于该会话，请刷新页面后重试';
  if (row.role !== 'assistant' || row.uiFormat !== 'openui') {
    return '动作来源不是生成式 UI 的助手消息，请刷新页面后重试';
  }
  const content = row.content;
  if (
    typeof content === 'object' &&
    content !== null &&
    typeof (
      content as {
        parentToolUseId?: unknown;
      }
    ).parentToolUseId === 'string'
  ) {
    return '动作来源不是主助手消息，请刷新页面后重试';
  }
  const text = row.uiProgram ?? repo.chat.messageText(content) ?? '';
  const exists = hasOpenUiBlock(text, blockKey);
  if (!exists) {
    return '动作来源的 UI 段已不存在，请刷新页面后重试';
  }
  return null;
}
