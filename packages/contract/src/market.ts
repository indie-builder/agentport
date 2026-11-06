import {
  marketInstallInputSchema,
  marketSkillSchema,
  marketViewSchema,
  skillSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

const listQuerySchema = z.object({
  view: marketViewSchema.optional(),
  q: z.string().trim().max(100).optional(),
});
export const marketContract = {
  list: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'market.read' } })
    .route({ method: 'GET', path: '/market/skills', successStatus: 200 })
    .input(z.object({ query: listQuerySchema }))
    .output(z.array(marketSkillSchema)),
  install: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'market.install' } })
    .route({ method: 'POST', path: '/market/skills/install', successStatus: 201 })
    .input(z.object({ body: marketInstallInputSchema }))
    .output(z.object({ skill: skillSchema, warnings: z.array(z.string()) })),
};
