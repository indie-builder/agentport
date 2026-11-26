import { useNavigate, useSearch } from '@tanstack/react-router';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { DialogShell } from '../../components/dialog-shell.js';
import { FilterSelect } from '../../components/filter-select.js';
import { PageSection, PageToolbar } from '../../components/page.js';
import { RecordRows } from '../../components/record-rows.js';
import {
  type EmptyFilterChip,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button } from '../../components/ui/button.js';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../../components/ui/card.js';
import { Dialog } from '../../components/ui/dialog.js';
import { Field, FieldDescription, FieldError, FieldLabel } from '../../components/ui/field.js';
import { Textarea } from '../../components/ui/textarea.js';
import type { DataDomainQueryApproval } from '../../lib/api.js';
import { errorMessage } from '../../lib/api.js';
import { guardedOpenChange, useDialogClose } from '../../lib/dialog-guard.js';
import { formatDateTime, shortId } from '../../lib/format.js';
import { useDataDomainQueryApprovals, useDecideDataDomainApproval } from '../../lib/queries.js';
import { toastSuccess } from '../../lib/toast.js';

const statusOptions = [
  { value: 'pending', label: '待审批' },
  { value: 'approved', label: '已批准' },
  { value: 'rejected', label: '已拒绝' },
  { value: 'all', label: '全部状态' },
];

const statusMeta: Record<
  DataDomainQueryApproval['status'],
  { label: string; tone: 'warn' | 'success' | 'outline' }
> = {
  pending: { label: '待审批', tone: 'warn' },
  approved: { label: '已批准', tone: 'success' },
  rejected: { label: '已拒绝', tone: 'outline' },
};

function DecisionDialog({
  dataDomainId,
  approval,
  decision,
  getReturnFocus,
  onClose,
}: {
  dataDomainId: string;
  approval: DataDomainQueryApproval;
  decision: 'approve' | 'reject';
  getReturnFocus: () => HTMLElement | null;
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClose);
  const decide = useDecideDataDomainApproval();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pending = decide.isPending;

  const submit = async (): Promise<void> => {
    if (pending) return;
    setError(null);
    try {
      await decide.mutateAsync({
        id: dataDomainId,
        approvalId: approval.id,
        decision,
        note: note.trim(),
      });
      toastSuccess(decision === 'approve' ? '已批准查询' : '已拒绝查询');
      dialog.finish(onClose);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(pending, dialog.close)}
    >
      <DialogShell
        title={decision === 'approve' ? '批准查询' : '拒绝查询'}
        description={`运行 ${shortId(approval.runId)} 发起的查询`}
        finalFocus={getReturnFocus}
        closeDisabled={pending}
        className="max-w-3xl sm:max-w-3xl"
        footer={
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={pending} onClick={dialog.close}>
              取消
            </Button>
            <Button
              type="button"
              variant={decision === 'reject' ? 'destructive' : 'default'}
              disabled={pending}
              aria-busy={pending}
              onClick={() => void submit()}
            >
              {pending ? '提交中…' : decision === 'approve' ? '批准' : '拒绝'}
            </Button>
          </div>
        }
      >
        <div className="flex min-w-0 flex-col gap-4">
          <Field data-disabled={pending} data-invalid={Boolean(error)}>
            <FieldLabel htmlFor="data-domain-approval-note">决策说明</FieldLabel>
            <Textarea
              id="data-domain-approval-note"
              rows={3}
              maxLength={2000}
              disabled={pending}
              placeholder="可选，说明批准或拒绝的原因"
              aria-invalid={Boolean(error)}
              aria-describedby={
                error ? 'data-domain-approval-note-error' : 'data-domain-approval-note-hint'
              }
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            <FieldDescription id="data-domain-approval-note-hint">
              会记录在审批历史中，最长 2000 个字符。
            </FieldDescription>
            <FieldError id="data-domain-approval-note-error">{error}</FieldError>
          </Field>
          <Field>
            <FieldLabel>SQL</FieldLabel>
            <pre className="max-h-60 max-w-full overflow-y-auto overscroll-contain rounded-lg bg-chip p-3 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-fg">
              {approval.sqlText}
            </pre>
          </Field>
        </div>
      </DialogShell>
    </Dialog>
  );
}

