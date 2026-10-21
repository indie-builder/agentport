import { useNavigate, useSearch } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { useDeferredValue } from 'react';
import { type DataColumn, DataTable } from '../components/data-table.js';
import { FilterSelect } from '../components/filter-select.js';
import { Page, PageHeader, PageNote, PageToolbar } from '../components/page.js';
import { SearchInput } from '../components/search-input.js';
import { ErrorState } from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button } from '../components/ui/button.js';
import type { AuditEntry, AuditStatus } from '../lib/api.js';
import {
  auditStatusLabel,
  auditStatusVariant,
  formatDateTime,
  formatDuration,
  shortId,
} from '../lib/format.js';
import { useAudit } from '../lib/queries.js';

const statusOptions: Array<{ value: AuditStatus | 'all'; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'ok', label: '成功' },
  { value: 'error', label: '错误' },
  { value: 'denied', label: '拒绝' },
];

const columns: DataColumn<AuditEntry>[] = [
  {
    id: 'createdAt',
    header: '时间',
    locked: true,
    width: '130px',
    sortValue: (row) => row.createdAt,
    cell: (row) => (
      <span className="font-mono tabular-nums text-muted-foreground" title={row.createdAt}>
        {formatDateTime(row.createdAt)}
      </span>
    ),
  },
  {
    id: 'action',
    header: '动作',
    locked: true,
    width: 'minmax(160px,1.3fr)',
    cell: (row) => <span className="font-mono text-fg">{row.action}</span>,
  },
  {
    id: 'target',
    header: '目标',
    width: 'minmax(120px,1fr)',
    cell: (row) =>
      row.target ? (
        <span className="font-mono text-muted-foreground" title={row.target}>
          {shortId(row.target)}
        </span>
      ) : (
        <span className="text-subtle">—</span>
      ),
  },
  {
    id: 'status',
    header: '状态',
    width: '90px',
    cell: (row) => (
      <StatusBadge tone={auditStatusVariant[row.status]}>
        {auditStatusLabel[row.status]}
      </StatusBadge>
    ),
  },
  {
    id: 'durationMs',
    header: '耗时',
    numeric: true,
    width: '90px',
    sortValue: (row) => row.durationMs,
    cell: (row) => formatDuration(row.durationMs),
  },
  {
    id: 'requestId',
    header: '请求 ID',
    width: '130px',
    cell: (row) =>
      row.requestId ? (
        <span className="font-mono text-muted-foreground" title={row.requestId}>
          {shortId(row.requestId)}
        </span>
      ) : (
        <span className="text-subtle">—</span>
      ),
  },
];

export function AuditPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: '/shell/audit' });
  const action = search.action ?? '';
  const status = search.status ?? 'all';
  const deferredAction = useDeferredValue(action.trim());
  const audit = useAudit({
    ...(deferredAction ? { action: deferredAction } : {}),
    ...(status === 'all' ? {} : { status }),
  });

  const rows = audit.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = Boolean(deferredAction) || status !== 'all';
  const searchPending = action.trim() !== deferredAction;

  return (
    <Page>
      <PageHeader
        title="审计"
        actions={
          <Button
            variant="outline"
            onClick={() => void audit.refetch()}
            disabled={audit.isFetching}
          >
            <RefreshCw
              data-icon="inline-start"
              className={audit.isFetching ? 'animate-spin' : undefined}
              aria-hidden="true"
            />
            {audit.isFetching ? '刷新中…' : '刷新'}
          </Button>
        }
      />

      <PageToolbar>
        <SearchInput
          label="按动作前缀过滤"
          placeholder="动作前缀，如 auth.login"
          value={action}
          onChange={(value) =>
            void navigate({
              to: '/audit',
              search: { ...search, action: value || undefined },
              replace: true,
            })
          }
          className="w-full sm:w-56"
        />
        <FilterSelect
          value={status}
          onValueChange={(next) =>
            void navigate({
              to: '/audit',
              search: { ...search, status: next === 'all' ? undefined : (next as AuditStatus) },
            })
          }
          options={statusOptions}
          label="按状态过滤"
          className="w-full sm:w-36"
        />
      </PageToolbar>
      <p className="text-xs text-subtle">登录与配置变更的长期记录；输入只保存摘要，不落原文。</p>

      {audit.isError && !audit.data ? (
        <ErrorState
          error={audit.error}
          onRetry={() => void audit.refetch()}
          title="审计记录没有加载出来"
        />
      ) : (
        <>
          {audit.isRefetchError ? (
            <ErrorState
              error={audit.error}
              onRetry={() => void audit.refetch()}
              title="刷新失败，保留已加载的审计记录"
            />
          ) : null}
          {filtered && !audit.isPending && !searchPending && rows.length === 0 ? (
            <PageNote
              title="没有符合当前筛选条件的审计记录"
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void navigate({ to: '/audit', search: {} })}
                >
                  清除筛选
                </Button>
              }
            />
          ) : (
            <DataTable
              rows={rows}
              columns={columns}
              rowKey={(row) => row.id}
              label="审计事件"
              loading={audit.isPending || searchPending}
              empty="还没有审计记录。登录或修改配置后，这里会自动出现对应事件。"
            />
          )}
          {audit.isFetchNextPageError ? (
            <ErrorState
              error={audit.error}
              onRetry={() => void audit.fetchNextPage()}
              title="下一页加载失败，保留已加载的审计记录"
            />
          ) : audit.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                disabled={audit.isFetching || searchPending}
                onClick={() => void audit.fetchNextPage()}
              >
                {audit.isFetchingNextPage ? '加载中…' : '加载更多'}
              </Button>
            </div>
          ) : rows.length > 0 ? (
            <div className="text-center text-xs text-subtle">已到末尾</div>
          ) : null}
        </>
      )}
    </Page>
  );
}
