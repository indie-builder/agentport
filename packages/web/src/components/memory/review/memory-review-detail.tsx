import { type MemoryReview, memoryReviewAfter } from '@agentport/shared';
import { Link } from '@tanstack/react-router';
import { CircleStop, LoaderCircle, RotateCcw } from 'lucide-react';
import { useEffect } from 'react';
import { type AgentSummary, ApiError, errorMessage } from '../../../lib/api.js';
import { formatCost, runStatusLabel, runStatusVariant } from '../../../lib/format.js';
import {
  useApplyMemoryReview,
  useCancelMemoryReview,
  useRejectMemoryReview,
  useRollbackMemoryChange,
} from '../../../lib/queries.js';
import { toastSuccess } from '../../../lib/toast.js';
import { CodeBlock } from '../../code-block.js';
import { StatusBadge } from '../../status-badge.js';
import { Button } from '../../ui/button.js';
import {
  evidenceKindLabel,
  REVIEW_CODE_CLASS,
  reviewHasChanges,
  targetDisplay,
} from './review-shared.js';

export function MemoryReviewDetail({
  review,
  agents,
  rolledBack,
  canReview,
  canWrite,
  canUseAgents,
  canReadTarget,
  canWriteTarget,
  canReadConversations,
  actionError,
  onActionError,
  onPendingChange,
  onRegenerate,
  onClose,
}: {
  review: MemoryReview;
  agents: AgentSummary[] | undefined;
  rolledBack: boolean;
  canReview: boolean;
  canWrite: boolean;
  canUseAgents: boolean;
  canReadTarget: boolean;
  canWriteTarget: boolean;
  canReadConversations: boolean;
  actionError: string | null;
  onActionError: (message: string | null) => void;
  onPendingChange: (pending: boolean) => void;
  onRegenerate: (review: MemoryReview) => void;
  onClose: () => void;
}) {
  const apply = useApplyMemoryReview();
  const reject = useRejectMemoryReview();
  const cancel = useCancelMemoryReview();
  const rollback = useRollbackMemoryChange();
  const target = targetDisplay(review.target, agents);
  const targetLabel = target.detail ? `${target.label}（${target.detail}）` : target.label;
  const targetLinkLabel =
    review.target.kind === 'personal'
      ? review.decision === 'rejected'
        ? '查看当前个人记忆'
        : '查看个人记忆'
      : review.target.kind === 'agent_memory'
        ? review.decision === 'rejected'
          ? '查看当前专家记忆'
          : '查看专家记忆'
        : review.decision === 'rejected'
          ? '查看当前专家规则'
          : '查看专家规则';
  const targetLink =
    review.target.kind === 'personal' ? (
      <Link to="/personal/memory" className="text-[var(--color-link)] underline underline-offset-4">
        {targetLinkLabel}
      </Link>
    ) : (
      <Link
        to="/agents/$agentId"
        params={{ agentId: review.target.agentId }}
        search={{ tab: review.target.kind === 'agent_memory' ? 'memory' : 'rules' }}
        className="text-[var(--color-link)] underline underline-offset-4"
      >
        {targetLinkLabel}
      </Link>
    );
  const active = review.status === 'queued' || review.status === 'running';
  const succeeded = review.status === 'succeeded';
  const candidate = review.proposal?.proposedContent ?? null;
  const hasChanges = reviewHasChanges(review);
  const noChanges = succeeded && !hasChanges;
  const currentContent = review.before.content;
  const after = review.proposal
    ? memoryReviewAfter(review.target, review.before, review.proposal.proposedContent)
    : review.before;
  const indexChanged =
    review.before.index !== null &&
    after.index !== null &&
    after.index.content !== review.before.index.content;
  const failed = !active && !succeeded;
  const pending = apply.isPending || reject.isPending || cancel.isPending || rollback.isPending;
  const canActOnTarget = canReadTarget && canWriteTarget;

  useEffect(() => onPendingChange(pending), [pending, onPendingChange]);
  useEffect(() => () => onPendingChange(false), [onPendingChange]);

  const applyReview = (): void => {
    onActionError(null);
    apply.mutate(review.runId, {
      onSuccess: () => toastSuccess('已采用提案'),
      onError: (error) =>
        onActionError(
          error instanceof ApiError && error.code === 'CONFLICT_STALE'
            ? '目标已被修改，请重新生成。'
            : errorMessage(error),
        ),
    });
  };

  const rejectReview = (): void => {
    onActionError(null);
    reject.mutate(review.runId, {
      onSuccess: () => toastSuccess('已拒绝提案'),
      onError: (error) => onActionError(errorMessage(error)),
    });
  };

  const cancelReview = (): void => {
    onActionError(null);
    cancel.mutate(review.runId, {
      onError: (error) => onActionError(errorMessage(error)),
    });
  };

  const rollbackChange = (): void => {
    if (!review.appliedChangeId) return;
    onActionError(null);
    rollback.mutate(review.appliedChangeId, {
      onSuccess: () => toastSuccess('已回滚这次变更'),
      onError: (error) => onActionError(errorMessage(error)),
    });
  };

  return (
    <div className="@container flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={runStatusVariant[review.status]}>
          {runStatusLabel[review.status]}
        </StatusBadge>
        {review.costUsd ? (
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            {formatCost(review.costUsd)}
          </span>
        ) : null}
      </div>

      <section aria-label="写入目标" className="flex flex-col gap-1.5">
        <h3 className="text-base font-medium text-fg">写入目标</h3>
        <p className="text-sm text-fg">
          {target.label}
          {target.detail ? (
            <span className="ml-1.5 text-muted-foreground">{target.detail}</span>
          ) : null}
        </p>
        {target.shared ? (
          <p className="text-xs text-muted-foreground">这是专家的共享目标，不是个人记忆。</p>
        ) : null}
      </section>

      {succeeded && !hasChanges ? (
        <StatusBadge tone="default" className="self-start">
          无需变更
        </StatusBadge>
      ) : null}

      {noChanges ? (
        currentContent?.trim() ? (
          <section aria-label="当前内容" className="flex flex-col gap-1.5">
            <h3 className="text-base font-medium text-fg">当前内容</h3>
            <CodeBlock
              code={currentContent}
              maxHeight="none"
              copyable={false}
              className={REVIEW_CODE_CLASS}
            />
          </section>
        ) : null
      ) : (
        <section aria-label="内容对比" className="grid grid-cols-1 gap-4 @min-[800px]:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h3 className="text-base font-medium text-fg">
              {review.decision === 'applied' ? '采用前内容' : '修改前内容'}
            </h3>
            <CodeBlock
              code={review.before.content ?? ''}
              maxHeight="none"
              copyable={false}
              className={REVIEW_CODE_CLASS}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <h3 className="text-base font-medium text-fg">提案内容</h3>
            {candidate !== null ? (
              <CodeBlock
                code={candidate}
                maxHeight="none"
                copyable={false}
                className={REVIEW_CODE_CLASS}
              />
            ) : succeeded ? (
              <p className="text-sm text-muted-foreground">未形成改进候选</p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {active ? '审核进行中…' : '没有提案内容'}
              </p>
            )}
          </div>
        </section>
      )}

      {indexChanged ? (
        <section aria-label="索引对比" className="grid grid-cols-1 gap-4 @min-[800px]:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h3 className="text-base font-medium text-fg">索引修改前内容</h3>
            <CodeBlock
              code={review.before.index?.content ?? ''}
              maxHeight="none"
              copyable={false}
              className={REVIEW_CODE_CLASS}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <h3 className="text-base font-medium text-fg">索引提案内容</h3>
            <CodeBlock
              code={after.index?.content ?? ''}
              maxHeight="none"
              copyable={false}
              className={REVIEW_CODE_CLASS}
            />
          </div>
        </section>
      ) : null}

      {review.proposal ? (
        <section aria-label="提案理由" className="flex flex-col gap-2">
          <h3 className="text-base font-medium text-fg">理由</h3>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg">
            {review.proposal.summary}
          </p>
        </section>
      ) : null}

      {review.proposal && review.proposal.evidence.length > 0 ? (
        <section aria-label="证据" className="flex flex-col gap-2">
          <h3 className="text-base font-medium text-fg">证据</h3>
          <ul className="flex flex-col gap-2">
            {review.proposal.evidence.map((evidence) => (
              <li
                key={`${evidence.messageId}:${evidence.kind}:${evidence.quote}`}
                className="border-l border-line pl-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-tag bg-sunken px-1.5 py-0.5 text-xs text-muted-foreground">
                    {evidenceKindLabel[evidence.kind]}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {evidence.messageId}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-sm text-fg">{evidence.quote}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {review.sources.length > 0 ? (
        <section aria-label="来源" className="flex flex-col gap-2">
          <h3 className="text-base font-medium text-fg">来源</h3>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {review.sources.map((source) =>
              canReadConversations ? (
                <Link
                  key={source.conversationId}
                  to="/chat"
                  search={{ conversation: source.conversationId }}
                  aria-disabled={pending || undefined}
                  onClick={(event) => {
                    if (pending) event.preventDefault();
                  }}
                  className={
                    pending
                      ? 'cursor-not-allowed text-muted-foreground underline underline-offset-4'
                      : 'text-[var(--color-link)] underline underline-offset-4'
                  }
                >
                  {source.title || source.conversationId}（{source.messageCount} 条消息）
                </Link>
              ) : (
                <span key={source.conversationId}>
                  {source.title || source.conversationId}（{source.messageCount} 条消息）
                </span>
              ),
            )}
          </div>
        </section>
      ) : null}

      {failed ? (
        <div role="alert" className="text-sm text-danger">
          {review.error ?? `${runStatusLabel[review.status]}，请重新生成提案。`}
        </div>
      ) : null}

      {review.decision === 'applied' ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-fg">
          <span>{rolledBack ? '已回滚这次变更。' : '提案已采用。'}</span>
          {rolledBack ? null : targetLink}
          {review.appliedChangeId && !rolledBack ? (
            <span className="font-mono text-xs text-muted-foreground">
              {review.appliedChangeId}
            </span>
          ) : null}
        </div>
      ) : null}
      {review.decision === 'rejected' ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>提案已拒绝，目标内容未更改。</span>
          {targetLink}
        </div>
      ) : null}

      {succeeded &&
      review.decision === 'pending' &&
      hasChanges &&
      (!canWrite || !canActOnTarget) ? (
        <p className="text-sm text-muted-foreground">你没有写入该目标的权限，当前提案只读。</p>
      ) : null}

      {actionError ? (
        <div role="alert" className="text-sm text-danger">
          {actionError}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
        {active && canReview ? (
          <Button
            variant="outline"
            disabled={pending}
            aria-busy={cancel.isPending}
            onClick={cancelReview}
          >
            {cancel.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <CircleStop data-icon="inline-start" aria-hidden="true" />
            )}
            {cancel.isPending ? '取消中…' : '取消生成'}
          </Button>
        ) : null}

        {review.decision === 'applied' &&
        review.appliedChangeId &&
        !rolledBack &&
        canWrite &&
        canWriteTarget ? (
          <Button
            variant="outline"
            disabled={pending}
            aria-busy={rollback.isPending}
            data-agent-confirm={`回滚已采用的${targetLabel}变更，恢复为修改前内容`}
            onClick={rollbackChange}
          >
            <RotateCcw data-icon="inline-start" aria-hidden="true" />
            {rollback.isPending ? '回滚中…' : '回滚'}
          </Button>
        ) : null}

        {!active && review.decision !== 'applied' && canReview && canUseAgents && canActOnTarget ? (
          <Button variant="outline" disabled={pending} onClick={() => onRegenerate(review)}>
            重新生成
          </Button>
        ) : null}

        {succeeded && review.decision === 'pending' && hasChanges ? (
          <>
            {canReview && canActOnTarget ? (
              <Button
                variant="outline"
                disabled={pending}
                aria-busy={reject.isPending}
                data-agent-confirm={`拒绝这条${targetLabel}记忆提案，目标内容不会更改`}
                onClick={rejectReview}
              >
                {reject.isPending ? '处理中…' : '不采用'}
              </Button>
            ) : null}
            {canWrite && canActOnTarget ? (
              <Button disabled={pending} aria-busy={apply.isPending} onClick={applyReview}>
                {apply.isPending ? '采用中…' : '采用'}
              </Button>
            ) : null}
          </>
        ) : null}

        {!active ? (
          <Button variant="outline" disabled={pending} onClick={onClose}>
            关闭详情
          </Button>
        ) : null}
      </div>
    </div>
  );
}
