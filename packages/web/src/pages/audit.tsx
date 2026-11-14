import { utcWindowStart } from '@agentport/shared';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Download, RefreshCw, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { type DataColumn, DataTable } from '../components/data-table.js';
import { FilterSelect } from '../components/filter-select.js';
import {
  Page,
  PageBody,
  PageHeader,
  PageNote,
  PageToolbar,
  PageTopbar,
} from '../components/page.js';
import { SearchInput } from '../components/search-input.js';
import { ErrorState } from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button } from '../components/ui/button.js';
import { type AuditEntry, type AuditStatus, api } from '../lib/api.js';
import { downloadJson } from '../lib/browser-files.js';
import {
  auditStatusLabel,
  auditStatusVariant,
  formatDateTime,
  formatDuration,
} from '../lib/format.js';
import { useAudit } from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { useDebouncedValue } from '../lib/use-debounced-value.js';

const actorKindLabel: Record<AuditEntry['actorKind'], string> = {
  user: '用户',
  service: '服务',
  anonymous: '匿名',
  agent: '智能体',
};

const statusOptions: Array<{ value: AuditStatus | 'all'; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'ok', label: '成功' },
  { value: 'error', label: '错误' },
  { value: 'denied', label: '拒绝' },
];

const rangeOptions = [
  { value: 'all', label: '全部时间' },
  { value: '7', label: '近 7 天' },
  { value: '30', label: '近 30 天' },
  { value: '90', label: '近 90 天' },
];

const actorKindOptions: Array<{ value: AuditEntry['actorKind'] | 'all'; label: string }> = [
  { value: 'all', label: '全部主体类型' },
  ...(['user', 'service', 'anonymous', 'agent'] as const).map((kind) => ({
    value: kind,
    label: actorKindLabel[kind],
  })),
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
    width: 'minmax(120px,200px)',
    cell: (row) =>
      row.target ? (
        <span className="whitespace-normal [overflow-wrap:anywhere] font-mono text-muted-foreground">
          {row.target}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
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
    width: '72px',
    sortValue: (row) => row.durationMs,
    cell: (row) => formatDuration(row.durationMs),
  },
  {
    id: 'requestId',
    header: '请求 ID',
    width: 'minmax(130px,1fr)',
    cell: (row) =>
      row.requestId ? (
        <span className="whitespace-normal [overflow-wrap:anywhere] font-mono text-muted-foreground">
          {row.requestId}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
];

/** 只展示接口已有的字段；输入原文本就不落库，摘要为空时如实给「—」。 */
function auditDetails(row: AuditEntry) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
      <dt className="text-muted-foreground">操作者</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere] font-mono text-fg">{row.actor}</dd>
      <dt className="text-muted-foreground">主体类型</dt>
      <dd className="min-w-0 text-fg">{actorKindLabel[row.actorKind]}</dd>
      <dt className="text-muted-foreground">事件 ID</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere] font-mono text-fg">{row.id}</dd>
      <dt className="text-muted-foreground">输入摘要</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere] font-mono text-fg">
        {row.inputDigest ?? <span className="text-muted-foreground">—</span>}
      </dd>
    </dl>
  );
}

