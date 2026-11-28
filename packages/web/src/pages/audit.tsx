import { auditStatusSchema, utcWindowStart } from '@agentport/shared';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Download, EllipsisVertical, RefreshCw, ScrollText, ShieldCheck } from 'lucide-react';
import { Fragment, useRef, useState } from 'react';
import { CopyButton } from '../components/copy-button.js';
import { CursorListFooter } from '../components/cursor-list-footer.js';
import { type DataColumn, DataTable } from '../components/data-table.js';
import { FilterPopover } from '../components/filter-popover.js';
import { FilterSelect } from '../components/filter-select.js';
import { InspectorSheet } from '../components/inspector-sheet.js';
import { Page, PageBody, PageHeader, PageToolbar, PageTopbar } from '../components/page.js';
import { SearchInput } from '../components/search-input.js';
import {
  ActiveFilterChips,
  type EmptyFilterChip,
  EmptyState,
  ErrorState,
} from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button } from '../components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu.js';
import { type AuditEntry, type AuditStatus, api } from '../lib/api.js';
import { downloadBlob, downloadJson } from '../lib/browser-files.js';
import { toCsv } from '../lib/csv.js';
import { useDialogClose } from '../lib/dialog-guard.js';
import {
  auditStatusLabel,
  auditStatusVariant,
  formatDateTime,
  formatDuration,
  timeRangeOptions,
} from '../lib/format.js';
import { useAudit } from '../lib/queries.js';
import { toastError, toastPromise } from '../lib/toast.js';
import { useDebouncedValue } from '../lib/use-debounced-value.js';

const actorKindLabel: Record<AuditEntry['actorKind'], string> = {
  user: '用户',
  service: '服务',
  anonymous: '匿名',
  agent: '智能体',
};

