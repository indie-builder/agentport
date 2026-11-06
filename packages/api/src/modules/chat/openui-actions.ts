import type { Database } from '@agentport/db';
import { repo, schema } from '@agentport/db';
import { type OpenUiAction, segmentOpenUi } from '@agentport/shared';
import { and, eq } from 'drizzle-orm';

type OpenUiActionRequest = OpenUiAction;
export const OPENUI_ACTION_MAX_BYTES = 64 * 1024;
export function openUiActionContent(action: OpenUiActionRequest): unknown[] {
  const params = action.params as Record<string, unknown>;
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
export function actionBytes(action: OpenUiActionRequest): number {
  return Buffer.byteLength(JSON.stringify(openUiActionContent(action)), 'utf8');
}
export function sourcePairingProblem(action: OpenUiActionRequest): string | null {
  const { messageId, blockKey } = action;
  if (messageId === undefined && blockKey === undefined) return null;
  if (messageId === undefined) return '动作缺少来源消息 id，请刷新页面后重试';
  if (blockKey === undefined) return '动作缺少来源 UI 段，请刷新页面后重试';
  return null;
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
  const exists = segmentOpenUi(text).some(
    (segment) => segment.kind === 'openui' && segment.blockKey === blockKey,
  );
  if (!exists) {
    return '动作来源的 UI 段已不存在，请刷新页面后重试';
  }
  return null;
}
