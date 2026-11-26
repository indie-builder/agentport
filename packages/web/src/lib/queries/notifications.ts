import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { toastError } from '../toast.js';
import { useCursorList } from './client.js';

const NOTIFICATIONS_PAGE_SIZE = 20;

const notificationKeys = {
  all: ['notifications'] as const,
  list: (unread: boolean) => ['notifications', 'list', unread ? 'unread' : 'all'] as const,
  unreadCount: ['notifications', 'unread-count'] as const,
};

export function useNotifications(unreadOnly: boolean) {
  return useCursorList({
    queryKey: notificationKeys.list(unreadOnly),
    queryFn: (cursor, signal) =>
      api.notifications(
        {
          ...(unreadOnly ? { unreadOnly: true } : {}),
          ...(cursor === undefined ? {} : { cursor }),
          limit: NOTIFICATIONS_PAGE_SIZE,
        },
        signal,
      ),
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
    select: (data) => ({
      items: data.pages.flatMap((page) => page.items),
      unreadCount: data.pages[0]?.unreadCount ?? 0,
    }),
  });
}

export function useUnreadNotificationCount(enabled = true) {
  return useQuery({
    queryKey: notificationKeys.unreadCount,
    queryFn: ({ signal }) => api.unreadNotificationCount(signal),
    enabled,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

export function useMarkNotificationRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.markNotificationRead(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: notificationKeys.all }),
    onError: (error) => toastError(error),
  });
}

export function useMarkAllNotificationsRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.markAllNotificationsRead(),
    onSuccess: () => void client.invalidateQueries({ queryKey: notificationKeys.all }),
    onError: (error) => toastError(error),
  });
}
