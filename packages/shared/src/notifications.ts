import { z } from 'zod';
import { cursorQuerySchema } from './pagination.js';

export const notificationKindSchema = z.enum([
  'approval',
  'question',
  'run_failed',
  'schedule_failed',
  'budget_alert',
  'ops_alert',
  'policy_approval',
  'policy_violation',
]);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

export const notificationSchema = z.object({
  id: z.string(),
  kind: notificationKindSchema,
  title: z.string(),
  body: z.string(),
  link: z.string(),
  readAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const notificationListQuerySchema = cursorQuerySchema({ default: 30 }).extend({
  unreadOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export const notificationListSchema = z.object({
  items: z.array(notificationSchema),
  nextCursor: z.string().nullable(),
  unreadCount: z.number().int().nonnegative(),
});
export type NotificationList = z.infer<typeof notificationListSchema>;

export const notificationUnreadCountSchema = z.object({
  unreadCount: z.number().int().nonnegative(),
});
export type NotificationUnreadCount = z.infer<typeof notificationUnreadCountSchema>;
