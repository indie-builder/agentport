import { oc } from '@orpc/contract';
import type { RouteMeta } from './access.js';
import { contractErrors } from './errors.js';

export const contractProcedure = oc
  .$meta<Partial<RouteMeta>>({})
  .$route({ inputStructure: 'detailed' })
  .errors(contractErrors);
