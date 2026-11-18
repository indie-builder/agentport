import type { SearchQuery, SearchResponse } from '@agentport/shared';
import { rpc } from '../orpc.js';
import { clientOptions } from './shared.js';

export default {
  search: (query: SearchQuery, signal?: AbortSignal): Promise<SearchResponse> =>
    rpc.search.search({ query }, clientOptions(signal)),
};
