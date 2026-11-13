import { openUiActionPartSchema } from '@agentport/shared';

/** 消息内容可能是纯文本对象，也可能是 text + 动作片段数组（生成式 UI 的动作回传）。 */
function parts(content: unknown): { text: string | null; action: Record<string, unknown> | null } {
  if (typeof content !== 'object' || content === null) return { text: null, action: null };
  if (Array.isArray(content)) {
    let text: string | null = null;
    let action: Record<string, unknown> | null = null;
    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue;
      const { type } = part as { type?: unknown };
      if (type === 'text' && text === null) {
        const value = (part as { text?: unknown }).text;
        if (typeof value === 'string') text = value;
      } else if (type === 'openui_action' && action === null) {
        // 校验后保留原始对象：zod 会 strip 它契约之外的字段（如 params），模型不该因此丢上下文。
        if (openUiActionPartSchema.safeParse(part).success) {
          action = part as Record<string, unknown>;
        }
      }
    }
    return { text, action };
  }
  const { type, text } = content as { type?: unknown; text?: unknown };
  return { text: type === 'text' && typeof text === 'string' ? text : null, action: null };
}

/**
 * 发送给沙盒的首条消息。生成式 UI 的动作带着用户点的是哪一项与当时的表单值，
 * 只发文本会让模型丢失这些信息；这里以受控 JSON 追加，原样交给模型。
 * 体积已在 API 入口按 64KB 拒绝，不能在这里静默丢内容。
 * 纯文本消息原样返回，markdown 路径行为不变。
 */
export function promptWithOpenUiAction(content: unknown, fallback: string): string {
  const parsed = parts(content);
  const text = parsed.text ?? fallback;
  if (parsed.action === null) return text;

  const action = parsed.action;
  const payload = JSON.stringify({
    ...(action.params === undefined ? {} : { params: action.params }),
    ...(action.context === undefined ? {} : { context: action.context }),
    ...(action.formState === undefined ? {} : { formState: action.formState }),
    ...(action.formName === undefined ? {} : { formName: action.formName }),
  });
  // 空动作（例如只带一个 message）没有额外信息，不追加噪声。
  if (payload === '{}') return text;
  return `${text}\n\n[openui_action] ${payload}`;
}
