import type { ContentPolicyAction, PolicyEvent, PolicySourceKind } from '@agentport/shared';
import { Link, useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowUpRight, ShieldCheck } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { CopyButton } from '../../components/copy-button.js';
import { CursorListFooter } from '../../components/cursor-list-footer.js';
import { type DataColumn, DataTable } from '../../components/data-table.js';
import { FilterSelect } from '../../components/filter-select.js';
import { InspectorSheet } from '../../components/inspector-sheet.js';
import {
  ActiveFilterChips,
  type EmptyFilterChip,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button, buttonVariants } from '../../components/ui/button.js';
import { useDialogClose } from '../../lib/dialog-guard.js';
import { formatDateTime, formatRelative, shortId } from '../../lib/format.js';
import { useSecurityEvents } from '../../lib/queries.js';
import {
  ACTION_LABEL,
  DIRECTION_LABEL,
  EVENT_ACTION_OPTIONS,
  EVENT_SOURCE_OPTIONS,
  policyActionTone,
  SOURCE_LABEL,
} from './shared.js';

export function EventsSection() {
  const search = useSearch({ from: '/_shell/security' });
  const navigate = useNavigate({ from: '/security' });
  const location = useLocation();
  const action = search.eventAction;
  const sourceKind = search.eventSource;
  const events = useSecurityEvents({
    ...(action ? { action } : {}),
    ...(sourceKind ? { sourceKind } : {}),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const lastRowRef = useRef<PolicyEvent | null>(null);
  const rows = events.data?.pages.flatMap((page) => page.items) ?? [];

  const selectedRow = selectedId ? (rows.find((row) => row.id === selectedId) ?? null) : null;
  if (selectedRow) lastRowRef.current = selectedRow;
  const displayedRow = selectedRow ?? lastRowRef.current;
  const sheet = useDialogClose(() => setSelectedId(null), selectedId !== null);

  const backTo = `${location.pathname}${location.searchStr}`;

  const clearFilters = () => {
    void navigate({
      to: '/security',
      search: { ...search, eventAction: undefined, eventSource: undefined },
      replace: true,
    });
  };

  const activeFilters: EmptyFilterChip[] = [
    ...(action
      ? [
          {
            key: 'eventAction',
            label: '动作',
            value: ACTION_LABEL[action],
            onRemove: () =>
              void navigate({
                to: '/security',
                search: { ...search, eventAction: undefined },
                replace: true,
              }),
          },
        ]
      : []),
    ...(sourceKind
      ? [
          {
            key: 'eventSource',
            label: '来源',
            value: SOURCE_LABEL[sourceKind],
            onRemove: () =>
              void navigate({
                to: '/security',
                search: { ...search, eventSource: undefined },
                replace: true,
              }),
          },
        ]
      : []),
  ];

  const isFilteredEmpty = Boolean(events.data) && rows.length === 0 && activeFilters.length > 0;

  const openInspector = useCallback((eventItem: PolicyEvent, trigger: HTMLElement) => {
    triggerRef.current = trigger;
    lastRowRef.current = eventItem;
    setSelectedId(eventItem.id);
  }, []);

  const columns = useMemo<DataColumn<PolicyEvent>[]>(
    () => [
      {
        id: 'createdAt',
        header: '时间',
        locked: true,
        width: '112px',
        sortValue: (event) => event.createdAt,
        cell: (event) => (
          <span
            className="font-mono tabular-nums text-muted-foreground"
            title={formatDateTime(event.createdAt)}
          >
            {formatRelative(event.createdAt)}
          </span>
        ),
      },
      {
        id: 'policy',
        header: '策略',
        width: 'minmax(140px,1.2fr)',
        sortValue: (event) => event.policyName,
        cell: (event) => (
          <span className="flex min-w-0 flex-col">
            <span
              className="block overflow-hidden text-ellipsis whitespace-nowrap font-medium text-fg"
              title={event.policyName}
            >
              {event.policyName}
            </span>
            <span className="text-xs text-muted-foreground">v{event.policyVersion}</span>
          </span>
        ),
      },
      {
        id: 'action',
        header: '动作',
        width: '92px',
        cell: (event) => (
          <StatusBadge tone={policyActionTone(event.action)}>
            {ACTION_LABEL[event.action]}
          </StatusBadge>
        ),
      },
      {
        id: 'source',
        header: '来源',
        width: '96px',
        cell: (event) => SOURCE_LABEL[event.sourceKind],
      },
      {
        id: 'snippet',
        header: '摘要',
        width: 'minmax(160px,1.5fr)',
        cell: (event) => (
          <span
            className="block overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground"
            title={event.snippet}
          >
            {event.snippet || '—'}
          </span>
        ),
      },
      {
        id: 'direction',
        header: '方向',
        width: '68px',
        hiddenByDefault: true,
        cell: (event) => DIRECTION_LABEL[event.direction],
      },
      {
        id: 'actor',
        header: '操作者',
        width: 'minmax(110px,1fr)',
        hiddenByDefault: true,
        cell: (event) =>
          event.actor ? (
            <span
              className="block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-fg"
              title={event.actor}
            >
              {event.actor}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'runId',
        header: '运行',
        width: '96px',
        hiddenByDefault: true,
        cell: (event) =>
          event.runId ? (
            <code className="font-mono text-xs text-muted-foreground" title={event.runId}>
              {shortId(event.runId)}
            </code>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'destination',
        header: '目标',
        width: 'minmax(110px,1fr)',
        hiddenByDefault: true,
        cell: (event) =>
          event.destination ? (
            <span
              className="block overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground"
              title={event.destination}
            >
              {event.destination}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'actions',
        header: '操作',
        width: '80px',
        align: 'end',
        cell: (event) => (
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              aria-label={`查看事件 ${event.policyName} · ${formatDateTime(event.createdAt)}`}
              onClick={(clickEvent) => openInspector(event, clickEvent.currentTarget)}
            >
              查看
            </Button>
          </div>
        ),
      },
    ],
    [openInspector],
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          value={action ?? 'all'}
          onValueChange={(next) =>
            void navigate({
              to: '/security',
              search: {
                ...search,
                eventAction: next === 'all' ? undefined : (next as ContentPolicyAction),
              },
              replace: true,
            })
          }
          options={EVENT_ACTION_OPTIONS}
          label="按动作筛选"
          className="w-32"
        />
        <FilterSelect
          value={sourceKind ?? 'all'}
          onValueChange={(next) =>
            void navigate({
              to: '/security',
              search: {
                ...search,
                eventSource: next === 'all' ? undefined : (next as PolicySourceKind),
              },
              replace: true,
            })
          }
          options={EVENT_SOURCE_OPTIONS}
          label="按来源筛选"
          className="w-32"
        />
        <span role="status" className="ml-auto text-xs tabular-nums text-muted-foreground">
          {events.isPending
            ? '加载中…'
            : events.isError
              ? '数量不可用'
              : events.hasNextPage
                ? `已加载 ${rows.length} 条事件`
                : `共 ${rows.length} 条事件`}
        </span>
      </div>

      {!isFilteredEmpty && activeFilters.length > 0 ? (
        <ActiveFilterChips filters={activeFilters} onClearAll={clearFilters} />
      ) : null}

      {events.isPending ? <LoadingState rows={4} /> : null}
      {events.isError ? (
        <ErrorState
          error={events.error}
          onRetry={() => void events.refetch()}
          title="策略事件没有加载出来"
        />
      ) : null}
      {events.data && rows.length === 0 ? (
        isFilteredEmpty ? (
          <EmptyState
            variant="filter"
            scale="section"
            title="没有匹配的策略事件"
            activeFilters={activeFilters}
            action={
              <Button variant="outline" size="sm" onClick={clearFilters}>
                清除全部筛选
              </Button>
            }
          />
        ) : (
          <EmptyState
            variant="clear"
            scale="section"
            icon={<ShieldCheck className="size-5" aria-hidden="true" />}
            title="还没有触发策略事件"
            description="命中策略的请求会记录脱敏摘要。"
          />
        )
      ) : null}
      {rows.length > 0 ? (
        <>
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(event) => event.id}
            rowLabel={(event) => `${event.policyName} · ${formatDateTime(event.createdAt)}`}
            label="策略事件"
            storageKey="pace.security.events-columns"
            hideRowCount
            onRowClick={openInspector}
          />
          <CursorListFooter
            query={events}
            errorTitle="下一页加载失败，保留已加载的记录"
            showEndLabel
          />
        </>
      ) : null}

      <InspectorSheet
        open={sheet.open}
        onOpenChange={(next) => {
          if (!next) sheet.close();
        }}
        onOpenChangeComplete={(next) => {
          sheet.onOpenChangeComplete(next);
          if (!next) lastRowRef.current = null;
        }}
        size="md"
        title={displayedRow?.policyName ?? '事件详情'}
        eyebrow={
          displayedRow ? (
            <StatusBadge tone={policyActionTone(displayedRow.action)}>
              {ACTION_LABEL[displayedRow.action]}
            </StatusBadge>
          ) : null
        }
        description={
          displayedRow
            ? `v${displayedRow.policyVersion} · ${formatDateTime(displayedRow.createdAt)}`
            : undefined
        }
        finalFocus={() => (triggerRef.current?.isConnected ? triggerRef.current : null)}
        footer={
          displayedRow?.runId ? (
            <div className="flex items-center justify-end gap-2">
              <Link
                to="/runs/$runId"
                params={{ runId: displayedRow.runId }}
                search={{ backTo }}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                查看关联运行
                <ArrowUpRight data-icon="inline-end" aria-hidden="true" />
              </Link>
            </div>
          ) : undefined
        }
      >
        {displayedRow ? (
          <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-fg">事件信息</h2>
              <dl className="grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5 text-xs">
                <dt className="text-muted-foreground">命中策略</dt>
                <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">
                  {displayedRow.policyName}{' '}
                  <span className="font-mono text-muted-foreground">
                    v{displayedRow.policyVersion}
                  </span>
                </dd>
                <dt className="text-muted-foreground">动作</dt>
                <dd>
                  <StatusBadge tone={policyActionTone(displayedRow.action)}>
                    {ACTION_LABEL[displayedRow.action]}
                  </StatusBadge>
                </dd>
                <dt className="text-muted-foreground">方向</dt>
                <dd className="min-w-0 text-fg">{DIRECTION_LABEL[displayedRow.direction]}</dd>
                <dt className="text-muted-foreground">来源</dt>
                <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">
                  {SOURCE_LABEL[displayedRow.sourceKind]}
                  <span className="ml-2 font-mono text-muted-foreground">
                    {displayedRow.sourceId}
                  </span>
                </dd>
                <dt className="text-muted-foreground">操作者</dt>
                <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">
                  {displayedRow.actor ? (
                    <span className="font-mono">{displayedRow.actor}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </dd>
                <dt className="text-muted-foreground">目标</dt>
                <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">
                  {displayedRow.destination ?? <span className="text-muted-foreground">—</span>}
                </dd>
                <dt className="text-muted-foreground">触发时间</dt>
                <dd className="min-w-0 font-mono tabular-nums text-fg">
                  {formatDateTime(displayedRow.createdAt)}
                </dd>
                <dt className="text-muted-foreground">事件 ID</dt>
                <dd className="flex min-w-0 items-start justify-between gap-2">
                  <span className="min-w-0 font-mono text-fg [overflow-wrap:anywhere]">
                    {displayedRow.id}
                  </span>
                  <CopyButton
                    value={displayedRow.id}
                    label="复制事件 ID"
                    className="-my-1 -mr-1.5 shrink-0"
                  />
                </dd>
                <dt className="text-muted-foreground">关联运行</dt>
                <dd className="flex min-w-0 items-start justify-between gap-2">
                  {displayedRow.runId ? (
                    <>
                      <Link
                        to="/runs/$runId"
                        params={{ runId: displayedRow.runId }}
                        search={{ backTo }}
                        className="inline-flex min-w-0 items-center gap-1 font-mono text-link underline underline-offset-4 hover:text-fg"
                      >
                        <span className="[overflow-wrap:anywhere]">{displayedRow.runId}</span>
                        <ArrowUpRight className="size-3.5 shrink-0" aria-hidden="true" />
                      </Link>
                      <CopyButton
                        value={displayedRow.runId}
                        label="复制运行 ID"
                        className="-my-1 -mr-1.5 shrink-0"
                      />
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </dd>
                {displayedRow.channelId ? (
                  <>
                    <dt className="text-muted-foreground">关联频道</dt>
                    <dd className="min-w-0 font-mono text-fg [overflow-wrap:anywhere]">
                      {displayedRow.channelId}
                    </dd>
                  </>
                ) : null}
              </dl>
            </section>

            <section className="flex flex-col gap-2 border-t border-line pt-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium text-fg">脱敏内容摘要</h2>
                {displayedRow.snippet ? (
                  <CopyButton
                    value={displayedRow.snippet}
                    label="复制摘要"
                    className="-my-1 -mr-1.5 shrink-0"
                  />
                ) : null}
              </div>
              <pre className="overflow-x-auto rounded-item border border-code-line bg-code p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
                {displayedRow.snippet || '—'}
              </pre>
            </section>
          </div>
        ) : null}
      </InspectorSheet>
    </div>
  );
}
