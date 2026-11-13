import { join } from 'node:path';
import {
  attachmentExtension,
  INPUTS_CONTAINER_DIR,
  type MessageAttachment,
  OUTPUTS_CONTAINER_DIR,
} from '@agentport/shared';

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
    `先 Read 相关资料再分析；读取失败要明确说明。输入只读，交付写 ${OUTPUTS_CONTAINER_DIR}。`,
  ].join('\n');
}
