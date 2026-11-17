import { useNavigate, useSearch } from '@tanstack/react-router';
import { FilterSelect } from '../../components/filter-select.js';
import { PageSection, PageToolbar } from '../../components/page.js';
import { SearchInput } from '../../components/search-input.js';
import { ErrorState, LoadingState } from '../../components/states.js';
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
        <p className="border-y py-5 text-sm text-muted-foreground">
          没有符合当前筛选条件的查询记录。
        </p>
      ) : null}
      {!filtered && logs.data && rows.length === 0 ? (
        <p className="border-y py-5 text-sm text-muted-foreground">还没有查询记录。</p>
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
      {logs.isFetchNextPageError ? (
        <ErrorState
          error={logs.error}
          onRetry={() => void logs.fetchNextPage()}
          title="下一页加载失败，保留已加载的查询记录"
        />
      ) : logs.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            disabled={logs.isFetching}
            onClick={() => void logs.fetchNextPage()}
          >
            {logs.isFetchingNextPage ? '加载中…' : '加载更多'}
          </Button>
        </div>
      ) : rows.length > 0 ? (
        <div className="text-center text-xs text-muted-foreground">已到末尾</div>
      ) : null}
    </PageSection>
  );
}
