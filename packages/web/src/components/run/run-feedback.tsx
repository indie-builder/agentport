import {
  type OutputFile,
  type RunFeedbackDecision,
  submitRunFeedbackSchema,
} from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { authenticated } from '../../lib/access.js';
import { guardedOpenChange, useDialogClose } from '../../lib/dialog-guard.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { meQuery, useRunFeedback, useSubmitRunFeedback } from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';
import { DialogShell } from '../dialog-shell.js';
import { DraftGuardDialogs, useDraftGuard } from '../draft-guard.js';
import { RequiredMark } from '../required-mark.js';
import { ErrorState, LoadingState } from '../states.js';
import { StatusBadge } from '../status-badge.js';
import { Button } from '../ui/button.js';
import { Dialog } from '../ui/dialog.js';
import { Field, FieldError, FieldGroup, FieldLabel, FieldTitle } from '../ui/field.js';
import { Rating, RatingItem } from '../ui/rating.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select.js';
import { Textarea } from '../ui/textarea.js';
import { EvalFromRunDialog } from './eval-from-run-dialog.js';

const DECISION_LABEL: Record<RunFeedbackDecision, string> = {
  accepted: '已采纳',
  rejected: '已退回',
};

function RatingStars({ rating }: { rating: number }) {
  return (
    <Rating
      value={rating}
      readOnly
      gap="xs"
      getValueLabel={(value, max) => `评分 ${value} 分，满分 ${max} 分`}
    >
      <RatingItem className="size-3 [&_svg:not([class*='size-'])]:size-3" />
    </Rating>
  );
}

