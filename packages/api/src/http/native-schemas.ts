import { auditQuerySchema } from '@agentport/contract/audit';
import {
  displayNameSchema,
  PLUGIN_ZIP_MAX_BYTES,
  runStatusSchema,
  runTriggerSchema,
  slugSchema,
} from '@agentport/shared';
import { z } from 'zod';

export { PLUGIN_ZIP_MAX_BYTES };

export const agentImportQuerySchema = z
  .object({
    slug: slugSchema.optional(),
    name: displayNameSchema.optional(),
    runtimeEnvironmentId: z.string().min(1).optional(),
  })
  .strict();

export const auditExportQuerySchema = auditQuerySchema.extend({
  limit: z.coerce.number().int().positive().max(1000).default(1000),
  format: z.enum(['json', 'ndjson']).default('json'),
  afterSeq: z.coerce.number().int().nonnegative().optional(),
});

export const pluginImportQuerySchema = z.object({ slug: slugSchema }).strict();

export const runExportQuerySchema = z.object({
  agentId: z.string().min(1).optional(),
  status: runStatusSchema.optional(),
  trigger: runTriggerSchema.optional(),
  since: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
});
