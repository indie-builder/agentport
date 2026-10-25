import type { Database } from '@agentport/db';
import { repo, schema } from '@agentport/db';
import { type OpenUiAction, segmentOpenUi } from '@agentport/shared';
import { and, eq } from 'drizzle-orm';

/**
 * 生成式 UI 的动作回传。`continue_conversation` 走普通对话入口，
 * 用户消息除文本外再存一段 `openui_action`，模型据此知道点的是哪个按钮/表单。
 *
 * 形状直接复用 shared 的 `openUiActionSchema`：前端、API 与测试只认这一份，
 * 不再各自定义字段（曾经因为 `openuiAction`/`openuiAction` 与缺失 `type` 静默丢过表单值）。
 */
type OpenUiActionRequest = OpenUiAction;

/** 动作片段大小上限，防止表单值把消息体撑大；与 message 的 64KB 同级。 */
export const OPENUI_ACTION_MAX_BYTES = 64 * 1024;

/**
 * 用户消息内容：文本与动作片段并列，`params` 与来源原样保留。
 * 前端历史只显示 text，worker 组 prompt 时再把动作数据以受控 JSON 追加给模型。
 */
export function openUiActionContent(action: OpenUiActionRequest): unknown[] {
  // 显式 context 优先；旧调用方只把隐藏上下文放在 params.context，不能丢。
  // open_url 的 params 是 `{ url }` 对象，读取共用字段时按记录处理。
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

/** 序列化后的动作片段字节数；超限由路由拒绝，不静默截断表单值。 */
export function actionBytes(action: OpenUiActionRequest): number {
  return Buffer.byteLength(JSON.stringify(openUiActionContent(action)), 'utf8');
}

/** 来源必须成对：实时消息没有 id 时整对缺省是合法的，缺一半是客户端拼错。 */
export function sourcePairingProblem(action: OpenUiActionRequest): string | null {
  const { messageId, blockKey } = action;
  if (messageId === undefined && blockKey === undefined) return null;
  if (messageId === undefined) return '动作缺少来源消息 id，请刷新页面后重试';
  if (blockKey === undefined) return '动作缺少来源 UI 段，请刷新页面后重试';
  return null;
}

/**
 * 来源校验：`messageId` 与 `blockKey` 必须成对，且指向本会话里真实存在的主助手 UI 段。
 * 实时消息落库前没有 id，因此整体缺省是合法的。
 * 返回 null 表示通过，否则是给用户看的错误说明。
 */
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
  // 子智能体的消息不是主助手界面：挂在它上面的段不会被渲染，也不能当来源。
  const content = row.content;
  if (
    typeof content === 'object' &&
    content !== null &&
    typeof (content as { parentToolUseId?: unknown }).parentToolUseId === 'string'
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
