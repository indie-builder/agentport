import { lstat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { attachmentExtension, type MessageAttachment } from '@agentport/shared';

/** 附件只读挂载的容器内路径，与 sandbox 的 INPUTS_DIR 一致。 */
export const INPUTS_CONTAINER_DIR = '/mnt/inputs';

export interface ConversationInputsIdentity {
  workspacesDir: string;
  hostWorkspacesDir: string;
  slug: string;
  conversationId: string;
}

/**
 * 会话输入目录存在时返回只读挂载；不存在表示本会话没有附件，不挂载也不报错。
 * 存在但不是真实目录（含软链）时拒绝，避免把挂载源换成别处。
 */
export async function conversationInputsMount(
  input: ConversationInputsIdentity,
): Promise<{ hostPath: string; containerPath: string; readonly: true } | null> {
  const dir = join(input.workspacesDir, input.slug, 'conversation-inputs', input.conversationId);
  const entry = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (entry === null) return null;
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Conversation inputs path must be a real directory: ${dir}`);
  }
  return {
    hostPath: join(input.hostWorkspacesDir, relative(input.workspacesDir, dir)),
    containerPath: INPUTS_CONTAINER_DIR,
    readonly: true,
  };
}

/**
 * 本轮附件清单：只在有附件时追加，文件名按 JSON 字符串转义。
 * 路径与挂载目录一致，历史轮次的同目录路径在后续 run 仍有效。
 */
export function promptWithAttachments(
  prompt: string,
  attachments: readonly MessageAttachment[],
): string {
  if (attachments.length === 0) return prompt;
  return [
    prompt,
    '',
    '用户随本轮消息提供了这些附件，已只读挂载到容器内：',
    ...attachments.map(
      (attachment) =>
        `- ${JSON.stringify(attachment.filename)}：${join(
          INPUTS_CONTAINER_DIR,
          `${attachment.id}${attachmentExtension(attachment.mimeType)}`,
        )}（${attachment.mimeType}，${attachment.size} bytes）`,
    ),
    '先 Read 相关资料再分析；读取失败要明确说明。输入只读，交付写 /mnt/outputs。',
  ].join('\n');
}
