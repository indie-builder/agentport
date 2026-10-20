import { useDeferredValue, useState } from 'react';
import { type DataColumn, DataTable } from '../components/data-table.js';
import { Page, PageHeader, PageToolbar } from '../components/page.js';
import { ErrorState } from '../components/states.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Select } from '../components/ui/select.js';
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
      <span className="font-mono tabular-nums text-muted" title={row.createdAt}>
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
        <span className="font-mono text-muted" title={row.target}>
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
      <Badge variant={auditStatusVariant[row.status]}>{auditStatusLabel[row.status]}</Badge>
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
        <span className="font-mono text-muted" title={row.requestId}>
          {shortId(row.requestId)}
        </span>
      ) : (
        <span className="text-subtle">—</span>
      ),
  },
];

export function AuditPage() {
  const [action, setAction] = useState('');
  const [status, setStatus] = useState<AuditStatus | 'all'>('all');
  // 低优先级更新：输入保持响应，查询用延迟后的值。
  const deferredAction = useDeferredValue(action.trim());
  const audit = useAudit({
    ...(deferredAction ? { action: deferredAction } : {}),
    ...(status === 'all' ? {} : { status }),
  });

  const rows = audit.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Page>
      <PageHeader
        title="审计"
        actions={
          <Button
            variant="outline"
            size="sm"
            className="rounded-full"
            onClick={() => void audit.refetch()}
            disabled={audit.isFetching}
          >
            刷新
          </Button>
        }
      />

      <PageToolbar>
        <Input
          aria-label="按动作前缀过滤"
          placeholder="动作前缀，如 auth.login"
          value={action}
          onChange={(event) => setAction(event.target.value)}
          className="w-56 rounded-[9px]"
        />
        <Select
          aria-label="按状态过滤"
          value={status}
          onValueChange={(next) => setStatus(next as AuditStatus | 'all')}
          className="w-32 rounded-[9px]"
          options={statusOptions}
        />
        <span className="ml-auto hidden text-xs text-subtle md:block">
          登录与配置变更的长期记录；输入只保存摘要，不落原文。
        </span>
      </PageToolbar>

      {audit.isError ? (
        <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
      ) : (
        <>
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(row) => row.id}
            label="审计事件"
            loading={audit.isPending}
            empty="还没有审计记录。登录或修改配置后，这里会自动出现对应事件。"
          />
          {audit.hasNextPage ? (
            <div className="flex justify-center pt-2">
              <Button
                variant="outline"
                size="sm"
                className="rounded-full"
                disabled={audit.isFetchingNextPage}
                onClick={() => void audit.fetchNextPage()}
              >
                {audit.isFetchingNextPage ? '加载中…' : '加载更多'}
              </Button>
            </div>
          ) : rows.length > 0 ? (
            <div className="pt-2 text-center text-xs text-subtle">已到末尾</div>
          ) : null}
        </>
      )}
    </Page>
  );
}