function FeedbackDialog({
  runId,
  decision,
  messageId,
  files,
  defaultOutputPath,
  onClose: onClosed,
}: {
  runId: string;
  decision: RunFeedbackDecision;
  messageId: string | null;
  files: OutputFile[];
  defaultOutputPath: string | null;
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const submitFeedback = useSubmitRunFeedback();
  const form = useZodForm(submitRunFeedbackSchema, {
    defaultValues: { decision, rating: null, comment: '', reason: '' },
  });
  const { errors } = form.formState;
  const rating = form.watch('rating');
  const pending = submitFeedback.isPending;
  const guard = useDraftGuard(form.formState.isDirty, pending, dialog.close);
  const formId = `run-feedback-${runId}`;
  const filePaths = files.map((file) => file.path);
  const onlyPath = filePaths.length === 1 ? filePaths[0] : undefined;
  const targets = [
    { value: 'run', label: '整轮运行' },
    ...(messageId === null ? [] : [{ value: 'message', label: '助手回复' }]),
    ...filePaths.map((path) => ({ value: `file:${path}`, label: `成果 ${path}` })),
  ];
  const [target, setTarget] = useState(() =>
    defaultOutputPath !== null && filePaths.includes(defaultOutputPath)
      ? `file:${defaultOutputPath}`
      : onlyPath === undefined
        ? 'run'
        : `file:${onlyPath}`,
  );

  const submit = form.handleSubmit((values) => {
    if (pending) return;
    const anchor =
      target === 'message'
        ? messageId === null
          ? {}
          : { messageId }
        : target.startsWith('file:')
          ? { outputPath: target.slice('file:'.length) }
          : {};
    submitFeedback.mutate(
      { runId, ...values, ...anchor },
      {
        onSuccess: () => {
          toastSuccess(decision === 'accepted' ? '已采纳本次成果' : '已退回本次成果');
          guard.finish();
        },
        onError: toastError,
      },
    );
  });

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(pending, guard.close)}
    >
      <DialogShell
        title={decision === 'accepted' ? '采纳本次成果' : '退回本次成果'}
        closeDisabled={pending}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={guard.close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" form={formId} disabled={pending} aria-busy={pending}>
              {pending ? '提交中…' : decision === 'accepted' ? '采纳' : '退回'}
            </Button>
          </div>
        }
      >
        <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4">
          <FieldGroup className="gap-4">
            <Field className="gap-1.5" data-disabled={pending}>
              <FieldTitle>验收对象</FieldTitle>
              <Select
                value={target}
                onValueChange={(next) => {
                  if (next !== null) setTarget(next);
                }}
                items={targets}
                disabled={pending}
              >
                <SelectTrigger className="max-w-full" aria-label="验收对象">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {targets.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field className="gap-1.5">
              <FieldTitle>评分</FieldTitle>
              <div className="flex flex-wrap items-center gap-1">
                <Rating
                  aria-label="评分"
                  value={rating ?? null}
                  deselectable
                  disabled={pending}
                  getValueLabel={(value) => `${value} 星`}
                  onValueChange={(next) =>
                    form.setValue('rating', next, {
                      shouldDirty: true,
                    })
                  }
                >
                  <RatingItem />
                </Rating>
                {rating == null ? null : (
                  <Button
                    type="button"
                    variant="muted"
                    size="sm"
                    disabled={pending}
                    onClick={() => form.setValue('rating', null, { shouldDirty: true })}
                  >
                    清除
                  </Button>
                )}
              </div>
            </Field>
            <Field
              className="gap-1.5"
              data-invalid={Boolean(errors.comment)}
              data-disabled={pending}
            >
              <FieldLabel htmlFor={`${formId}-comment`}>评论</FieldLabel>
              <Textarea
                {...form.register('comment')}
                id={`${formId}-comment`}
                disabled={pending}
                rows={3}
                aria-invalid={Boolean(errors.comment)}
                aria-describedby={errors.comment ? `${formId}-comment-error` : undefined}
                placeholder="可选，最多 2000 字"
              />
              <FieldError id={`${formId}-comment-error`}>{errors.comment?.message}</FieldError>
            </Field>
            {decision === 'rejected' ? (
              <Field
                className="gap-1.5"
                data-invalid={Boolean(errors.reason)}
                data-disabled={pending}
              >
                <FieldLabel htmlFor={`${formId}-reason`}>
                  退回原因 <RequiredMark />
                </FieldLabel>
                <Textarea
                  {...form.register('reason')}
                  id={`${formId}-reason`}
                  disabled={pending}
                  required
                  aria-required="true"
                  rows={3}
                  aria-invalid={Boolean(errors.reason)}
                  aria-describedby={errors.reason ? `${formId}-reason-error` : undefined}
                  placeholder="说明哪里没有达到要求"
                />
                <FieldError id={`${formId}-reason-error`}>{errors.reason?.message}</FieldError>
              </Field>
            ) : null}
          </FieldGroup>
        </form>
        <DraftGuardDialogs guard={guard} draft="这条验收记录会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}

export function RunFeedbackPanel({
  runId,
  conversationTitle,
  prompt,
  messageId,
  files,
  defaultOutputPath = null,
  canEvaluate,
  canWrite = true,
}: {
  runId: string;
  conversationTitle: string;
  prompt: string;
  messageId: string | null;
  files: OutputFile[];
  defaultOutputPath?: string | null;
  canEvaluate: boolean;
  canWrite?: boolean;
}) {
  const feedback = useRunFeedback(runId);
  const me = useQuery(meQuery);
  const [decision, setDecision] = useState<RunFeedbackDecision | null>(null);
  const [evalFeedbackId, setEvalFeedbackId] = useState<string | null>(null);
  const businessId = authenticated(me.data)?.user.businessId ?? null;
  const items = (feedback.data?.items ?? []).toSorted((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const latest = items[0];
  const myLatestRejected = items.find(
    (item) => item.decision === 'rejected' && item.createdBy === businessId,
  );
  const canConvert =
    canEvaluate &&
    prompt.trim().length > 0 &&
    myLatestRejected !== undefined &&
    myLatestRejected.evalCaseId === null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <StatusBadge
            tone={
              latest === undefined
                ? 'outline'
                : latest.decision === 'accepted'
                  ? 'success'
                  : 'danger'
            }
          >
            {latest === undefined ? '尚未验收' : DECISION_LABEL[latest.decision]}
          </StatusBadge>
          {latest === undefined ? null : (
            <span
              className="min-w-0 text-2xs text-muted-foreground"
              title={formatDateTime(latest.createdAt)}
            >
              {latest.createdBy} · {formatRelative(latest.createdAt)}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canConvert ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEvalFeedbackId(myLatestRejected.id)}
            >
              转为评测用例
            </Button>
          ) : null}
          {canWrite ? (
            <>
              <Button variant="outline" size="sm" onClick={() => setDecision('rejected')}>
                退回
              </Button>
              <Button size="sm" onClick={() => setDecision('accepted')}>
                采纳
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {feedback.isPending ? (
        <LoadingState rows={2} />
      ) : feedback.isError ? (
        <ErrorState error={feedback.error} onRetry={() => void feedback.refetch()} />
      ) : items.length === 0 ? null : (
        <div className="flex min-w-0 flex-col gap-2">
          <h3 className="text-sm font-medium text-fg">验收记录</h3>
          <ol className="flex min-w-0 flex-col">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex min-w-0 flex-col gap-1 border-b border-line py-3 last:border-b-0"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <StatusBadge tone={item.decision === 'accepted' ? 'success' : 'danger'}>
                    {DECISION_LABEL[item.decision]}
                  </StatusBadge>
                  {item.rating === null ? null : <RatingStars rating={item.rating} />}
                  <span className="min-w-0 text-2xs text-muted-foreground">
                    {item.outputPath !== null
                      ? `成果 ${item.outputPath}`
                      : item.messageId !== null
                        ? '助手回复'
                        : '整轮运行'}
                  </span>
                  <span className="font-mono text-2xs text-muted-foreground">{item.createdBy}</span>
                  <span
                    className="ml-auto shrink-0 text-2xs text-muted-foreground"
                    title={formatDateTime(item.createdAt)}
                  >
                    {formatRelative(item.createdAt)}
                  </span>
                </div>
                {item.comment ? (
                  <p className="min-w-0 text-sm text-fg [overflow-wrap:anywhere] whitespace-pre-wrap">
                    {item.comment}
                  </p>
                ) : null}
                {item.reason ? (
                  <p className="min-w-0 text-sm text-muted-foreground [overflow-wrap:anywhere] whitespace-pre-wrap">
                    原因：{item.reason}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      )}

      {decision === null ? null : (
        <FeedbackDialog
          runId={runId}
          decision={decision}
          messageId={messageId}
          files={files}
          defaultOutputPath={defaultOutputPath}
          onClose={() => setDecision(null)}
        />
      )}
      {evalFeedbackId === null ? null : (
        <EvalFromRunDialog
          runId={runId}
          conversationTitle={conversationTitle}
          prompt={prompt}
          feedbackId={evalFeedbackId}
          onClose={() => setEvalFeedbackId(null)}
        />
      )}
    </div>
  );
}
