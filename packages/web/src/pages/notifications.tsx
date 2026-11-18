import type { Notification, NotificationKind } from '@agentport/shared';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Bell, CheckCheck } from 'lucide-react';
import {
  Page,
  PageBody,
  PageHeader,
  PageNote,
  PageToolbar,
  PageTopbar,
} from '../components/page.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button } from '../components/ui/button.js';
import { SegmentedToggle } from '../components/view-toggle.js';
import { cn } from '../lib/cn.js';
import { formatDateTime, formatRelative } from '../lib/format.js';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
} from '../lib/queries.js';
import { toastSuccess } from '../lib/toast.js';

const KIND_META: Record<NotificationKind, { label: string; tone: 'default' | 'warn' | 'danger' }> =
  {
    approval: { label: '审批', tone: 'warn' },
    question: { label: '提问', tone: 'default' },
    run_failed: { label: '运行失败', tone: 'danger' },
    schedule_failed: { label: '定时任务失败', tone: 'danger' },
    budget_alert: { label: '预算提醒', tone: 'warn' },
    ops_alert: { label: '运维告警', tone: 'danger' },
    policy_approval: { label: '外发审批', tone: 'warn' },
    policy_violation: { label: '违规处置', tone: 'danger' },
  };

const FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'unread', label: '待办' },
] as const;

function internalLink(href: string): string | null {
  return href.startsWith('/') && !href.startsWith('//') ? href : null;
}

function NotificationRow({
  item,
  marking,
  onMarkRead,
}: {
  item: Notification;
  marking: boolean;
  onMarkRead: () => void;
}) {
  const navigate = useNavigate();
  const meta = KIND_META[item.kind];
  const unread = item.readAt === null;
  const link = internalLink(item.link);

  return (
    <li className="group relative flex min-w-0 items-start gap-3 py-3 transition-colors duration-150 ease-out-soft hover:bg-hover">
      {link === null ? null : (
        <a
          href={link}
          aria-label={`打开通知：${item.title}`}
          onClick={(event) => {
            event.preventDefault();
            void navigate({ href: link });
          }}
          className="absolute inset-0 rounded-item outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <span className="sr-only">打开通知：{item.title}</span>
        </a>
      )}
      <span
        aria-hidden="true"
        className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', unread ? 'bg-fg' : 'bg-transparent')}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
          {unread ? <span className="sr-only">未读</span> : null}
          <span className="min-w-0 truncate text-sm font-medium text-fg underline-offset-2 group-hover:underline">
            {item.title}
          </span>
          <time
            dateTime={item.createdAt}
            title={formatDateTime(item.createdAt)}
            className="ml-auto shrink-0 text-xs text-muted-foreground"
          >
            {formatRelative(item.createdAt)}
          </time>
        </div>
        {item.body ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">{item.body}</p>
        ) : null}
      </div>
      {unread ? (
        <Button
          variant="ghost"
          size="sm"
          className="relative z-10 shrink-0"
          disabled={marking}
          aria-busy={marking}
          aria-label={`标为已读：${item.title}`}
          onClick={onMarkRead}
        >
          标为已读
        </Button>
      ) : null}
    </li>
  );
}

export function NotificationsPage() {
  const search = useSearch({ from: '/_shell/notifications' });
  const navigate = useNavigate({ from: '/notifications' });
  const unreadOnly = search.filter === 'unread';
  const notifications = useNotifications(unreadOnly);
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();

  const items = notifications.data?.items ?? [];
  const unreadCount = notifications.data?.unreadCount ?? 0;
  const firstLoadFailed = notifications.isError && notifications.data === undefined;
  const empty = !notifications.isPending && !firstLoadFailed && items.length === 0;

  const setFilter = (filter: 'all' | 'unread'): void => {
    void navigate({
      to: '/notifications',
      search: filter === 'unread' ? { filter: 'unread' } : {},
      replace: true,
    });
  };

  return (
    <Page>
      <PageTopbar>
        <PageHeader
          title="通知与待办"
          {...(unreadCount > 0
            ? {
                description: `${unreadCount} 条待办`,
                actions: (
                  <Button
                    variant="outline"
                    disabled={markAll.isPending}
                    aria-busy={markAll.isPending}
                    onClick={() =>
                      markAll.mutate(undefined, {
                        onSuccess: () => toastSuccess('已全部标为已读'),
                      })
                    }
                  >
                    <CheckCheck data-icon="inline-start" aria-hidden="true" />
                    {markAll.isPending ? '处理中…' : '全部已读'}
                  </Button>
                ),
              }
            : {})}
        />
        <PageToolbar>
          <SegmentedToggle
            label="筛选通知"
            value={unreadOnly ? 'unread' : 'all'}
            options={FILTERS}
            onChange={setFilter}
          />
        </PageToolbar>
      </PageTopbar>

      <PageBody>
        {notifications.isError && notifications.data !== undefined ? (
          <PageNote
            tone="danger"
            title="刷新失败，保留已加载的通知"
            action={
              <Button variant="outline" size="sm" onClick={() => void notifications.refetch()}>
                重试
              </Button>
            }
          />
        ) : null}

        {firstLoadFailed ? (
          <ErrorState error={notifications.error} onRetry={() => void notifications.refetch()} />
        ) : notifications.isPending ? (
          <LoadingState rows={5} />
        ) : empty ? (
          unreadOnly ? (
            <PageNote
              title="没有待办"
              action={
                <Button variant="outline" size="sm" onClick={() => setFilter('all')}>
                  查看全部
                </Button>
              }
            />
          ) : (
            <PageNote icon={<Bell aria-hidden="true" />} title="还没有通知" />
          )
        ) : (
          <>
            <ul aria-label="通知列表" className="divide-y divide-line border-y">
              {items.map((item) => (
                <NotificationRow
                  key={item.id}
                  item={item}
                  marking={markRead.isPending && markRead.variables === item.id}
                  onMarkRead={() =>
                    markRead.mutate(item.id, {
                      onSuccess: () => toastSuccess('已标为已读'),
                    })
                  }
                />
              ))}
            </ul>
            {notifications.isFetchNextPageError ? (
              <PageNote
                tone="danger"
                title="更多通知没有加载出来"
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void notifications.fetchNextPage()}
                  >
                    重试
                  </Button>
                }
              />
            ) : notifications.hasNextPage ? (
              <div className="flex justify-center pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={notifications.isFetchingNextPage}
                  aria-busy={notifications.isFetchingNextPage}
                  onClick={() => void notifications.fetchNextPage()}
                >
                  {notifications.isFetchingNextPage ? '加载中…' : '加载更多'}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </PageBody>
    </Page>
  );
}
