import type { MemoryReview, MemoryReviewTarget } from '@agentport/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { can } from '../../lib/access.js';
import { useDialogClose } from '../../lib/dialog-guard.js';
import { useFormBlocker } from '../../lib/form.js';
import { formatCost, runStatusLabel, runStatusVariant, shortId } from '../../lib/format.js';
import {
  agentsQuery,
  memoryVersionsQuery,
  meQuery,
  useMemoryReview,
  useMemoryReviews,
} from '../../lib/queries.js';
import { DialogShell } from '../dialog-shell.js';
import { FilterPopover } from '../filter-popover.js';
import { FilterSelect } from '../filter-select.js';
import { PageBody, PageHeader, PageToolbar, PageTopbar } from '../page.js';
import { type EmptyFilterChip, EmptyState, ErrorState, LoadingState } from '../states.js';
import { StatusBadge } from '../status-badge.js';
import { Button } from '../ui/button.js';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../ui/card.js';
import { Dialog } from '../ui/dialog.js';
import { type ListView, ViewToggle } from '../view-toggle.js';
import { CreateMemoryReviewDialog } from './review/create-memory-review-dialog.js';
import { MemoryReviewDetail } from './review/memory-review-detail.js';
import {
  decisionDisplay,
  type MemoryReviewView,
  reviewViewOf,
  reviewViewOptions,
  reviewViewPriority,
  targetDisplay,
} from './review/review-shared.js';

export type { MemoryReviewView } from './review/review-shared.js';

