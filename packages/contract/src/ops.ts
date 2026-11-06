import {
  agentStatsSchema,
  attentionSchema,
  scheduleInputSchema,
  schedulePatchSchema,
  scheduleSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

const scheduleParams = z.object({ id: z.string().min(1) });
const agentParams = z.object({ id: z.string().min(1) });

export const opsDaysQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export const opsContract = {
  attention: contractProcedure
    .route({ method: 'GET', path: '/attention' })
    .output(attentionSchema)
    .meta({ access: { kind: 'permission', permissionId: 'operations.read' } }),
  schedules: {
    list: contractProcedure
      .route({ method: 'GET', path: '/schedules' })
      .output(z.array(scheduleSchema))
      .meta({ access: { kind: 'permission', permissionId: 'schedules.read' } }),
    create: contractProcedure
      .route({ method: 'POST', path: '/schedules', successStatus: 201 })
      .input(z.object({ body: scheduleInputSchema }))
      .output(scheduleSchema)
      .meta({ access: { kind: 'permission', permissionId: 'schedules.manage' } }),
    update: contractProcedure
      .route({ method: 'PATCH', path: '/schedules/{id}' })
      .input(z.object({ params: scheduleParams, body: schedulePatchSchema }))
      .output(scheduleSchema)
      .meta({ access: { kind: 'permission', permissionId: 'schedules.manage' } }),
    remove: contractProcedure
      .route({ method: 'DELETE', path: '/schedules/{id}', successStatus: 204 })
      .input(z.object({ params: scheduleParams }))
      .output(z.void())
      .meta({ access: { kind: 'permission', permissionId: 'schedules.manage' } }),
  },
  agentStats: contractProcedure
    .route({ method: 'GET', path: '/agents/{id}/stats' })
    .input(z.object({ params: agentParams, query: opsDaysQuerySchema }))
    .output(agentStatsSchema)
    .meta({ access: { kind: 'permission', permissionId: 'agents.read' } }),
};
