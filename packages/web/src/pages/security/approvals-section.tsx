import type { PolicyApproval, PolicyApprovalStatus } from '@agentport/shared';
import { Link, useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowUpRight, ShieldCheck } from 'lucide-react';
import { type ComponentProps, useCallback, useMemo, useRef, useState } from 'react';
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
import { Button } from '../../components/ui/button.js';
import { Field, FieldError, FieldLabel } from '../../components/ui/field.js';
import { Textarea } from '../../components/ui/textarea.js';
import { errorMessage } from '../../lib/api.js';
import { useDialogClose } from '../../lib/dialog-guard.js';
import { formatDateTime, formatRelative, shortId } from '../../lib/format.js';
import { useDecideSecurityApproval, useSecurityApprovals } from '../../lib/queries.js';
import { toastSuccess } from '../../lib/toast.js';
import {
  APPROVAL_STATUS_LABEL,
  APPROVAL_STATUS_OPTIONS,
  approvalStatusTone,
  SOURCE_LABEL,
} from './shared.js';

export function ApprovalsSection({ canManage }: { canManage: boolean }) {
  const search = useSearch({ from: '/_shell/security' });
  const navigate = useNavigate({ from: '/security' });
  const location = useLocation();
  const status = search.approvalStatus ?? 'pending';
  const approvals = useSecurityApprovals(status);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const snapshotRef = useRef<PolicyApproval | null>(null);
  const rows = approvals.data?.pages.flatMap((page) => page.items) ?? [];

  const liveApproval = selectedId ? (rows.find((row) => row.id === selectedId) ?? null) : null;
  if (liveApproval) snapshotRef.current = liveApproval;
  const activeApproval = liveApproval ?? snapshotRef.current;

  const backTo = `${location.pathname}${location.searchStr}`;

  const clearFilters = () => {
    void navigate({
      to: '/security',
      search: { ...search, approvalStatus: undefined },
      replace: true,
    });
  };

  const activeFilters: EmptyFilterChip[] =
    status === 'pending'
      ? []
      : [
          {
            key: 'approvalStatus',
            label: '审批状态',
            value: APPROVAL_STATUS_LABEL[status],
            onRemove: clearFilters,
          },
        ];

  const isFilteredEmpty = Boolean(approvals.data) && rows.length === 0 && activeFilters.length > 0;

  const openInspector = useCallback((approval: PolicyApproval, trigger: HTMLElement) => {
    triggerRef.current = trigger;
    snapshotRef.current = approval;
    setSelectedId(approval.id);
  }, []);

  const columns = useMemo<DataColumn<PolicyApproval>[]>(
    () => [
      {
        id: 'requestedAt',
        header: '请求时间',
        locked: true,
        width: '112px',
        sortValue: (approval) => approval.requestedAt,
        cell: (approval) => (
          <span
            className="font-mono tabular-nums text-muted-foreground"
            title={formatDateTime(approval.requestedAt)}
          >
            {formatRelative(approval.requestedAt)}
          </span>
        ),
      },
      {
        id: 'policy',
        header: '策略',
        width: 'minmax(150px,1.3fr)',
        sortValue: (approval) => approval.policyName,
        cell: (approval) => (
          <span className="flex min-w-0 flex-col">
            <span
              className="block overflow-hidden text-ellipsis whitespace-nowrap font-medium text-fg"
              title={approval.policyName}
            >
              {approval.policyName}
            </span>
            <span className="text-xs text-muted-foreground">v{approval.policyVersion}</span>
          </span>
        ),
      },
      {
        id: 'requestedBy',
        header: '申请人',
        width: 'minmax(110px,1fr)',
        cell: (approval) => (
          <span
            className="block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-fg"
            title={approval.requestedBy}
          >
            {approval.requestedBy}
          </span>
        ),
      },
      {
        id: 'destination',
        header: '目标',
        width: 'minmax(120px,1fr)',
        cell: (approval) =>
          approval.destination ? (
            <span
              className="block overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground"
              title={approval.destination}
            >
              {approval.destination}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'status',
        header: '状态',
        width: '88px',
        cell: (approval) => (
          <StatusBadge tone={approvalStatusTone(approval.status)}>
            {APPROVAL_STATUS_LABEL[approval.status]}
          </StatusBadge>
        ),
      },
      {
        id: 'source',
        header: '来源',
        width: '96px',
        hiddenByDefault: true,
        cell: (approval) => SOURCE_LABEL[approval.sourceKind],
      },
      {
        id: 'expiresAt',
        header: '到期时间',
        width: '112px',
        hiddenByDefault: true,
        sortValue: (approval) => approval.expiresAt,
        cell: (approval) => (
          <span
            className="font-mono text-xs tabular-nums text-muted-foreground"
            title={formatDateTime(approval.expiresAt)}
          >
            {formatRelative(approval.expiresAt)}
          </span>
        ),
      },
      {
        id: 'decidedBy',
        header: '决策人',
        width: 'minmax(100px,1fr)',
        hiddenByDefault: true,
        cell: (approval) =>
          approval.decidedBy ? (
            <span
              className="block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-fg"
              title={approval.decidedBy}
            >
              {approval.decidedBy}
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
        cell: (approval) =>
          approval.runId ? (
            <code className="font-mono text-xs text-muted-foreground" title={approval.runId}>
              {shortId(approval.runId)}
            </code>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'payloadHash',
        header: '载荷哈希',
        width: 'minmax(120px,1fr)',
        hiddenByDefault: true,
        cell: (approval) => (
          <span
            className="block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-muted-foreground"
            title={approval.payloadHash}
          >
            {approval.payloadHash}
          </span>
        ),
      },
      {
        id: 'actions',
        header: '操作',
        width: '80px',
        align: 'end',
        cell: (approval) => (
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              aria-label={`查看审批 ${approval.policyName} · ${approval.requestedBy}`}
              onClick={(event) => openInspector(approval, event.currentTarget)}
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
          value={status}
          onValueChange={(next) =>
            void navigate({
              to: '/security',
              search: {
                ...search,
                approvalStatus: next === 'pending' ? undefined : (next as PolicyApprovalStatus),
              },
              replace: true,
            })
          }
          options={APPROVAL_STATUS_OPTIONS}
          label="按审批状态筛选"
          className="w-36"
        />
        <span role="status" className="ml-auto text-xs tabular-nums text-muted-foreground">
          {approvals.isPending
            ? '加载中…'
            : approvals.isError
              ? '数量不可用'
              : approvals.hasNextPage
                ? `已加载 ${rows.length} 条审批`
                : `共 ${rows.length} 条审批`}
        </span>
      </div>

      {!isFilteredEmpty && activeFilters.length > 0 ? (
        <ActiveFilterChips filters={activeFilters} onClearAll={clearFilters} />
      ) : null}

      {approvals.isPending ? <LoadingState rows={4} /> : null}
      {approvals.isError ? (
        <ErrorState
          error={approvals.error}
          onRetry={() => void approvals.refetch()}
          title="审批列表没有加载出来"
        />
      ) : null}
      {approvals.data && rows.length === 0 ? (
        status === 'pending' ? (
          <EmptyState
            variant="clear"
            scale="section"
            icon={<ShieldCheck className="size-5" aria-hidden="true" />}
            title="没有待审批的外发内容"
            description="命中人工审批策略的请求会在此排队。"
          />
        ) : (
          <EmptyState
            variant="filter"
            scale="section"
            title={`没有${APPROVAL_STATUS_LABEL[status]}的外发审批`}
            activeFilters={activeFilters}
            action={
              <Button variant="outline" size="sm" onClick={clearFilters}>
                查看待审批
              </Button>
            }
          />
        )
      ) : null}
      {rows.length > 0 ? (
        <>
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(approval) => approval.id}
            rowLabel={(approval) => `${approval.policyName} · ${approval.requestedBy}`}
            label="外发审批"
            storageKey="pace.security.approvals-columns"
            hideRowCount
            onRowClick={openInspector}
          />
          <CursorListFooter
            query={approvals}
            errorTitle="下一页加载失败，保留已加载的记录"
            showEndLabel
          />
        </>
      ) : null}

      {selectedId && activeApproval ? (
        <ApprovalInspectorSheet
          key={selectedId}
          approval={activeApproval}
          canManage={canManage}
          backTo={backTo}
          finalFocus={() => (triggerRef.current?.isConnected ? triggerRef.current : null)}
          onClosed={() => {
            setSelectedId(null);
            snapshotRef.current = null;
          }}
        />
      ) : null}
    </div>
  );
}

function ApprovalInspectorSheet({
  approval,
  canManage,
  backTo,
  finalFocus,
  onClosed,
}: {
  approval: PolicyApproval;
  canManage: boolean;
  backTo: string;
  finalFocus: ComponentProps<typeof InspectorSheet>['finalFocus'];
  onClosed: () => void;
}) {
  const sheet = useDialogClose(onClosed);
  const decide = useDecideSecurityApproval();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pending = decide.isPending;
  const actionable = canManage && approval.status === 'pending';

  const submit = async (decision: 'approve' | 'reject'): Promise<void> => {
    if (pending) return;
    setError(null);
    try {
      await decide.mutateAsync({
        id: approval.id,
        input: { decision, ...(note.trim() ? { note: note.trim() } : {}) },
      });
      toastSuccess(decision === 'approve' ? '已批准' : '已拒绝');
      sheet.close();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <InspectorSheet
      open={sheet.open}
      onOpenChange={(next) => {
        if (!next && !pending) sheet.close();
      }}
      onOpenChangeComplete={sheet.onOpenChangeComplete}
      size="md"
      title={approval.policyName}
      eyebrow={
        <StatusBadge tone={approvalStatusTone(approval.status)}>
          {APPROVAL_STATUS_LABEL[approval.status]}
        </StatusBadge>
      }
      description={`v${approval.policyVersion} · 请求于 ${formatDateTime(approval.requestedAt)}`}
      closeDisabled={pending}
      finalFocus={finalFocus}
      footer={
        actionable ? (
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" disabled={pending} onClick={sheet.close}>
              关闭
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={pending}
              aria-busy={pending}
              data-agent-confirm="拒绝这条外发审批请求"
              onClick={() => void submit('reject')}
            >
              拒绝
            </Button>
            <Button
              size="sm"
              disabled={pending}
              aria-busy={pending}
              data-agent-confirm="批准这条外发审批请求"
              onClick={() => void submit('approve')}
            >
              批准
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-fg">请求上下文</h2>
          <dl className="grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5 text-xs">
            <dt className="text-muted-foreground">审批 ID</dt>
            <dd className="flex min-w-0 items-start justify-between gap-2">
              <span className="min-w-0 font-mono text-fg [overflow-wrap:anywhere]">
                {approval.id}
              </span>
              <CopyButton
                value={approval.id}
                label="复制审批 ID"
                className="-my-1 -mr-1.5 shrink-0"
              />
            </dd>
            <dt className="text-muted-foreground">命中策略</dt>
            <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">
              {approval.policyName}{' '}
              <span className="font-mono text-muted-foreground">v{approval.policyVersion}</span>
            </dd>
            <dt className="text-muted-foreground">来源</dt>
            <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">
              {SOURCE_LABEL[approval.sourceKind]}
              <span className="ml-2 font-mono text-muted-foreground">{approval.sourceId}</span>
            </dd>
            <dt className="text-muted-foreground">目标</dt>
            <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">
              {approval.destination ?? <span className="text-muted-foreground">—</span>}
            </dd>
            <dt className="text-muted-foreground">申请人</dt>
            <dd className="min-w-0 font-mono text-fg [overflow-wrap:anywhere]">
              {approval.requestedBy}
            </dd>
            <dt className="text-muted-foreground">请求时间</dt>
            <dd className="min-w-0 font-mono tabular-nums text-fg">
              {formatDateTime(approval.requestedAt)}
            </dd>
            <dt className="text-muted-foreground">到期时间</dt>
            <dd className="min-w-0 font-mono tabular-nums text-fg">
              {formatDateTime(approval.expiresAt)}
            </dd>
            <dt className="text-muted-foreground">关联运行</dt>
            <dd className="flex min-w-0 items-start justify-between gap-2">
              {approval.runId ? (
                <>
                  <Link
                    to="/runs/$runId"
                    params={{ runId: approval.runId }}
                    search={{ backTo }}
                    className="inline-flex min-w-0 items-center gap-1 font-mono text-link underline underline-offset-4 hover:text-fg"
                  >
                    <span className="[overflow-wrap:anywhere]">{approval.runId}</span>
                    <ArrowUpRight className="size-3.5 shrink-0" aria-hidden="true" />
                  </Link>
                  <CopyButton
                    value={approval.runId}
                    label="复制运行 ID"
                    className="-my-1 -mr-1.5 shrink-0"
                  />
                </>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </dd>
            {approval.channelId ? (
              <>
                <dt className="text-muted-foreground">关联频道</dt>
                <dd className="min-w-0 font-mono text-fg [overflow-wrap:anywhere]">
                  {approval.channelId}
                </dd>
              </>
            ) : null}
            {approval.consumedAt ? (
              <>
                <dt className="text-muted-foreground">消费时间</dt>
                <dd className="min-w-0 font-mono tabular-nums text-fg">
                  {formatDateTime(approval.consumedAt)}
                </dd>
              </>
            ) : null}
          </dl>
        </section>

        <section className="flex flex-col gap-2 border-t border-line pt-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-fg">载荷哈希</h2>
            <CopyButton
              value={approval.payloadHash}
              label="复制载荷哈希"
              className="-my-1 -mr-1.5 shrink-0"
            />
          </div>
          <pre className="overflow-x-auto rounded-item border border-code-line bg-code p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
            {approval.payloadHash}
          </pre>
        </section>

        {approval.decidedBy || approval.decidedAt || approval.note ? (
          <section className="flex flex-col gap-3 border-t border-line pt-5">
            <h2 className="text-sm font-medium text-fg">决策记录</h2>
            <dl className="grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5 text-xs">
              {approval.decidedBy ? (
                <>
                  <dt className="text-muted-foreground">决策人</dt>
                  <dd className="min-w-0 font-mono text-fg [overflow-wrap:anywhere]">
                    {approval.decidedBy}
                  </dd>
                </>
              ) : null}
              {approval.decidedAt ? (
                <>
                  <dt className="text-muted-foreground">决策时间</dt>
                  <dd className="min-w-0 font-mono tabular-nums text-fg">
                    {formatDateTime(approval.decidedAt)}
                  </dd>
                </>
              ) : null}
              {approval.note ? (
                <>
                  <dt className="text-muted-foreground">审批说明</dt>
                  <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">{approval.note}</dd>
                </>
              ) : null}
            </dl>
          </section>
        ) : null}

        {actionable ? (
          <section className="flex flex-col gap-3 border-t border-line pt-5">
            <h2 className="text-sm font-medium text-fg">审批决策</h2>
            <Field data-invalid={Boolean(error)} data-disabled={pending}>
              <FieldLabel htmlFor="approval-note">备注</FieldLabel>
              <Textarea
                id="approval-note"
                rows={3}
                maxLength={500}
                placeholder="可选，填写批准或拒绝原因…"
                disabled={pending}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <FieldError>{error ?? undefined}</FieldError>
            </Field>
          </section>
        ) : null}
      </div>
    </InspectorSheet>
  );
}
