import { z } from 'zod';

export const searchKindSchema = z.enum([
  'agent',
  'conversation',
  'knowledge',
  'server',
  'skill',
  'plugin',
  'output',
]);

export const searchItemSchema = z.object({
  kind: searchKindSchema,
  id: z.string(),
  title: z.string(),
  subtitle: z.string().default(''),
  updatedAt: z.string().optional(),
  conversationId: z.string().optional(),
  agentId: z.string().optional(),
  runId: z.string().optional(),
  path: z.string().optional(),
});

export type SearchItem = z.infer<typeof searchItemSchema>;

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(128),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const searchResponseSchema = z.object({ items: z.array(searchItemSchema) });

export type SearchResponse = z.infer<typeof searchResponseSchema>;