const statusOptions: Array<{ value: AuditStatus | 'all'; label: string }> = [
  { value: 'all', label: '全部状态' },
  ...auditStatusSchema.options.map((value) => ({
    value,
    label: auditStatusLabel[value],
  })),
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
    width: '132px',
    sortValue: (row) => row.createdAt,
    cell: (row) => (
      <span className="font-mono tabular-nums text-muted-foreground" title={row.createdAt}>
        {formatDateTime(row.createdAt)}
      </span>
    ),
  },
  {
    id: 'actor',
    header: '操作者',
    locked: true,
    width: 'minmax(140px,1fr)',
    cell: (row) => (
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className="min-w-0 max-w-[160px] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-fg"
          title={row.actor}
        >
          {row.actor}
        </span>
        <StatusBadge className="shrink-0">{actorKindLabel[row.actorKind]}</StatusBadge>
      </div>
    ),
  },
  {
    id: 'action',
    header: '动作',
    locked: true,
    width: 'minmax(160px,1.2fr)',
    cell: (row) => (
      <span
        className="block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-fg"
        title={row.action}
      >
        {row.action}
      </span>
    ),
  },
  {
    id: 'target',
    header: '目标',
    width: 'minmax(120px,180px)',
    cell: (row) =>
      row.target ? (
        <span
          className="block max-w-[180px] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-muted-foreground"
          title={row.target}
        >
          {row.target}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    id: 'status',
    header: '状态',
    width: '88px',
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
    width: '76px',
    sortValue: (row) => row.durationMs,
    cell: (row) => formatDuration(row.durationMs),
  },
  {
    id: 'requestId',
    header: '请求 ID',
    width: 'minmax(140px,1fr)',
    hiddenByDefault: true,
    cell: (row) =>
      row.requestId ? (
        <span
          className="block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-muted-foreground"
          title={row.requestId}
        >
          {row.requestId}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
];

function buildAuditQuery(values: {
  action: string;
  status: AuditStatus | 'all';
  target: string;
  actor: string;
  actorKind: AuditEntry['actorKind'] | 'all';
  since: string | undefined;
}) {
  return {
    ...(values.action ? { action: values.action } : {}),
    ...(values.status === 'all' ? {} : { status: values.status }),
    ...(values.target ? { target: values.target } : {}),
    ...(values.actor ? { actor: values.actor } : {}),
    ...(values.actorKind === 'all' ? {} : { actorKind: values.actorKind }),
    ...(values.since ? { since: values.since } : {}),
  };
}

const detailLabels = new Map<string, string>([
  ['toolName', '工具'],
  ['toolId', '工具 ID'],
  ['from', '变更前'],
  ['to', '变更后'],
]);

const detailOrder = [...detailLabels.keys()];

function detailRank(key: string) {
  const index = detailOrder.indexOf(key);
  return index === -1 ? detailOrder.length : index;
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
  const [exportingCsv, setExportingCsv] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const lastRowRef = useRef<AuditEntry | null>(null);
  const trimmedAction = action.trim();
  const trimmedTarget = target.trim();
  const trimmedActor = actor.trim();
  const settledAction = useDebouncedValue(trimmedAction, 300);
  const settledTarget = useDebouncedValue(trimmedTarget, 300);
  const settledActor = useDebouncedValue(trimmedActor, 300);
  const query = buildAuditQuery({
    action: settledAction,
    status,
    target: settledTarget,
    actor: settledActor,
    actorKind,
    since,
  });
  const audit = useAudit(query);

  const rows = audit.data?.pages.flatMap((page) => page.items) ?? [];
  const firstLoadFailed = audit.isError && !audit.data;
  const selectedRow = selectedId ? (rows.find((item) => item.id === selectedId) ?? null) : null;
  if (selectedRow) lastRowRef.current = selectedRow;
  const displayedRow = selectedRow ?? lastRowRef.current;
  const sheet = useDialogClose(() => setSelectedId(null), selectedRow !== null);
  const detailEntries = displayedRow
    ? Object.entries(displayedRow.detail ?? {}).sort(([a], [b]) => detailRank(a) - detailRank(b))
    : [];
  const clearFilters = () => {
    void navigate({ to: '/audit', search: {}, replace: true });
  };
  const filtered =
    Boolean(settledAction) ||
    status !== 'all' ||
    Boolean(settledTarget) ||
    Boolean(settledActor) ||
    actorKind !== 'all' ||
    range !== 'all';
  const searchPending =
    trimmedAction !== settledAction ||
    trimmedTarget !== settledTarget ||
    trimmedActor !== settledActor;
  const isFilteredEmpty = filtered && !audit.isPending && !searchPending && rows.length === 0;
  const activeFilterCount =
    (trimmedTarget ? 1 : 0) +
    (trimmedActor ? 1 : 0) +
    (actorKind !== 'all' ? 1 : 0) +
    (status !== 'all' ? 1 : 0) +
    (range !== 'all' ? 1 : 0);

  const activeFilters: EmptyFilterChip[] = [
    ...(trimmedAction
      ? [
          {
            key: 'action',
            label: '动作前缀',
            value: trimmedAction,
            onRemove: () =>
              void navigate({
                to: '/audit',
                search: { ...search, action: undefined },
                replace: true,
              }),
          },
        ]
      : []),
    ...(trimmedTarget
      ? [
          {
            key: 'target',
            label: '目标',
            value: trimmedTarget,
            onRemove: () =>
              void navigate({
                to: '/audit',
                search: { ...search, target: undefined },
                replace: true,
              }),
          },
        ]
      : []),
    ...(trimmedActor
      ? [
          {
            key: 'actor',
            label: '操作者',
            value: trimmedActor,
            onRemove: () =>
              void navigate({
                to: '/audit',
                search: { ...search, actor: undefined },
                replace: true,
              }),
          },
        ]
      : []),
    ...(actorKind !== 'all'
      ? [
          {
            key: 'actorKind',
            label: '主体类型',
            value: actorKindLabel[actorKind],
            onRemove: () =>
              void navigate({
                to: '/audit',
                search: { ...search, actorKind: undefined },
                replace: true,
              }),
          },
        ]
      : []),
    ...(status !== 'all'
      ? [
          {
            key: 'status',
            label: '状态',
            value: auditStatusLabel[status],
            onRemove: () =>
              void navigate({
                to: '/audit',
                search: { ...search, status: undefined },
                replace: true,
              }),
          },
        ]
      : []),
    ...(range !== 'all'
      ? [
          {
            key: 'range',
            label: '时间范围',
            value: timeRangeOptions.find((option) => option.value === range)?.label ?? range,
            onRemove: () =>
              void navigate({
                to: '/audit',
                search: { ...search, range: undefined },
                replace: true,
              }),
          },
        ]
      : []),
  ];

  const exportAudit = async (): Promise<void> => {
    setExporting(true);
    try {
      const data = await api.exportAudit(query);
      downloadJson(data, 'audit.json');
    } catch (error) {
      toastError(error);
    } finally {
      setExporting(false);
    }
  };

  const exportAuditCsv = async (): Promise<void> => {
    setExportingCsv(true);
    try {
      const data = await api.exportAudit(query);
      const csv = toCsv(
        ['时间', '动作', '目标', '状态', '操作者', '主体类型', '耗时ms', '请求ID', '变更明细'],
        data.items.map((row) => [
          formatDateTime(row.createdAt),
          row.action,
          row.target ?? '',
          auditStatusLabel[row.status],
          row.actor,
          actorKindLabel[row.actorKind],
          row.durationMs ?? '',
          row.requestId ?? '',
          Object.entries(row.detail ?? {})
            .map(([key, value]) => `${key}=${value ?? ''}`)
            .join('; '),
        ]),
      );
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'audit.csv');
    } catch (error) {
      toastError(error);
    } finally {
      setExportingCsv(false);
    }
  };

  const verifyChain = async (): Promise<void> => {
    if (verifying) return;
    setVerifying(true);
    try {
      await toastPromise(
        async () => {
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
              throw new Error(
                `审计链校验失败：seq ${result.brokenSeq ?? '未知'} 处断链（已校验 ${checked} 条）`,
              );
            }
            if (result.complete || result.nextAfterSeq === null) {
              complete = true;
              break;
            }
            afterSeq = result.nextAfterSeq;
          }
          if (!complete) throw new Error(`校验未完成，已校验 ${checked} 条，请重试`);
          return checked;
        },
        {
          loading: '正在校验审计链完整性…',
          success: (checked) => `审计链完整，已校验 ${checked} 条记录`,
        },
      );
    } catch {
      return;
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
              <Button onClick={() => void audit.refetch()} disabled={audit.isFetching}>
                <RefreshCw
                  data-icon="inline-start"
                  className={audit.isFetching ? 'animate-spin' : undefined}
                  aria-hidden="true"
                />
                {audit.isFetching ? '刷新中…' : '刷新'}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="更多操作"
                      aria-busy={verifying || exporting || exportingCsv}
                    >
                      <EllipsisVertical aria-hidden="true" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" sideOffset={4} className="w-48">
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      disabled={verifying}
                      aria-busy={verifying}
                      onSelect={() => void verifyChain()}
                    >
                      <ShieldCheck aria-hidden="true" />
                      {verifying ? '校验中…' : '校验完整性'}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={exporting || searchPending}
                      aria-busy={exporting}
                      onSelect={() => void exportAudit()}
                    >
                      <Download aria-hidden="true" />
                      {exporting ? '导出中…' : searchPending ? '等待筛选…' : '导出审计 (JSON)'}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={exportingCsv || searchPending}
                      aria-busy={exportingCsv}
                      onSelect={() => void exportAuditCsv()}
                    >
                      <Download aria-hidden="true" />
                      {exportingCsv ? '导出中…' : searchPending ? '等待筛选…' : '导出 CSV'}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
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
          <FilterPopover activeCount={activeFilterCount}>
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
              className="w-full"
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
              className="w-full"
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
              className="w-full"
            />
            <FilterSelect
              value={status}
              onValueChange={(next) =>
                void navigate({
                  to: '/audit',
                  search: {
                    ...search,
                    status: next === 'all' ? undefined : (next as AuditStatus),
                  },
                })
              }
              options={statusOptions}
              label="按状态过滤"
              className="w-full"
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
              options={timeRangeOptions}
              label="按时间范围过滤"
              className="w-full"
            />
          </FilterPopover>
          <span role="status" className="ml-auto text-xs text-muted-foreground">
            {audit.isPending || searchPending
              ? '加载中…'
              : firstLoadFailed
                ? '数量不可用'
                : audit.hasNextPage
                  ? `已加载 ${rows.length} 条记录`
                  : `共 ${rows.length} 条记录`}
          </span>
        </PageToolbar>
        {!isFilteredEmpty && activeFilters.length > 0 ? (
          <ActiveFilterChips filters={activeFilters} onClearAll={clearFilters} />
        ) : null}
      </PageTopbar>

      <PageBody>
        {firstLoadFailed ? (
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
            {isFilteredEmpty ? (
              <EmptyState
                variant="filter"
                scale="section"
                title="没有符合条件的审计记录"
                activeFilters={activeFilters}
                action={
                  <Button variant="outline" size="sm" onClick={clearFilters}>
                    清除全部筛选
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
                storageKey="pace.audit.columns"
                hideRowCount
                empty={
                  <EmptyState
                    variant="idle"
                    scale="section"
                    icon={<ScrollText className="size-5" aria-hidden="true" />}
                    title="还没有审计日志"
                    description="账户登录、权限变更与关键配置修改会自动记录在这里。"
                  />
                }
                onRowClick={(row, trigger) => {
                  triggerRef.current = trigger;
                  setSelectedId(row.id);
                }}
              />
            )}
            <CursorListFooter
              query={audit}
              errorTitle="下一页加载失败，保留已加载的审计记录"
              disabled={audit.isFetching || searchPending}
              showEndLabel={rows.length > 0}
            />
          </>
        )}
      </PageBody>

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
        title={displayedRow?.action ?? '审计详情'}
        eyebrow={
          displayedRow ? (
            <StatusBadge tone={auditStatusVariant[displayedRow.status]}>
              {auditStatusLabel[displayedRow.status]}
            </StatusBadge>
          ) : null
        }
        description={displayedRow ? formatDateTime(displayedRow.createdAt) : undefined}
        finalFocus={() => (triggerRef.current?.isConnected ? triggerRef.current : null)}
      >
        {displayedRow ? (
          <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-fg">事件信息</h2>
              <dl className="grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5 text-xs">
                <dt className="text-muted-foreground">操作者</dt>
                <dd className="min-w-0 [overflow-wrap:anywhere] font-mono text-fg">
                  {displayedRow.actor}
                </dd>
                <dt className="text-muted-foreground">主体类型</dt>
                <dd className="min-w-0 text-fg">{actorKindLabel[displayedRow.actorKind]}</dd>
                <dt className="text-muted-foreground">目标</dt>
                <dd className="flex min-w-0 items-start justify-between gap-2">
                  {displayedRow.target ? (
                    <>
                      <span className="min-w-0 [overflow-wrap:anywhere] font-mono text-fg">
                        {displayedRow.target}
                      </span>
                      <CopyButton
                        value={displayedRow.target}
                        label="复制目标"
                        className="-my-1 -mr-1.5 shrink-0"
                      />
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </dd>
                <dt className="text-muted-foreground">耗时</dt>
                <dd className="min-w-0 font-mono tabular-nums text-fg">
                  {formatDuration(displayedRow.durationMs)}
                </dd>
                <dt className="text-muted-foreground">事件 ID</dt>
                <dd className="flex min-w-0 items-start justify-between gap-2">
                  <span className="min-w-0 [overflow-wrap:anywhere] font-mono text-fg">
                    {displayedRow.id}
                  </span>
                  <CopyButton
                    value={displayedRow.id}
                    label="复制事件 ID"
                    className="-my-1 -mr-1.5 shrink-0"
                  />
                </dd>
                <dt className="text-muted-foreground">请求 ID</dt>
                <dd className="flex min-w-0 items-start justify-between gap-2">
                  {displayedRow.requestId ? (
                    <>
                      <span className="min-w-0 [overflow-wrap:anywhere] font-mono text-fg">
                        {displayedRow.requestId}
                      </span>
                      <CopyButton
                        value={displayedRow.requestId}
                        label="复制请求 ID"
                        className="-my-1 -mr-1.5 shrink-0"
                      />
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </dd>
                <dt className="text-muted-foreground">输入摘要</dt>
                <dd className="flex min-w-0 items-start justify-between gap-2">
                  {displayedRow.inputDigest ? (
                    <>
                      <span className="min-w-0 [overflow-wrap:anywhere] font-mono text-fg">
                        {displayedRow.inputDigest}
                      </span>
                      <CopyButton
                        value={displayedRow.inputDigest}
                        label="复制输入摘要"
                        className="-my-1 -mr-1.5 shrink-0"
                      />
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </dd>
              </dl>
            </section>
            {detailEntries.length > 0 ? (
              <section className="flex flex-col gap-3 border-t border-line pt-5">
                <h2 className="text-sm font-medium text-fg">变更明细</h2>
                <dl className="grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5 text-xs">
                  {detailEntries.map(([key, value]) => (
                    <Fragment key={key}>
                      <dt className="text-muted-foreground">{detailLabels.get(key) ?? key}</dt>
                      <dd className="min-w-0 [overflow-wrap:anywhere] font-mono text-fg">
                        {value ?? <span className="text-muted-foreground">—</span>}
                      </dd>
                    </Fragment>
                  ))}
                </dl>
              </section>
            ) : null}
          </div>
        ) : null}
      </InspectorSheet>
    </Page>
  );
}