export function MemoryReviews({
  title = '记忆提案',
  agentId,
  onAgentChange,
  canReview = true,
  canWrite = true,
  canReadConversations = true,
  canReadAgents = true,
  runId,
  onRunChange,
  createRequested,
  onCreateRequestedChange,
  stage,
  onStageChange,
  view,
  onViewChange,
}: {
  title?: string;
  agentId: string | null;
  onAgentChange: (next: string | null) => void;
  canReview?: boolean;
  canWrite?: boolean;
  canReadConversations?: boolean;
  canReadAgents?: boolean;
  runId: string | null;
  onRunChange: (next: string | null) => void;
  createRequested: boolean;
  onCreateRequestedChange: (next: boolean) => void;
  stage: MemoryReviewView | null;
  onStageChange: (next: MemoryReviewView | null) => void;
  view: ListView;
  onViewChange: (next: ListView) => void;
}) {
  const me = useQuery(meQuery);
  const agents = useQuery({ ...agentsQuery, enabled: canReadAgents });
  const reviews = useMemoryReviews(agentId);
  const canUseAgents = can(me.data, 'agents.use');
  const canReadAgentMemory = can(me.data, 'agents.memory.read');
  const canWriteAgentMemory = can(me.data, 'agents.memory.write');
  const canReadAgentRules = can(me.data, 'agents.rules.read');
  const canWriteAgentRules = can(me.data, 'agents.rules.write');
  const targetReadable = (target: MemoryReviewTarget): boolean =>
    target.kind === 'personal' ||
    (target.kind === 'agent_memory' ? canReadAgentMemory : canReadAgentRules);
  const targetWritable = (target: MemoryReviewTarget): boolean =>
    target.kind === 'personal' ||
    (target.kind === 'agent_memory' ? canWriteAgentMemory : canWriteAgentRules);
  const canUseAgentMemoryTarget = canReadAgentMemory && canWriteAgentMemory;
  const canUseAgentRuleTarget = canReadAgentRules && canWriteAgentRules;
  const createSeedRef = useRef<MemoryReview | null>(null);
  const detailDialog = useDialogClose(() => onRunChange(null), runId !== null);
  const [detailPending, setDetailPending] = useState(false);
  const [detailErrors, setDetailErrors] = useState<Record<string, string | null>>({});
  const pendingBlocker = useFormBlocker(false, detailPending);
  const pendingBlockerRef = useRef(pendingBlocker);
  pendingBlockerRef.current = pendingBlocker;
  useEffect(() => {
    if (!detailPending && pendingBlocker.status === 'blocked') pendingBlocker.reset?.();
  }, [detailPending, pendingBlocker.status, pendingBlocker.reset]);
  useEffect(
    () => () => {
      if (pendingBlockerRef.current.status === 'blocked') pendingBlockerRef.current.reset?.();
    },
    [],
  );
  const createTrigger = useRef<HTMLButtonElement>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const items = reviews.data?.pages.flatMap((page) => page.items) ?? [];
  const listedDetail = items.find((item) => item.runId === runId) ?? null;
  const fetchedDetail = useMemoryReview(runId !== null && listedDetail === null ? runId : null);
  const detail = listedDetail ?? (fetchedDetail.data?.runId === runId ? fetchedDetail.data : null);
  const canCreate = canReview && canReadConversations && canReadAgents && canUseAgents;
  const creating = canCreate && createRequested && agents.data !== undefined;
  const agentOptions = [
    { value: '', label: '全部专家' },
    ...(agents.data?.items ?? []).map((agent) => ({ value: agent.id, label: agent.name })),
  ];

  const visibleItems = items
    .filter((item) => stage === null || reviewViewOf(item) === stage)
    .slice()
    .sort(
      (left, right) =>
        reviewViewPriority[reviewViewOf(left)] - reviewViewPriority[reviewViewOf(right)],
    );

  const appliedTargets = [
    ...new Map(
      [...items, ...(detail ? [detail] : [])]
        .filter((item) => item.decision === 'applied' && item.appliedChangeId !== null)
        .map((item) => [JSON.stringify(item.target), item.target]),
    ).values(),
  ];
  const versionQueries = useQueries({
    queries: appliedTargets.map((target) => memoryVersionsQuery(target, targetReadable(target))),
  });
  const reversedChangeIds = new Set(
    versionQueries.flatMap((query) =>
      (query.data?.items ?? []).flatMap((change) =>
        change.reversesChangeId === null ? [] : [change.reversesChangeId],
      ),
    ),
  );
  const rolledBack = (review: MemoryReview): boolean =>
    review.appliedChangeId !== null && reversedChangeIds.has(review.appliedChangeId);

  const openCreate = (seed: MemoryReview | null = null): void => {
    createSeedRef.current = seed;
    onCreateRequestedChange(true);
  };

  const closeCreate = (): void => {
    createSeedRef.current = null;
    onCreateRequestedChange(false);
  };
  const createSeed = createSeedRef.current;

  const openDetail = (review: MemoryReview, trigger: HTMLElement): void => {
    detailTrigger.current = trigger;
    onRunChange(review.runId);
  };

  const activeFilterCount = (canReadAgents && agentId ? 1 : 0) + (stage ? 1 : 0);

  return (
    <>
      <PageTopbar>
        <PageHeader
          title={title}
          actions={
            canReview ? (
              <Button
                ref={createTrigger}
                onClick={() => openCreate()}
                disabled={
                  agents.isPending ||
                  agents.isError ||
                  !canReadConversations ||
                  !canReadAgents ||
                  !canUseAgents
                }
                title={
                  !canReadConversations
                    ? '需要会话读取权限才能选择来源'
                    : !canReadAgents
                      ? '需要专家目录读取权限才能选择专家'
                      : !canUseAgents
                        ? '需要专家使用权限才能生成提案'
                        : undefined
                }
              >
                <Plus data-icon="inline-start" aria-hidden="true" />
                生成记忆提案
              </Button>
            ) : undefined
          }
        />
        <PageToolbar>
          <FilterPopover activeCount={activeFilterCount}>
            {canReadAgents ? (
              <FilterSelect
                value={agentId ?? ''}
                onValueChange={(next) => onAgentChange(next || null)}
                options={agentOptions}
                label="按专家筛选记忆提案"
                className="w-full"
              />
            ) : null}
            <FilterSelect
              value={stage ?? 'all'}
              onValueChange={(next) =>
                onStageChange(next === 'all' ? null : (next as MemoryReviewView))
              }
              options={reviewViewOptions}
              label="按处理状态筛选"
              className="w-full"
            />
          </FilterPopover>
          <div className="ml-auto flex flex-wrap items-center gap-3">
            {reviews.data && items.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {stage
                  ? `显示 ${visibleItems.length} / ${items.length} 条`
                  : `共 ${items.length} 条`}
              </p>
            ) : null}
            <ViewToggle value={view} onChange={onViewChange} />
          </div>
        </PageToolbar>
      </PageTopbar>

      <PageBody className="gap-4">
        {agents.isError ? (
          <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
        ) : null}

        {reviews.isPending ? (
          <LoadingState rows={4} layout={view === 'cards' ? 'cards' : 'rows'} />
        ) : null}
        {reviews.isError ? (
          <ErrorState error={reviews.error} onRetry={() => void reviews.refetch()} />
        ) : null}
        {reviews.data ? (
          items.length === 0 && !agentId && !stage ? (
            <EmptyState
              variant="stage"
              scale="page"
              specimen="memory"
              title="从历史对话中提炼记忆"
              description="自动梳理近期对话里的关键信息，生成可审阅、可采纳的记忆提案。"
              action={
                canCreate ? (
                  <Button
                    onClick={() => openCreate()}
                    disabled={agents.isPending || agents.isError}
                  >
                    <Plus data-icon="inline-start" aria-hidden="true" />
                    生成记忆提案
                  </Button>
                ) : undefined
              }
            />
          ) : visibleItems.length === 0 ? (
            <EmptyState
              variant="filter"
              scale="section"
              title="当前筛选下没有记忆提案"
              description="仅筛选当前已加载的记录。"
              activeFilters={
                [
                  ...(agentId
                    ? [
                        {
                          key: 'agent',
                          label: '专家',
                          value:
                            agents.data?.items.find((agent) => agent.id === agentId)?.name ??
                            agentId,
                          onRemove: () => onAgentChange(null),
                        },
                      ]
                    : []),
                  ...(stage
                    ? [
                        {
                          key: 'stage',
                          label: '状态',
                          value:
                            reviewViewOptions.find((option) => option.value === stage)?.label ??
                            stage,
                          onRemove: () => onStageChange(null),
                        },
                      ]
                    : []),
                ] satisfies EmptyFilterChip[]
              }
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onAgentChange(null);
                    onStageChange(null);
                  }}
                >
                  查看全部
                </Button>
              }
            />
          ) : view === 'cards' ? (
            <ul
              aria-label="记忆提案列表"
              className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,256px),1fr))] gap-4 p-0 pt-2"
            >
              {visibleItems.map((review) => {
                const target = targetDisplay(review.target, agents.data?.items);
                const status = decisionDisplay(review, rolledBack(review));
                const accessibleTarget = target.detail
                  ? `${target.label}（${target.detail}）`
                  : target.label;
                const summary =
                  review.proposal?.summary ??
                  review.sources
                    .map((source) => source.title)
                    .filter(Boolean)
                    .join('、');
                return (
                  <li key={review.runId} className="min-w-0">
                    <Card size="sm" className="h-full min-w-0">
                      <CardHeader>
                        <CardTitle className="min-w-0">
                          <h2 className="break-words" title={target.detail ?? target.label}>
                            {target.detail ?? target.label}
                          </h2>
                        </CardTitle>
                        {target.detail ? (
                          <CardDescription className="min-w-0 text-xs">
                            {target.label}
                          </CardDescription>
                        ) : null}
                        <CardAction>
                          {status ? (
                            <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                          ) : null}
                        </CardAction>
                      </CardHeader>
                      <CardContent className="flex flex-1 flex-col gap-3">
                        {review.proposal ? (
                          <p className="line-clamp-2 max-w-[75ch] text-sm text-muted-foreground">
                            {review.proposal.summary}
                          </p>
                        ) : null}
                        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 text-xs">
                          <dt className="text-muted-foreground">运行状态</dt>
                          <dd className="justify-self-end">
                            <StatusBadge tone={runStatusVariant[review.status]}>
                              {runStatusLabel[review.status]}
                            </StatusBadge>
                          </dd>
                          {review.costUsd ? (
                            <>
                              <dt className="text-muted-foreground">成本</dt>
                              <dd className="text-right font-mono text-muted-foreground">
                                {formatCost(review.costUsd)}
                              </dd>
                            </>
                          ) : null}
                        </dl>
                      </CardContent>
                      <CardFooter className="justify-end">
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={`查看${accessibleTarget}提案：${summary || '提案'}（${shortId(review.runId)}）`}
                          onClick={(event) => openDetail(review, event.currentTarget)}
                        >
                          查看
                        </Button>
                      </CardFooter>
                    </Card>
                  </li>
                );
              })}
            </ul>
          ) : (
            <ul className="divide-y border-y">
              {visibleItems.map((review) => {
                const target = targetDisplay(review.target, agents.data?.items);
                const status = decisionDisplay(review, rolledBack(review));
                const accessibleTarget = target.detail
                  ? `${target.label}（${target.detail}）`
                  : target.label;
                const summary =
                  review.proposal?.summary ??
                  review.sources
                    .map((source) => source.title)
                    .filter(Boolean)
                    .join('、');
                return (
                  <li key={review.runId}>
                    <div className="flex min-h-14 items-center gap-3 py-2">
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="min-w-0 break-words text-base font-medium text-fg">
                            {target.detail ?? target.label}
                          </span>
                          {target.detail ? (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {target.label}
                            </span>
                          ) : null}
                          {status ? (
                            <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                          ) : null}
                        </div>
                        {review.proposal ? (
                          <p className="line-clamp-2 max-w-[75ch] text-sm text-muted-foreground">
                            {review.proposal.summary}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <StatusBadge tone={runStatusVariant[review.status]}>
                          {runStatusLabel[review.status]}
                        </StatusBadge>
                        {review.costUsd ? (
                          <span className="font-mono text-xs text-muted-foreground">
                            {formatCost(review.costUsd)}
                          </span>
                        ) : null}
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={`查看${accessibleTarget}提案：${summary || '提案'}（${shortId(review.runId)}）`}
                          onClick={(event) => openDetail(review, event.currentTarget)}
                        >
                          查看
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )
        ) : null}
        {reviews.hasNextPage ? (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => void reviews.fetchNextPage()}
            disabled={reviews.isFetchingNextPage}
          >
            {reviews.isFetchingNextPage ? '加载中…' : '加载更多'}
          </Button>
        ) : null}
      </PageBody>

      {creating ? (
        <CreateMemoryReviewDialog
          agents={agents.data?.items ?? []}
          defaultAgentId={agentId}
          seed={createSeed}
          canUseAgents={canUseAgents}
          canUseAgentMemoryTarget={canUseAgentMemoryTarget}
          canUseAgentRuleTarget={canUseAgentRuleTarget}
          canReadAgentMemory={canReadAgentMemory}
          canReadAgentRules={canReadAgentRules}
          onClose={closeCreate}
          finalFocus={() => createTrigger.current}
        />
      ) : null}

      {detail || runId !== null ? (
        <Dialog
          open={detailDialog.open}
          onOpenChange={(next) => {
            if (!next && !detailPending) detailDialog.close();
          }}
          onOpenChangeComplete={detailDialog.onOpenChangeComplete}
        >
          <DialogShell
            title="记忆提案"
            className="max-w-5xl sm:max-w-5xl"
            closeDisabled={detailPending}
            finalFocus={() => (detailTrigger.current?.isConnected ? detailTrigger.current : null)}
          >
            {detail ? (
              <MemoryReviewDetail
                review={detail}
                agents={agents.data?.items}
                rolledBack={rolledBack(detail)}
                canReview={canReview}
                canWrite={canWrite}
                canUseAgents={canUseAgents}
                canReadTarget={targetReadable(detail.target)}
                canWriteTarget={targetWritable(detail.target)}
                canReadConversations={canReadConversations}
                actionError={detailErrors[detail.runId] ?? null}
                onActionError={(message) =>
                  setDetailErrors((previous) => ({ ...previous, [detail.runId]: message }))
                }
                onPendingChange={setDetailPending}
                onRegenerate={(review) => {
                  detailDialog.finish(() => {
                    onRunChange(null);
                    openCreate(review);
                  });
                }}
                onClose={() => {
                  if (!detailPending) detailDialog.close();
                }}
              />
            ) : fetchedDetail.isError ? (
              <ErrorState
                error={fetchedDetail.error}
                onRetry={() => void fetchedDetail.refetch()}
                title="没有找到这条提案"
              />
            ) : (
              <LoadingState rows={3} />
            )}
          </DialogShell>
        </Dialog>
      ) : null}
    </>
  );
}
