import { auditContract } from '@agentport/contract/audit';
import { repo } from '@agentport/db';
import { implement } from '@orpc/server';
import type { RequestContext } from '../../http/context.js';
import { requireCursorPage } from '../../http/pagination.js';
import { auditOptions, toItem } from './shared.js';

const os = implement(auditContract).$context<RequestContext>();

export const auditRouter = os.router({
  list: os.list.handler(async ({ input, context }) => {
    const page = requireCursorPage(
      await repo.audit.listAuditPage(context.db, auditOptions(input.query)),
    );
    return { items: page.items.map(toItem), nextCursor: page.nextCursor };
  }),
  verify: os.verify.handler(async ({ input, context }) =>
    repo.audit.verifyAuditChain(context.db, {
      ...(input.query.afterSeq === undefined ? {} : { afterSeq: input.query.afterSeq }),
      ...(input.query.limit === undefined ? {} : { limit: input.query.limit }),
    }),
  ),
});
