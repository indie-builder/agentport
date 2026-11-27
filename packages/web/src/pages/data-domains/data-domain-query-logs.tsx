import { useNavigate, useSearch } from '@tanstack/react-router';
import { ScrollText } from 'lucide-react';
import { CursorListFooter } from '../../components/cursor-list-footer.js';
import { FilterSelect } from '../../components/filter-select.js';
import { PageSection, PageToolbar } from '../../components/page.js';
import { SearchInput } from '../../components/search-input.js';
import {
  type EmptyFilterChip,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button } from '../../components/ui/button.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { formatDateTime, formatDuration, shortId } from '../../lib/format.js';
import { useDataDomainQueryLogs } from '../../lib/queries.js';
import { useDebouncedValue } from '../../lib/use-debounced-value.js';

const statusOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'ok', label: '成功' },
  { value: 'error', label: '失败' },
];

export function DataDomainQueryLogs({ dataDomainId }: { dataDomainId: string }) {
  const search = useSearch({ from: '/_shell/data-domains/$dataDomainId' });
  const navigate = useNavigate();
  const status = search.queryStatus ?? 'all';
  const run = search.run ?? '';
  const settledRun = useDebouncedValue(run.trim(), 300);
  const logs = useDataDomainQueryLogs(dataDomainId, {
    limit: 50,
    ...(status === 'all' ? {} : { status }),
    ...(settledRun ? { runId: settledRun } : {}),
  });
  const rows = logs.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = status !== 'all' || settledRun !== '';

  const updateSearch = (patch: {
    queryStatus?: 'ok' | 'error' | undefined;
    run?: string | undefined;
  }): void => {
    void navigate({
      to: '/data-domains/$dataDomainId',
      params: { dataDomainId },
      search: { ...search, ...patch },
      replace: true,
    });
  };

  return (
    <PageSection title="查询日志" description="每次经连接器执行的查询都会记录摘要、耗时与发起人。">
      <PageToolbar>
        <FilterSelect
          value={status}
          onValueChange={(next) =>
            updateSearch({
              queryStatus: next === 'all' ? undefined : (next as 'ok' | 'error'),
            })
          }
          options={statusOptions}
          label="按查询状态过滤"
          className="w-36"
        />
        <SearchInput
          label="按运行 ID 过滤"
          placeholder="运行 ID…"
          value={run}
          onChange={(value) => updateSearch({ run: value || undefined })}
          className="w-64"
        />
      </PageToolbar>
      {logs.isPending ? <LoadingState rows={3} /> : null}
      {logs.isError && !logs.data ? (
        <ErrorState error={logs.error} onRetry={() => void logs.refetch()} />
      ) : null}
      {filtered && !logs.isPending && rows.length === 0 ? (
        <EmptyState
          variant="filter"
          scale="section"
          title="没有符合条件的记录"
          activeFilters={
            [
              ...(status !== 'all'
                ? [
                    {
                      key: 'status',
                      label: '状态',
                      value: status === 'ok' ? '成功' : '失败',
                      onRemove: () => updateSearch({ queryStatus: undefined }),
                    },
                  ]
                : []),
              ...(settledRun
                ? [
                    {
                      key: 'run',
                      label: '运行 ID',
                      value: settledRun,
                      onRemove: () => updateSearch({ run: undefined }),
                    },
                  ]
                : []),
            ] satisfies EmptyFilterChip[]
          }
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => updateSearch({ queryStatus: undefined, run: undefined })}
            >
              清除筛选
            </Button>
          }
        />
      ) : null}
      {!filtered && logs.data && rows.length === 0 ? (
        <EmptyState
          variant="stage"
          scale="section"
          icon={<ScrollText aria-hidden="true" />}
          title="等待首次查询记录"
          description="每次经连接器执行的查询都会自动记录摘要、耗时与发起人。"
        />
      ) : null}
      {rows.length > 0 ? (
        <Table aria-label="查询日志">
          <TableHeader>
            <TableRow>
              <TableHead>时间</TableHead>
              <TableHead>发起人</TableHead>
              <TableHead>版本</TableHead>
              <TableHead className="text-right">行数</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">耗时</TableHead>
              <TableHead>SQL 摘要</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((log) => (
              <TableRow key={log.id}>
                <TableCell className="text-xs text-muted-foreground">
                  {formatDateTime(log.createdAt)}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {log.actorBusinessId ?? '—'}
                </TableCell>
                <TableCell>
                  {log.versionId ? (
                    <code className="font-mono text-xs text-muted-foreground" title={log.versionId}>
                      {shortId(log.versionId)}
                    </code>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {log.rowCount ?? '—'}
                </TableCell>
                <TableCell>
                  <StatusBadge tone={log.status === 'ok' ? 'success' : 'danger'}>
                    {log.status === 'ok' ? '成功' : '失败'}
                  </StatusBadge>
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {formatDuration(log.durationMs)}
                </TableCell>
                <TableCell>
                  <code
                    className="block max-w-80 truncate font-mono text-xs text-fg"
                    title={log.sqlSummary}
                  >
                    {log.sqlSummary || '—'}
                  </code>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      <CursorListFooter
        query={logs}
        errorTitle="下一页加载失败，保留已加载的查询记录"
        disabled={logs.isFetching}
        showEndLabel={rows.length > 0}
      />
    </PageSection>
  );
}
