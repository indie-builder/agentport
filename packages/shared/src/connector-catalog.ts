import { z } from 'zod';

export const connectorCatalogItemSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(['http', 'stdio']),
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  envKeys: z.array(z.string()).optional(),
  sourceUrl: z.string(),
  reviewedAt: z.string(),
});

export type ConnectorCatalogItem = z.infer<typeof connectorCatalogItemSchema>;

export const connectorCatalogSchema = z.array(connectorCatalogItemSchema);
