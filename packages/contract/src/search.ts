import { searchQuerySchema, searchResponseSchema } from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

export const searchContract = {
  search: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'GET', path: '/search', successStatus: 200 })
    .input(z.object({ query: searchQuerySchema }))
    .output(searchResponseSchema),
};
