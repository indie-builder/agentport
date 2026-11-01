import { z } from 'zod';
import { businessIdSchema } from './access.js';

export const channelRoleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);
export type ChannelRole = z.infer<typeof channelRoleSchema>;

const channelMessageKindSchema = z.enum(['human', 'agent', 'system']);
const channelAgentStatusSchema = z.enum(['active', 'paused', 'disconnected']);

/** seq / lastReadSeq 走 bigint(mode: number)，wire 上限定非负安全整数。 */
const seqSchema = z.number().int().nonnegative().safe();
const cursorSchema = z.coerce.number().int().nonnegative().safe().default(0);

export const channelSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  createdBy: z.string(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Channel = z.infer<typeof channelSchema>;

export const channelMemberSchema = z.object({
  channelId: z.string(),
  businessId: z.string(),
  role: channelRoleSchema,
  lastReadSeq: seqSchema,
  createdAt: z.string(),
});
export type ChannelMember = z.infer<typeof channelMemberSchema>;

export const channelAgentBindingSchema = z.object({
  channelId: z.string(),
  agentId: z.string(),
  conversationId: z.string().nullable(),
  status: channelAgentStatusSchema,
  autoWakeOnAll: z.boolean(),
  addedBy: z.string(),
  createdAt: z.string(),
});
export type ChannelAgentBinding = z.infer<typeof channelAgentBindingSchema>;

export const channelMessageSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  seq: seqSchema,
  kind: channelMessageKindSchema,
  authorBusinessId: z.string().nullable(),
  agentId: z.string().nullable(),
  runId: z.string().nullable(),
  body: z.string(),
  clientMessageId: z.string().nullable(),
  sourceMessageId: z.string().nullable(),
  createdAt: z.string(),
});
export type ChannelMessage = z.infer<typeof channelMessageSchema>;

const channelLastMessageSchema = z.object({
  id: z.string(),
  seq: seqSchema,
  kind: channelMessageKindSchema,
  /** 摘要，最多 200 字符；完整正文走消息列表。 */
  body: z.string().max(200),
  authorBusinessId: z.string().nullable(),
  agentId: z.string().nullable(),
  createdAt: z.string(),
});

export const channelListItemSchema = channelSchema.extend({
  /** 平台管理员但非频道成员时为 null。 */
  role: channelRoleSchema.nullable(),
  lastReadSeq: seqSchema,
  unreadCount: z.number().int().nonnegative().safe(),
  lastMessage: channelLastMessageSchema.nullable(),
});
export type ChannelListItem = z.infer<typeof channelListItemSchema>;

export const channelDetailSchema = channelSchema.extend({
  members: z.array(channelMemberSchema),
  agentBindings: z.array(channelAgentBindingSchema),
});
export type ChannelDetail = z.infer<typeof channelDetailSchema>;

export const channelCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    description: z.string().max(2000).nullable().optional(),
  })
  .strict();

export const channelUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.description !== undefined, {
    message: '至少提供一项修改',
  });

export const channelMemberInputSchema = z
  .object({
    businessId: businessIdSchema,
    role: channelRoleSchema.default('member'),
  })
  .strict();

export const channelAgentInputSchema = z
  .object({
    agentId: z.string().min(1),
    autoWakeOnAll: z.boolean().default(false),
  })
  .strict();

export const channelMessageInputSchema = z
  .object({
    // 保留用户正文首尾空白，只用 trim 判定是否为空白消息。
    body: z
      .string()
      .min(1)
      .max(32000)
      .refine((body) => body.trim().length > 0, '消息不能为空'),
    // 幂等标识不 trim：' a' 与 'a' 是不同客户端的 key。
    clientMessageId: z.string().min(1).max(160).optional(),
    /** 显式 @ 的 agentId；只唤醒频道内 active 且 enabled 的绑定。 */
    mentions: z.array(z.string().min(1)).max(50).optional(),
    /** @all：只唤醒绑定上 autoWakeOnAll=true 的 active agent。 */
    mentionAll: z.boolean().optional(),
  })
  .strict();

export const channelMessagesQuerySchema = z.object({
  after: cursorSchema,
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const channelEventsQuerySchema = z.object({
  after: cursorSchema,
});

export const channelReadInputSchema = z
  .object({
    seq: seqSchema,
  })
  .strict();

export const channelReadStateSchema = z.object({
  lastReadSeq: seqSchema,
});

/** 与聊天流一致的终态集合；queued/running 不是 run.finished。 */
const terminalRunStatusSchema = z.enum(['succeeded', 'failed', 'cancelled', 'timeout']);

/** SSE 事件：先按 seq 回放，再订阅 Redis 频道流。 */
export const channelEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message.created'),
    channelId: z.string(),
    seq: seqSchema,
    message: channelMessageSchema,
  }),
  z.object({
    type: z.literal('run.started'),
    channelId: z.string(),
    runId: z.string(),
    agentId: z.string(),
  }),
  z.object({
    type: z.literal('run.finished'),
    channelId: z.string(),
    runId: z.string(),
    agentId: z.string(),
    status: terminalRunStatusSchema,
  }),
  z.object({
    type: z.literal('approval.requested'),
    channelId: z.string(),
    runId: z.string(),
    approvalId: z.string(),
    toolName: z.string(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type ChannelEvent = z.infer<typeof channelEventSchema>;

/** 频道事件 Redis Stream，api 生产、SSE 消费共用这一处。 */
export function channelStreamKey(channelId: string): string {
  return `channel:${channelId}:events`;
}

/** Redis 连接名，用于识别并清理同一频道的订阅者。 */
export function channelEventsConnectionName(channelId: string): string {
  return `channel-events:${channelId}`;
}
