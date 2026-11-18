import { observabilitySnapshotSchema, sloSettingsSchema } from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

const read = contractProcedure.meta({
  access: { kind: 'permission', permissionId: 'operations.read' },
});
const manage = contractProcedure.meta({
  access: { kind: 'permission', permissionId: 'operations.manage' },
});

export const observabilityContract = {
  snapshot: read
    .route({ method: 'GET', path: '/observability' })
    .input(
      z.object({
        query: z.object({
          windowMinutes: z.coerce.number().int().min(15).max(1440).default(60),
        }),
      }),
    )
    .output(observabilitySnapshotSchema),
  slo: {
    get: read.route({ method: 'GET', path: '/observability/slo' }).output(sloSettingsSchema),
    update: manage
      .route({ method: 'PUT', path: '/observability/slo' })
      .input(z.object({ body: sloSettingsSchema }))
      .output(sloSettingsSchema),
  },
};