export function AuditPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: '/_shell/audit' });
  const action = search.action ?? '';
  const status = search.status ?? 'all';
  const target = search.target ?? '';
  const actor = search.actor ?? '';
  const actorKind = search.actorKind ?? 'all';
  const range = search.range ?? 'all';
  const since = range === 'all' ? undefined : utcWindowStart(Number(range)).toISOString();
  const [exporting, setExporting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const settledAction = useDebouncedValue(action.trim(), 300);
  const settledTarget = useDebouncedValue(target.trim(), 300);
  const settledActor = useDebouncedValue(actor.trim(), 300);
  const audit = useAudit({
    ...(settledAction ? { action: settledAction } : {}),
    ...(status === 'all' ? {} : { status }),
    ...(settledTarget ? { target: settledTarget } : {}),
    ...(settledActor ? { actor: settledActor } : {}),
    ...(actorKind === 'all' ? {} : { actorKind }),
    ...(since ? { since } : {}),
  });

  const rows = audit.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered =
    Boolean(settledAction) ||
    status !== 'all' ||
    Boolean(settledTarget) ||
    Boolean(settledActor) ||
    actorKind !== 'all' ||
    range !== 'all';
  const searchPending =
    action.trim() !== settledAction ||
    target.trim() !== settledTarget ||
    actor.trim() !== settledActor;

  const exportAudit = async (): Promise<void> => {
    setExporting(true);
    try {
      // 与表格使用同一份已生效的筛选值，避免刚输入就导出时导出旧条件。
      const data = await api.exportAudit({
        ...(settledAction ? { action: settledAction } : {}),
        ...(status === 'all' ? {} : { status }),
        ...(settledTarget ? { target: settledTarget } : {}),
        ...(settledActor ? { actor: settledActor } : {}),
        ...(actorKind === 'all' ? {} : { actorKind }),
        ...(since ? { since } : {}),
      });
      downloadJson(data, 'audit.json');
    } catch (error) {
      toastError(error);
    } finally {
      setExporting(false);
    }
  };

  const verifyChain = async (): Promise<void> => {
    if (verifying) return;
    setVerifying(true);
    try {
      let afterSeq: number | undefined;
      let checked = 0;
      let complete = false;
      for (let i = 0; i < 200; i += 1) {
        const result = await api.verifyAudit({
          limit: 5000,
          ...(afterSeq === undefined ? {} : { afterSeq }),
        });
        checked += result.checked;
        if (!result.ok) {
          toastError(
            new Error(
              `审计链校验失败：seq ${result.brokenSeq ?? '未知'} 处断链（已校验 ${checked} 条）`,
            ),
          );
          return;
        }
        if (result.complete || result.nextAfterSeq === null) {
          complete = true;
          break;
        }
        afterSeq = result.nextAfterSeq;
      }
      if (complete) toastSuccess(`审计链完整，已校验 ${checked} 条记录`);
      else toastError(new Error(`校验未完成，已校验 ${checked} 条，请重试`));
    } catch (error) {
      toastError(error);
    } finally {
      setVerifying(false);
    }
  };

  return (
    <Page>
      <PageTopbar>
        <PageHeader
          title="审计"
          description="输入只保存摘要，不落原文。"
          actions={
            <>
              <Button variant="outline" onClick={() => void verifyChain()} disabled={verifying}>
                <ShieldCheck data-icon="inline-start" aria-hidden="true" />
                {verifying ? '校验中…' : '校验完整性'}
              </Button>
              <Button
                variant="outline"
                onClick={() => void exportAudit()}
                disabled={exporting || searchPending}
              >
                <Download data-icon="inline-start" aria-hidden="true" />
                {exporting ? '导出中…' : searchPending ? '等待筛选…' : '导出审计'}
              </Button>
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
            </>
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
          <SearchInput
            label="按目标精确筛选"
            placeholder="目标，如 agent:123"
            value={target}
            onChange={(value) =>
              void navigate({
                to: '/audit',
                search: { ...search, target: value || undefined },
                replace: true,
              })
            }
            className="w-full sm:w-56"
          />
          <SearchInput
            label="按操作者过滤"
            placeholder="操作者，如 alice"
            value={actor}
            onChange={(value) =>
              void navigate({
                to: '/audit',
                search: { ...search, actor: value || undefined },
                replace: true,
              })
            }
            className="w-full sm:w-56"
          />
          <FilterSelect
            value={actorKind}
            onValueChange={(next) =>
              void navigate({
                to: '/audit',
                search: {
                  ...search,
                  actorKind: next === 'all' ? undefined : (next as AuditEntry['actorKind']),
                },
              })
            }
            options={actorKindOptions}
            label="按主体类型过滤"
            className="w-full sm:w-36"
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
          <FilterSelect
            value={range}
            onValueChange={(next) =>
              void navigate({
                to: '/audit',
                search: {
                  ...search,
                  range: next === 'all' ? undefined : (next as '7' | '30' | '90'),
                },
              })
            }
            options={rangeOptions}
            label="按时间范围过滤"
            className="w-full sm:w-36"
          />
        </PageToolbar>
      </PageTopbar>

      <PageBody>
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
                rowLabel={(row) =>
                  `${row.action}${row.target ? ` ${row.target}` : ''} · ${formatDateTime(row.createdAt)}`
                }
                label="审计事件"
                loading={audit.isPending || searchPending}
                empty="登录或修改配置后会自动记录对应事件。"
                renderExpanded={auditDetails}
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
              <div className="text-center text-xs text-muted-foreground">已到末尾</div>
            ) : null}
          </>
        )}
      </PageBody>
    </Page>
  );
}
