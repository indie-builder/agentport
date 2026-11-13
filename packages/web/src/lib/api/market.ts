import type { MarketInstallInput, MarketSkill, MarketView } from '@agentport/shared';
import { rpc } from '../orpc.js';
import { clientOptions } from './shared.js';
import type { SkillImportResult } from './skills.js';

export default {
  marketSkills: (
    query: { view?: MarketView; q?: string } = {},
    signal?: AbortSignal,
  ): Promise<MarketSkill[]> => rpc.market.list({ query }, clientOptions(signal)),
  installMarketSkill: (input: MarketInstallInput): Promise<SkillImportResult> =>
    rpc.market.install({ body: input }),
};
