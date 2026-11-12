import { marketContract } from '@agentport/contract/market';
import { implement } from '@orpc/server';
import { actorOf } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { fetchLeaderboard } from './leaderboard.js';
import { searchMarket } from './search.js';
import { installMarketSkill } from './use-cases.js';

const os = implement(marketContract).$context<RequestContext>();
export const marketRouter = os.router({
  list: os.list.handler(async ({ input: routeInput }) => {
    const { view, q } = routeInput.query;
    if (q === undefined) return fetchLeaderboard(view ?? 'all-time');
    if (q.length < 2) return [];
    return searchMarket(q);
  }),
  install: os.install.handler(async ({ context, input: routeInput }) => {
    return installMarketSkill(
      { db: context.db, log: context.log, actor: actorOf(context), requestId: context.requestId },
      routeInput.body,
    );
  }),
});
