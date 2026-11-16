import { dataDomainEnrichInputSchema } from '@agentport/contract/data-domains';
import { CircleAlert, CircleCheck, Eye, LoaderCircle, Sparkles, XCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useController } from 'react-hook-form';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { DialogShell } from '../../components/dialog-shell.js';
import { PageNote } from '../../components/page.js';
import { ErrorState, LoadingState } from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import { Field, FieldDescription, FieldError, FieldLabel } from '../../components/ui/field.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Textarea } from '../../components/ui/textarea.js';
import type { DataDomainEnrichmentProposal, DataDomainVersion } from '../../lib/api.js';
import { guardedOpenChange, useDialogClose } from '../../lib/dialog-guard.js';
import { useFormBlocker } from '../../lib/form.js';
import { formatRelative, shortId } from '../../lib/format.js';
import {
  useDataDomainEnrichmentProposal,
  useDataDomainEnrichmentProposals,
  useDecideDataDomainEnrichmentProposal,
  useEnrichDataDomain,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';

type ProposalStatus = DataDomainEnrichmentProposal['status'];
type Tone = 'default' | 'success' | 'warn' | 'brand' | 'danger' | 'outline';

const proposalStatusMeta: Record<
  ProposalStatus,
  { label: string; tone: Tone; icon: typeof CircleCheck; spin?: boolean }
> = {
  generating: { label: '生成中', tone: 'brand', icon: LoaderCircle, spin: true },
  ready: { label: '待审核', tone: 'default', icon: CircleCheck },
  approved: { label: '已批准', tone: 'success', icon: CircleCheck },
  rejected: { label: '已拒绝', tone: 'outline', icon: XCircle },
  failed: { label: '失败', tone: 'danger', icon: CircleAlert },
};

const changeStatusMeta: Record<'added' | 'modified' | 'removed', { label: string; tone: Tone }> = {
  added: { label: '新增', tone: 'success' },
  modified: { label: '修改', tone: 'default' },
  removed: { label: '删除', tone: 'danger' },
};

function ProposalStatusBadge({ status }: { status: ProposalStatus }) {
  const meta = proposalStatusMeta[status];
  const Icon = meta.icon;
  return (
    <StatusBadge tone={meta.tone}>
      <Icon className={meta.spin ? 'animate-spin' : undefined} aria-hidden="true" />
      {meta.label}
    </StatusBadge>
  );
}

function ChangedFileStatusBadge({ status }: { status: 'added' | 'modified' | 'removed' }) {
  const meta = changeStatusMeta[status];
  return <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>;
}

export function DataDomainEnrichment({
  dataDomainId,
  readyVersions,
  canBuild,
}: {
  dataDomainId: string;
  readyVersions: DataDomainVersion[];
  canBuild: boolean;
}) {
  const proposals = useDataDomainEnrichmentProposals(dataDomainId);
  const enrich = useEnrichDataDomain();
  const decide = useDecideDataDomainEnrichmentProposal();
  const [viewing, setViewing] = useState<string | null>(null);
  const viewTriggerRef = useRef<HTMLElement | null>(null);
  const detail = useDataDomainEnrichmentProposal(dataDomainId, viewing ?? '', viewing !== null);
  const dialog = useDialogClose(() => setViewing(null), viewing !== null);
  const orderedVersions = useMemo(
    () =>
      [...readyVersions].sort(
        (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
      ),
    [readyVersions],
  );
  const form = useZodForm(dataDomainEnrichInputSchema, {
    defaultValues: {
      sourceVersionId: orderedVersions[0]?.id ?? '',
      instruction: '',
    },
  });
  const { control, register, handleSubmit, reset, watch, formState } = form;
  const { errors } = formState;
  const { field: sourceVersionField } = useController({ control, name: 'sourceVersionId' });
  const sourceVersionId = sourceVersionField.value;
  const instruction = watch('instruction');
  const noReadyVersions = orderedVersions.length === 0;
  const pending = enrich.isPending;
  const blockerPending = pending || decide.isPending;
  const blocker = useFormBlocker(formState.isDirty, blockerPending, { ignoreSamePath: true });

  useEffect(() => {
    if (orderedVersions.length === 0) return;
    if (orderedVersions.some((version) => version.id === sourceVersionId)) return;
    reset(
      { sourceVersionId: orderedVersions[0]?.id ?? '', instruction: '' },
      { keepDirty: formState.isDirty, keepDirtyValues: true, keepErrors: true },
    );
  }, [orderedVersions, sourceVersionId, reset, formState.isDirty]);

  const submit = handleSubmit(async (values) => {
    try {
      await enrich.mutateAsync({ id: dataDomainId, input: values });
      toastSuccess('已提交生成提案');
      reset({ sourceVersionId: values.sourceVersionId, instruction: '' });
    } catch (error) {
      toastError(error);
    }
  });

  const decideProposal = (decision: 'approve' | 'reject'): void => {
    if (viewing === null) return;
    decide.mutate(
      { id: dataDomainId, proposalId: viewing, decision },
      {
        onSuccess: (result) => {
          dialog.close();
          toastSuccess(
            decision === 'approve'
              ? result.version
                ? `已批准，已创建版本 ${shortId(result.version.id)}`
                : '已批准'
              : '已拒绝',
          );
        },
        onError: (error) => toastError(error),
      },
    );
  };

  const detailStatus = detail.data?.status;
  const showDecision = detailStatus === 'ready' && canBuild;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {canBuild ? (
        <form className="flex min-w-0 flex-col gap-4" onSubmit={submit}>
          <Field data-disabled={pending} data-invalid={Boolean(errors.sourceVersionId)}>
            <FieldLabel htmlFor="data-domain-enrich-source">源版本</FieldLabel>
            <Select
              value={sourceVersionId === '' ? null : sourceVersionId}
              disabled={pending || noReadyVersions}
              onValueChange={(value) => {
                if (value !== null) sourceVersionField.onChange(value);
              }}
            >
              <SelectTrigger
                id="data-domain-enrich-source"
                ref={sourceVersionField.ref}
                onBlur={sourceVersionField.onBlur}
                className="w-full min-w-0"
                aria-invalid={Boolean(errors.sourceVersionId)}
                aria-describedby={
                  errors.sourceVersionId ? 'data-domain-enrich-source-error' : undefined
                }
              >
                <SelectValue placeholder="选择就绪版本" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {orderedVersions.map((version) => (
                    <SelectItem key={version.id} value={version.id}>
                      {shortId(version.id)} · {formatRelative(version.createdAt)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {noReadyVersions ? (
              <FieldDescription>需先有就绪版本才能生成提案。</FieldDescription>
            ) : null}
            <FieldError id="data-domain-enrich-source-error">
              {errors.sourceVersionId?.message}
            </FieldError>
          </Field>
          <Field data-disabled={pending} data-invalid={Boolean(errors.instruction)}>
            <FieldLabel htmlFor="data-domain-enrich-instruction">生成指令</FieldLabel>
            <Textarea
              id="data-domain-enrich-instruction"
              rows={3}
              maxLength={4000}
              disabled={pending}
              placeholder="例如：补充模型的业务含义、常用指标口径与示例查询"
              aria-invalid={Boolean(errors.instruction)}
              aria-describedby={
                errors.instruction ? 'data-domain-enrich-instruction-error' : undefined
              }
              {...register('instruction')}
            />
            <FieldError id="data-domain-enrich-instruction-error">
              {errors.instruction?.message}
            </FieldError>
          </Field>
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              disabled={pending || noReadyVersions || instruction.trim() === ''}
              aria-busy={pending}
            >
              <Sparkles data-icon="inline-start" />
              {pending ? '提交中…' : '生成提案'}
            </Button>
          </div>
        </form>
      ) : null}

      {proposals.isPending ? <LoadingState rows={3} /> : null}
      {proposals.isError ? (
        <ErrorState error={proposals.error} onRetry={() => void proposals.refetch()} />
      ) : null}
      {proposals.data?.length === 0 ? (
        <PageNote icon={<Sparkles className="size-4" aria-hidden="true" />} title="还没有提案" />
      ) : null}
      {proposals.data && proposals.data.length > 0 ? (
        <ul aria-label="语义补全提案" className="border-t">
          {proposals.data.map((proposal) => (
            <li
              key={proposal.id}
              className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b py-2.5 last:border-b-0"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <ProposalStatusBadge status={proposal.status} />
                  <span className="min-w-0 break-words text-sm text-fg">
                    {proposal.summary || '—'}
                  </span>
                </div>
                {proposal.status === 'failed' && proposal.error ? (
                  <p className="min-w-0 break-words text-sm text-danger">{proposal.error}</p>
                ) : null}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <code className="font-mono">{shortId(proposal.sourceVersionId)}</code>
                  <span>{formatRelative(proposal.createdAt)}</span>
                </div>
              </div>
              {proposal.status === 'ready' ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={(event) => {
                    viewTriggerRef.current = event.currentTarget;
                    setViewing(proposal.id);
                  }}
                >
                  <Eye data-icon="inline-start" /> 查看差异
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {viewing ? (
        <Dialog
          open={dialog.open}
          onOpenChange={guardedOpenChange(decide.isPending, dialog.close)}
          onOpenChangeComplete={dialog.onOpenChangeComplete}
        >
          <DialogShell
            title={`提案差异 · ${shortId(viewing)}`}
            closeDisabled={decide.isPending}
            finalFocus={() => (viewTriggerRef.current?.isConnected ? viewTriggerRef.current : null)}
            className="max-w-3xl sm:max-w-3xl"
            footer={
              showDecision ? (
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    disabled={decide.isPending}
                    aria-busy={decide.isPending && decide.variables?.decision === 'reject'}
                    onClick={() => decideProposal('reject')}
                  >
                    {decide.isPending && decide.variables?.decision === 'reject'
                      ? '处理中…'
                      : '拒绝'}
                  </Button>
                  <Button
                    disabled={decide.isPending}
                    aria-busy={decide.isPending && decide.variables?.decision === 'approve'}
                    onClick={() => decideProposal('approve')}
                  >
                    {decide.isPending && decide.variables?.decision === 'approve'
                      ? '处理中…'
                      : '批准'}
                  </Button>
                </div>
              ) : undefined
            }
          >
            {detail.isPending ? <LoadingState rows={3} /> : null}
            {detail.isError ? (
              <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
            ) : null}
            {detail.data ? (
              <div className="flex min-w-0 flex-col gap-4">
                <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                  <span>
                    源版本 <code className="font-mono">{shortId(detail.data.sourceVersionId)}</code>
                  </span>
                </div>
                {detail.data.changedFiles.length === 0 ? (
                  <PageNote title="没有文件变更" />
                ) : (
                  <div className="flex min-w-0 flex-col gap-4">
                    {detail.data.changedFiles.map((change) => {
                      const content = detail.data?.projectFiles[change.path];
                      return (
                        <div key={change.path} className="flex min-w-0 flex-col gap-2">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <code className="min-w-0 break-all font-mono text-xs text-fg">
                              {change.path}
                            </code>
                            <ChangedFileStatusBadge status={change.status} />
                          </div>
                          {change.status !== 'removed' && content !== undefined ? (
                            <pre className="max-h-72 max-w-full overflow-y-auto overscroll-contain rounded-lg bg-chip p-3 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-fg">
                              {content}
                            </pre>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : null}
          </DialogShell>
        </Dialog>
      ) : null}

      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onClose={() => blocker.reset?.()}
        title="放弃未保存的更改？"
        description={
          blockerPending ? '正在提交，请等待请求完成。' : '离开后已填写的生成指令会丢失。'
        }
        confirmLabel="放弃并离开"
        confirmDisabled={blockerPending}
        onConfirm={async () => blocker.proceed()}
      />
    </div>
  );
}
