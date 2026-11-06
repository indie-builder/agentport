import { overviewSchema, overviewTimeseriesSchema } from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

export const overviewQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(3650).default(7),
});

export const overviewContract = {
  snapshot: contractProcedure
    .route({ method: 'GET', path: '/overview' })
    .input(z.object({ query: overviewQuerySchema }))
    .output(overviewSchema)
    .meta({ access: { kind: 'permission', permissionId: 'overview.read' } }),
  timeseries: contractProcedure
    .route({ method: 'GET', path: '/overview/timeseries' })
    .input(z.object({ query: overviewQuerySchema }))
    .output(overviewTimeseriesSchema)
    .meta({ access: { kind: 'permission', permissionId: 'overview.read' } }),
};
