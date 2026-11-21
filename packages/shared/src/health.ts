import { z } from 'zod';

export const queueCountsSchema = z.object({
  waiting: z.number().int(),
  active: z.number().int(),
  completed: z.number().int(),
  failed: z.number().int(),
  delayed: z.number().int(),
  oldestWaitingMs: z.number().int().nullable(),
});
export type QueueCounts = z.infer<typeof queueCountsSchema>;

export const healthMetricsSchema = z.object({
  process: z.object({
    uptimeSeconds: z.number(),
    memoryRssBytes: z.number(),
    bunVersion: z.string(),
  }),
  queue: queueCountsSchema.nullable(),
  knowledgeQueue: queueCountsSchema.nullable(),
  db: z.object({
    connected: z.boolean(),
    pingMs: z.number().nullable(),
    maxConnections: z.number().int().nullable(),
  }),
  redis: z.object({ pingMs: z.number() }).nullable(),
});
export type HealthMetrics = z.infer<typeof healthMetricsSchema>;