export function DataDomainApprovals({
  dataDomainId,
  canUpdate,
}: {
  dataDomainId: string;
  canUpdate: boolean;
}) {
  const search = useSearch({ from: '/_shell/data-domains/$dataDomainId' });
  const navigate = useNavigate();
  const status = search.approvalStatus ?? 'pending';
  const approvals = useDataDomainQueryApprovals(dataDomainId, {
    limit: 50,
    ...(status === 'all' ? {} : { status }),
  });
  const rows = approvals.data?.pages.flatMap((page) => page.items) ?? [];
  const [deciding, setDeciding] = useState<{
    approval: DataDomainQueryApproval;
    decision: 'approve' | 'reject';
    trigger: HTMLElement;
  } | null>(null);
  const filtered = status !== 'pending';

  const setStatus = (next: string): void => {
    void navigate({
      to: '/data-domains/$dataDomainId',
      params: { dataDomainId },
      search: {
        ...search,
        approvalStatus: next === 'pending' ? undefined : (next as 'all' | 'approved' | 'rejected'),
      },
      replace: true,
    });
  };

  return (
    <PageSection
      title="查询审批"
      description="开启「每次查询需审批」后，查询会先进入这里等待处理；批准后需在同一运行中重新发起相同 SQL（按 trim 后 SHA-256 匹配）才会执行。"
    >
      <PageToolbar>
        <FilterSelect
          value={status}
          onValueChange={setStatus}
          options={statusOptions}
          label="按审批状态过滤"
          className="w-36"
        />
        <Button
          variant="outline"
          onClick={() => void approvals.refetch()}
          disabled={approvals.isFetching}
          aria-label="刷新审批列表"
        >
          <RefreshCw
            data-icon="inline-start"
            className={approvals.isFetching ? 'animate-spin' : undefined}
            aria-hidden="true"
          />
          {approvals.isFetching ? '刷新中…' : '刷新'}
        </Button>
      </PageToolbar>
      {approvals.isPending ? <LoadingState rows={3} /> : null}
      {approvals.isError && !approvals.data ? (
        <ErrorState error={approvals.error} onRetry={() => void approvals.refetch()} />
      ) : null}
      {filtered && !approvals.isPending && rows.length === 0 ? (
        <EmptyState
          variant="filter"
          scale="section"
          title="没有符合条件的记录"
          activeFilters={
            [
              {
                key: 'status',
                label: '状态',
                value: statusOptions.find((option) => option.value === status)?.label ?? status,
                onRemove: () => setStatus('pending'),
              },
            ] satisfies EmptyFilterChip[]
          }
          action={
            <Button variant="outline" size="sm" onClick={() => setStatus('pending')}>
              清除筛选
            </Button>
          }
        />
      ) : null}
      {!filtered && approvals.data && rows.length === 0 ? (
        <EmptyState
          variant="clear"
          scale="section"
          icon={<ShieldCheck aria-hidden="true" />}
          title="没有待审批的查询"
          description="命中高危或越权策略的查询会在此排队。"
        />
      ) : null}
      {rows.length > 0 ? (
        <ul aria-label="查询审批记录" className="grid grid-cols-1 gap-4 pt-2 xl:grid-cols-2">
          {rows.map((approval) => {
            const meta = statusMeta[approval.status];
            return (
              <li key={approval.id} className="min-w-0">
                <Card size="sm" className="h-full">
                  <CardHeader>
                    <CardTitle className="min-w-0 font-mono text-sm text-fg [overflow-wrap:anywhere]">
                      {approval.actorBusinessId ?? '—'}
                    </CardTitle>
                    <CardAction>
                      <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
                    </CardAction>
                    {approval.decisionNote ? (
                      <CardDescription className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
                        {approval.decisionNote}
                      </CardDescription>
                    ) : null}
                  </CardHeader>
                  <CardContent className="flex min-w-0 flex-col gap-3">
                    <RecordRows
                      rows={[
                        {
                          label: '运行',
                          value: shortId(approval.runId),
                          mono: true,
                          title: approval.runId,
                        },
                        { label: '请求时间', value: formatDateTime(approval.requestedAt) },
                        ...(approval.decidedAt
                          ? [{ label: '决策时间', value: formatDateTime(approval.decidedAt) }]
                          : []),
                      ]}
                    />
                    <pre className="max-h-40 overflow-auto rounded-item bg-code p-3 font-mono text-xs whitespace-pre-wrap break-words text-fg">
                      {approval.sqlText}
                    </pre>
                  </CardContent>
                  {approval.status === 'pending' && canUpdate ? (
                    <CardFooter className="justify-end gap-2">
                      <Button
                        size="sm"
                        onClick={(event) =>
                          setDeciding({
                            approval,
                            decision: 'approve',
                            trigger: event.currentTarget,
                          })
                        }
                      >
                        批准
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(event) =>
                          setDeciding({
                            approval,
                            decision: 'reject',
                            trigger: event.currentTarget,
                          })
                        }
                      >
                        拒绝
                      </Button>
                    </CardFooter>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      ) : null}
      {approvals.isFetchNextPageError ? (
        <ErrorState
          error={approvals.error}
          onRetry={() => void approvals.fetchNextPage()}
          title="下一页加载失败，保留已加载的审批记录"
        />
      ) : approvals.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            disabled={approvals.isFetching}
            onClick={() => void approvals.fetchNextPage()}
          >
            {approvals.isFetchingNextPage ? '加载中…' : '加载更多'}
          </Button>
        </div>
      ) : rows.length > 0 ? (
        <div className="text-center text-xs text-muted-foreground">已到末尾</div>
      ) : null}

      {deciding ? (
        <DecisionDialog
          dataDomainId={dataDomainId}
          approval={deciding.approval}
          decision={deciding.decision}
          getReturnFocus={() => (deciding.trigger.isConnected ? deciding.trigger : null)}
          onClose={() => setDeciding(null)}
        />
      ) : null}
    </PageSection>
  );
}
