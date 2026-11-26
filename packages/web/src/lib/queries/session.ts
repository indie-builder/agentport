import type { AuthMe } from '@agentport/shared';
import { queryOptions } from '@tanstack/react-query';
import { api } from '../api.js';
import { queryClient } from './client.js';

export const ME_QUERY_KEY = ['me'] as const;

export const meQuery = queryOptions<AuthMe>({
  queryKey: ME_QUERY_KEY,
  queryFn: async () => {
    const identity = await api.me();
    if (identity.authenticated) {
      const { bindChatIdentity } = await import('../chat-store.js');
      bindChatIdentity(identity.user.businessId);
    }
    return identity;
  },
  staleTime: 30_000,
});

export function clearSessionQueries(client = queryClient): void {
  client.clear();
}

export async function logoutAccount(): Promise<void> {
  await api.logout().catch(() => undefined);
  clearSessionQueries();
  const { useChatStore } = await import('../chat-store.js');
  useChatStore.getState().reset();
}
