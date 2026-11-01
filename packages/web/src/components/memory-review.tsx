import type {
  ConversationSummary,
  CreateMemoryReviewInput,
  MemoryReview,
  MemoryReviewEvidenceKind,
  MemoryReviewTarget,
} from '@agentport/shared';
import {
  memoryFileNameSchema,
  memoryReviewAfter,
  memoryReviewHasChanges,
  slugSchema,
} from '@agentport/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleStop, LoaderCircle, Plus, RotateCcw, Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { can } from '../lib/access.js';
import { type AgentSummary, ApiError, errorMessage } from '../lib/api.js';
import { useFormBlocker } from '../lib/form.js';
import { formatCost, runStatusLabel, runStatusVariant, shortId } from '../lib/format.js';
import {
  agentMemoryQuery,
  agentRulesQuery,
  agentsQuery,
  memoryVersionsQuery,
  meQuery,
  useApplyMemoryReview,
  useCancelMemoryReview,
  useCreateMemoryReview,
  useMemoryReview,
  useMemoryReviews,
  usePersonalConversations,
  useRejectMemoryReview,
  useRollbackMemoryChange,
} from '../lib/queries.js';
import { toastSuccess } from '../lib/toast.js';
import { BusinessIllustration } from './business-illustration.js';
import { CodeBlock } from './code-block.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { DialogShell } from './dialog-shell.js';
import { FilterSelect } from './filter-select.js';
import { EmptyState, ErrorState, LoadingState } from './states.js';
import { StatusBadge } from './status-badge.js';
import { Button } from './ui/button.js';
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from './ui/card.js';
import { Checkbox } from './ui/checkbox.js';
import { Dialog } from './ui/dialog.js';
import { Field, FieldError, FieldLabel, FieldTitle } from './ui/field.js';
import { Input } from './ui/input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select.js';
import { Textarea } from './ui/textarea.js';
import { type ListView, ViewToggle } from './view-toggle.js';

const INSTRUCTION_MAX_CHARS = 4000;
const MAX_SOURCES = 10;

type TargetKind = MemoryReviewTarget['kind'];

/** 列表视图只描述当前已加载记录的处理阶段，不冒充全局数量。 */
export type MemoryReviewView = 'pending' | 'generating' | 'done';

const reviewViewOptions = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待审核' },
  { value: 'generating', label: '生成中' },
  { value: 'done', label: '已处理' },
] as const;

const allTargetKindOptions = [
  { value: 'personal', label: '个人记忆' },
  { value: 'agent_memory', label: '专家记忆' },
  { value: 'agent_rule', label: '专家规则' },
] as const;

const MEMORY_INDEX_NAME = 'MEMORY.md';
const NEW_MEMORY_CHOICE = '__new__';

/** 审核要通读长文：源码按可用宽度换行并断开长 token，不让每列各自横向滚动。 */
const REVIEW_CODE_CLASS =
  'min-w-0 [&_code>span]:min-w-0 [&_code>span>span]:min-w-0 [&_code>span>span]:whitespace-pre-wrap [&_code>span>span]:break-words [&_code>span>span]:[overflow-wrap:anywhere]';

const evidenceKindLabel: Record<MemoryReviewEvidenceKind, string> = {
  user_fact: '用户事实',
  confirmed_decision: '已确认决定',
  assistant_suggestion: '助手建议',
};

function targetDisplay(
  target: MemoryReviewTarget,
  agents: AgentSummary[] | undefined,
): { label: string; detail: string | null; shared: boolean } {
  if (target.kind === 'personal') return { label: '个人记忆', detail: null, shared: false };
  const agentName = agents?.find((agent) => agent.id === target.agentId)?.name ?? target.agentId;
  if (target.kind === 'agent_memory') {
    return { label: '专家记忆', detail: `${agentName} / ${target.name}`, shared: true };
  }
  return { label: '专家规则', detail: `${agentName} / ${target.slug}`, shared: true };
}

/** 文件名可以省略 .md；最终提交值仍由 shared schema 校验。 */
function memoryFileNameOf(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
}

function memoryFormatErrorOf(value: string): string | null {
  if (value.trim() === '') return null;
  const parsed = memoryFileNameSchema.safeParse(memoryFileNameOf(value));
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? '记忆文件名格式不正确');
}

function reviewHasChanges(review: MemoryReview): boolean {
  return (
    review.proposal !== null &&
    memoryReviewHasChanges(review.target, review.before, review.proposal)
  );
}

/** 无需变更的提案不需要用户动作，归入已处理，避免占住待审核。 */
function reviewViewOf(review: MemoryReview): MemoryReviewView {
  if (review.status === 'queued' || review.status === 'running') return 'generating';
  if (review.status === 'succeeded' && review.decision === 'pending' && reviewHasChanges(review)) {
    return 'pending';
  }
  return 'done';
}

const reviewViewPriority: Record<MemoryReviewView, number> = {
  pending: 0,
  generating: 1,
  done: 2,
};

function formatTimeout(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} 分钟` : `${Math.round(ms / 1000)} 秒`;
}

function decisionDisplay(
  review: MemoryReview,
  rolledBack: boolean,
): { label: string; tone: 'default' | 'success' | 'warn' | 'outline' } | null {
  if (review.status !== 'succeeded') return null;
  if (review.decision === 'pending') {
    return reviewHasChanges(review)
      ? { label: '待采用', tone: 'warn' }
      : { label: '无需变更', tone: 'default' };
  }
  if (review.decision === 'rejected') return { label: '已拒绝', tone: 'default' };
  return rolledBack ? { label: '已回滚', tone: 'outline' } : { label: '已采用', tone: 'success' };
}

interface SelectedSource {
  conversationId: string;
  title: string;
  agentId: string;
}

export function MemoryReviews({
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
  agentId: string | null;
  onAgentChange: (next: string | null) => void;
  /** 创建、拒绝、重新生成与取消生成。 */
  canReview?: boolean;
  /** 采纳与回滚。 */
  canWrite?: boolean;
  canReadConversations?: boolean;
  canReadAgents?: boolean;
  runId: string | null;
  onRunChange: (next: string | null) => void;
  /** 新建流程是否由 URL 打开；关闭时同步移除，刷新与后退保持同一视图。 */
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
  // 专家目标由各自的读/写叶门控；个人目标沿用页面级的个人记忆权限。
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
  // 种子只在本次打开中有效，不参与渲染时序；URL 才是弹层生命周期的唯一来源。
  const createSeedRef = useRef<MemoryReview | null>(null);
  const [detailPending, setDetailPending] = useState(false);
  const [detailErrors, setDetailErrors] = useState<Record<string, string | null>>({});
  // 详情操作在途时，浏览器后退/刷新不能把请求丢下；结算后取消被拦下的导航。
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
  const detailTrigger = useRef<HTMLButtonElement | null>(null);
  const items = reviews.data?.items ?? [];
  const listedDetail = items.find((item) => item.runId === runId) ?? null;
  // 链接里的提案不在当前页列表时，用既有详情接口按 run 取；未知 id 返回统一错误态。
  const fetchedDetail = useMemoryReview(runId !== null && listedDetail === null ? runId : null);
  const detail = listedDetail ?? (fetchedDetail.data?.runId === runId ? fetchedDetail.data : null);
  const canCreate = canReview && canReadConversations && canReadAgents && canUseAgents;
  // 等专家目录就绪再挂载弹层：否则默认来源专家按空数组初始化成 ''，下拉会空白且会话退化成全部专家。
  const creating = canCreate && createRequested && agents.data !== undefined;
  const agentOptions = [
    { value: '', label: '全部专家' },
    ...(agents.data ?? []).map((agent) => ({ value: agent.id, label: agent.name })),
  ];

  const viewCounts: Record<MemoryReviewView, number> = { pending: 0, generating: 0, done: 0 };
  for (const item of items) viewCounts[reviewViewOf(item)] += 1;
  const visibleItems = items
    .filter((item) => stage === null || reviewViewOf(item) === stage)
    .slice()
    .sort(
      (left, right) =>
        reviewViewPriority[reviewViewOf(left)] - reviewViewPriority[reviewViewOf(right)],
    );

  // 采用过的提案是否已被撤销，只看目标自己的变更账本，不依赖本次会话的本地状态。
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

  const openDetail = (review: MemoryReview, trigger: HTMLButtonElement): void => {
    detailTrigger.current = trigger;
    onRunChange(review.runId);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {canReadAgents ? (
          <FilterSelect
            value={agentId ?? ''}
            onValueChange={(next) => onAgentChange(next || null)}
            options={agentOptions}
            label="按专家筛选记忆提案"
            className="w-full sm:w-44"
          />
        ) : null}
        <FilterSelect
          value={stage ?? 'all'}
          onValueChange={(next) =>
            onStageChange(next === 'all' ? null : (next as MemoryReviewView))
          }
          options={reviewViewOptions}
          label="按处理状态筛选"
          className="w-full sm:w-36"
        />
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {reviews.data && items.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              当前已加载 {items.length} 条 · 待审核 {viewCounts.pending} · 生成中{' '}
              {viewCounts.generating} · 已处理 {viewCounts.done}
            </p>
          ) : null}
          {canReview ? (
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
          ) : null}
          <ViewToggle value={view} onChange={onViewChange} />
        </div>
      </div>

      {agents.isError ? (
        <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
      ) : null}

      {reviews.isPending ? <LoadingState rows={4} /> : null}
      {reviews.isError ? (
        <ErrorState error={reviews.error} onRetry={() => void reviews.refetch()} />
      ) : null}
      {reviews.data ? (
        items.length === 0 ? (
          <EmptyState
            illustration={<BusinessIllustration name="review" />}
            title="让模型整理值得保存的记忆"
            description="选择执行专家和来源会话，生成可采纳的记忆或规则提案。"
            action={
              canCreate ? (
                <Button onClick={() => openCreate()} disabled={agents.isPending || agents.isError}>
                  <Plus data-icon="inline-start" aria-hidden="true" />
                  生成记忆提案
                </Button>
              ) : undefined
            }
          />
        ) : visibleItems.length === 0 ? (
          <EmptyState
            icon={<Search className="size-5" />}
            title="当前筛选下没有提案"
            description="这里只统计当前已加载的记录，可以切回全部查看。"
            action={
              <Button variant="outline" onClick={() => onStageChange(null)}>
                查看全部
              </Button>
            }
          />
        ) : view === 'cards' ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {visibleItems.map((review) => {
              const target = targetDisplay(review.target, agents.data);
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
                <Card key={review.runId} className="h-full min-w-0">
                  <CardHeader>
                    <CardTitle className="min-w-0">
                      <h2 className="truncate" title={target.detail ?? target.label}>
                        {target.label}
                        {target.detail ? (
                          <span className="ml-1.5 font-normal text-muted-foreground">
                            {target.detail}
                          </span>
                        ) : null}
                      </h2>
                    </CardTitle>
                    <CardAction>
                      {status ? <StatusBadge tone={status.tone}>{status.label}</StatusBadge> : null}
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
              );
            })}
          </div>
        ) : (
          <ul className="divide-y border-y">
            {visibleItems.map((review) => {
              const target = targetDisplay(review.target, agents.data);
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
                        <span className="truncate text-base font-medium text-fg">
                          {target.label}
                          {target.detail ? (
                            <span className="ml-1.5 font-normal text-muted-foreground">
                              {target.detail}
                            </span>
                          ) : null}
                        </span>
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

      {creating ? (
        <CreateMemoryReviewDialog
          agents={agents.data ?? []}
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
          open
          onOpenChange={(next) => {
            if (!next && !detailPending) onRunChange(null);
          }}
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
                agents={agents.data}
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
                  onRunChange(null);
                  openCreate(review);
                }}
                onClose={() => {
                  if (!detailPending) onRunChange(null);
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
    </div>
  );
}

interface CreateFieldErrors {
  model?: string;
  target?: string;
  slug?: string;
  memory?: string;
  sources?: string;
  instruction?: string;
  form?: string;
}

function clearFieldErrors(
  errors: CreateFieldErrors,
  ...keys: (keyof CreateFieldErrors)[]
): CreateFieldErrors {
  const next = { ...errors };
  for (const key of keys) delete next[key];
  return next;
}

function slugFormatErrorOf(value: string): string | null {
  if (value === '') return null;
  const parsed = slugSchema.safeParse(value);
  return parsed.success ? null : `规则 slug ${parsed.error.issues[0]?.message ?? '格式不正确'}。`;
}

function createInitialState(
  agents: AgentSummary[],
  defaultAgentId: string | null,
  seed: MemoryReview | null,
): {
  modelAgentId: string;
  targetKind: TargetKind;
  targetAgentId: string;
  ruleChoice: string;
  newRuleSlug: string;
  memoryChoice: string;
  newMemoryName: string;
  sourceExpertId: string;
  sources: SelectedSource[];
  instruction: string;
} {
  const enabled = agents.filter((agent) => agent.enabled);
  const initialAgent = enabled.find((agent) => agent.id === defaultAgentId) ?? enabled[0];
  if (seed === null) {
    return {
      modelAgentId: initialAgent?.id ?? '',
      targetKind: 'personal',
      targetAgentId: initialAgent?.id ?? '',
      ruleChoice: '__new__',
      newRuleSlug: '',
      memoryChoice: MEMORY_INDEX_NAME,
      newMemoryName: '',
      sourceExpertId: initialAgent?.id ?? '',
      sources: [],
      instruction: '',
    };
  }
  const target = seed.target;
  const targetAgentId = target.kind === 'personal' ? (initialAgent?.id ?? '') : target.agentId;
  const sourceExpertId = target.kind === 'personal' ? (initialAgent?.id ?? '') : target.agentId;
  return {
    modelAgentId: seed.modelAgentId,
    targetKind: target.kind,
    targetAgentId,
    ruleChoice: target.kind === 'agent_rule' ? target.slug : '__new__',
    newRuleSlug: '',
    memoryChoice: target.kind === 'agent_memory' ? target.name : MEMORY_INDEX_NAME,
    newMemoryName: '',
    sourceExpertId,
    sources: seed.sources.map((source) => ({
      conversationId: source.conversationId,
      title: source.title,
      agentId: sourceExpertId,
    })),
    instruction: '',
  };
}

function CreateMemoryReviewDialog({
  agents,
  defaultAgentId,
  seed,
  canUseAgents,
  canUseAgentMemoryTarget,
  canUseAgentRuleTarget,
  canReadAgentMemory,
  canReadAgentRules,
  onClose,
  finalFocus,
}: {
  agents: AgentSummary[];
  defaultAgentId: string | null;
  seed: MemoryReview | null;
  canUseAgents: boolean;
  canUseAgentMemoryTarget: boolean;
  canUseAgentRuleTarget: boolean;
  canReadAgentMemory: boolean;
  canReadAgentRules: boolean;
  onClose: () => void;
  finalFocus: () => HTMLElement | null;
}) {
  const [initial] = useState(() => createInitialState(agents, defaultAgentId, seed));
  const [modelAgentId, setModelAgentId] = useState(initial.modelAgentId);
  const [targetKind, setTargetKind] = useState<TargetKind>(initial.targetKind);
  const [targetAgentId, setTargetAgentId] = useState(initial.targetAgentId);
  const [ruleChoice, setRuleChoice] = useState(initial.ruleChoice);
  const [newRuleSlug, setNewRuleSlug] = useState(initial.newRuleSlug);
  const [memoryChoice, setMemoryChoice] = useState(initial.memoryChoice);
  const [newMemoryName, setNewMemoryName] = useState(initial.newMemoryName);
  const [sourceExpertId, setSourceExpertId] = useState(initial.sourceExpertId);
  const [sources, setSources] = useState<SelectedSource[]>(initial.sources);
  const [instruction, setInstruction] = useState(initial.instruction);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [fieldErrors, setFieldErrors] = useState<CreateFieldErrors>({});
  const [discardOpen, setDiscardOpen] = useState(false);
  // 关闭时先把 dirty 置为 false，再让 URL 变化；否则自己的 blocker 会拦住关闭。
  const [closing, setClosing] = useState(false);
  const idempotency = useRef<{ fingerprint: string; key: string } | null>(null);
  const sourcesBoxRef = useRef<HTMLDivElement>(null);
  const create = useCreateMemoryReview();

  useEffect(() => {
    if (fieldErrors.sources) sourcesBoxRef.current?.focus();
  }, [fieldErrors.sources]);

  const modelAgent = agents.find((agent) => agent.id === modelAgentId);
  const sourceAgent = agents.find((agent) => agent.id === sourceExpertId);
  const conversationAgentId = sourceExpertId;
  const conversations = usePersonalConversations(conversationAgentId || null);
  const rules = useQuery({
    ...agentRulesQuery(targetAgentId),
    enabled: targetKind === 'agent_rule' && targetAgentId !== '' && canReadAgentRules,
  });
  const memory = useQuery({
    ...agentMemoryQuery(targetAgentId),
    enabled: targetKind === 'agent_memory' && targetAgentId !== '' && canReadAgentMemory,
  });
  const targetKindOptions = allTargetKindOptions.filter(
    (option) =>
      option.value === 'personal' ||
      (option.value === 'agent_memory' ? canUseAgentMemoryTarget : canUseAgentRuleTarget),
  );
  const enabled = agents.filter((agent) => agent.enabled);
  const agentOptions = enabled.map((agent) => ({ value: agent.id, label: agent.name }));
  const ruleSlug = ruleChoice === '__new__' ? newRuleSlug.trim() : ruleChoice;
  const baseRuleOptions = [
    ...(rules.data ?? []).map((rule) => ({ value: rule.slug, label: rule.slug })),
    { value: '__new__', label: '新规则…' },
  ];
  const ruleOptions = baseRuleOptions.some((option) => option.value === ruleChoice)
    ? baseRuleOptions
    : [{ value: ruleChoice, label: ruleChoice }, ...baseRuleOptions];
  // 已存在的主题在前，MEMORY.md 始终可选；候选文件尚不存在时同样允许创建。
  const memoryFileNames = [
    MEMORY_INDEX_NAME,
    ...(memory.data?.files ?? [])
      .map((file) => file.name)
      .filter((fileName) => fileName !== MEMORY_INDEX_NAME),
  ];
  const baseMemoryOptions = [
    ...memoryFileNames.map((fileName) => ({ value: fileName, label: fileName })),
    { value: NEW_MEMORY_CHOICE, label: '新主题…' },
  ];
  const memoryOptions = baseMemoryOptions.some((option) => option.value === memoryChoice)
    ? baseMemoryOptions
    : [{ value: memoryChoice, label: memoryChoice }, ...baseMemoryOptions];
  const selectedMemoryName =
    memoryChoice === NEW_MEMORY_CHOICE ? memoryFileNameOf(newMemoryName) : memoryChoice;
  const summaryTarget: MemoryReviewTarget =
    targetKind === 'personal'
      ? { kind: 'personal' }
      : targetKind === 'agent_memory'
        ? { kind: 'agent_memory', agentId: targetAgentId, name: selectedMemoryName }
        : { kind: 'agent_rule', agentId: targetAgentId, slug: ruleSlug };
  const summaryTargetDisplay = targetDisplay(summaryTarget, agents);
  const dirty =
    !closing &&
    (modelAgentId !== initial.modelAgentId ||
      targetKind !== initial.targetKind ||
      targetAgentId !== initial.targetAgentId ||
      ruleChoice !== initial.ruleChoice ||
      newRuleSlug !== initial.newRuleSlug ||
      memoryChoice !== initial.memoryChoice ||
      newMemoryName !== initial.newMemoryName ||
      sourceExpertId !== initial.sourceExpertId ||
      instruction !== initial.instruction ||
      sources.length !== initial.sources.length ||
      sources.some(
        (source, index) => source.conversationId !== initial.sources[index]?.conversationId,
      ));
  const instructionLength = instruction.length;
  const slugFormatError =
    targetKind === 'agent_rule' && ruleChoice === '__new__'
      ? slugFormatErrorOf(newRuleSlug.trim())
      : null;
  const slugError = slugFormatError ?? fieldErrors.slug;
  const memoryFormatError =
    targetKind === 'agent_memory' && memoryChoice === NEW_MEMORY_CHOICE
      ? memoryFormatErrorOf(newMemoryName)
      : null;
  const memoryError = memoryFormatError ?? fieldErrors.memory;
  const instructionError =
    instructionLength > INSTRUCTION_MAX_CHARS
      ? `最多 ${INSTRUCTION_MAX_CHARS} 个字符，请精简后再提交。`
      : fieldErrors.instruction;
  // 关闭表单和路由离开共用同一份放弃确认；pending 时 proceed 会被 useFormBlocker 拦下。
  const blocker = useFormBlocker(dirty, create.isPending);
  // 提交成功的回调可能是旧的闭包，用 ref 拿最新的 blocker 才能取消已被拦下的导航。
  const latestBlocker = useRef(blocker);
  latestBlocker.current = blocker;
  const leaving = blocker.status === 'blocked';

  const requestClose = (): void => {
    if (create.isPending) return;
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    setClosing(true);
  };

  useEffect(() => {
    if (closing) onClose();
  }, [closing, onClose]);

  const changeTargetKind = (next: TargetKind): void => {
    setTargetKind(next);
    setFieldErrors({});
    // 来源专家与目标专家是两件事；换目标不改变已选来源。
    setRuleChoice('__new__');
    setNewRuleSlug('');
    setMemoryChoice(MEMORY_INDEX_NAME);
    setNewMemoryName('');
  };

  const changeSourceExpert = (next: string): void => {
    if (next === sourceExpertId) return;
    setSourceExpertId(next);
    setSources([]);
    setFieldErrors((previous) => clearFieldErrors(previous, 'sources', 'form'));
  };

  const toggleSource = (conversation: ConversationSummary): void => {
    setFieldErrors((previous) => clearFieldErrors(previous, 'form', 'sources'));
    setSources((previous) => {
      if (previous.some((source) => source.conversationId === conversation.id)) {
        return previous.filter((source) => source.conversationId !== conversation.id);
      }
      if (previous.length >= MAX_SOURCES) {
        setFieldErrors((current) => ({
          ...current,
          sources: `最多选择 ${MAX_SOURCES} 段来源会话。`,
        }));
        return previous;
      }
      return [
        ...previous,
        {
          conversationId: conversation.id,
          title: conversation.title,
          agentId: conversation.agentId,
        },
      ];
    });
  };

  const validateSources = (): CreateFieldErrors => {
    const next: CreateFieldErrors = {};
    if (sources.length === 0) next.sources = '至少选择一段来源会话。';
    if (sources.length > MAX_SOURCES) next.sources = `最多选择 ${MAX_SOURCES} 段来源会话。`;
    return next;
  };

  const validateTarget = (): CreateFieldErrors => {
    const next: CreateFieldErrors = {};
    if (!modelAgentId) next.model = '选择执行专家。';
    if (targetKind !== 'personal' && !targetAgentId) next.target = '选择目标专家。';
    if (targetKind === 'agent_rule') {
      if (!ruleSlug) {
        next.slug = '选择已有规则或填写新规则 slug。';
      } else {
        const formatError = slugFormatErrorOf(ruleSlug);
        if (formatError) next.slug = formatError;
      }
    }
    if (targetKind === 'agent_memory') {
      if (memoryChoice === NEW_MEMORY_CHOICE && newMemoryName.trim() === '') {
        next.memory = '填写新主题文件名。';
      } else {
        const formatError = memoryFormatErrorOf(
          memoryChoice === NEW_MEMORY_CHOICE ? newMemoryName : memoryChoice,
        );
        if (formatError) next.memory = formatError;
      }
    }
    if (instructionLength > INSTRUCTION_MAX_CHARS) {
      next.instruction = `最多 ${INSTRUCTION_MAX_CHARS} 个字符，请精简后再提交。`;
    }
    return next;
  };

  const goNext = (): void => {
    if (step === 1) {
      const next = validateSources();
      setFieldErrors((previous) => ({ ...previous, ...next }));
      if (Object.keys(next).length > 0) {
        sourcesBoxRef.current?.focus();
        return;
      }
      setStep(2);
      return;
    }
    if (step === 2) {
      const next = validateTarget();
      setFieldErrors((previous) => ({ ...previous, ...next }));
      if (Object.keys(next).length > 0) return;
      setStep(3);
    }
  };

  const goBack = (): void => {
    if (step === 3) setStep(2);
    else if (step === 2) setStep(1);
  };

  const submit = (): void => {
    if (!canUseAgents) return;
    const next: CreateFieldErrors = { ...validateSources(), ...validateTarget() };
    setFieldErrors(next);
    if (Object.keys(next).length > 0) {
      setStep(next.sources ? 1 : 2);
      return;
    }

    const target: MemoryReviewTarget =
      targetKind === 'personal'
        ? { kind: 'personal' }
        : targetKind === 'agent_memory'
          ? { kind: 'agent_memory', agentId: targetAgentId, name: selectedMemoryName }
          : { kind: 'agent_rule', agentId: targetAgentId, slug: ruleSlug };
    const input: CreateMemoryReviewInput = {
      modelAgentId,
      target,
      sources: sources.map((source) => ({ conversationId: source.conversationId })),
      instruction,
    };
    // 同一份输入的重试必须复用同一键；只有输入变化或重新开始才生成新键。
    const fingerprint = JSON.stringify(input);
    let attempt = idempotency.current;
    if (attempt?.fingerprint !== fingerprint) {
      attempt = { fingerprint, key: crypto.randomUUID() };
      idempotency.current = attempt;
    }
    create.mutate(
      { input, idempotencyKey: attempt.key },
      {
        onSuccess: () => {
          toastSuccess('已发起记忆提案');
          // 关闭会卸载 blocker，先取消被拦下的返回导航，避免地址栏与路由停在不同的地址。
          if (latestBlocker.current.status === 'blocked') latestBlocker.current.reset?.();
          setClosing(true);
        },
        onError: (error) =>
          setFieldErrors((previous) => ({ ...previous, form: errorMessage(error) })),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(next) => (!next ? requestClose() : undefined)}>
      <DialogShell title="新建记忆提案" finalFocus={finalFocus} closeDisabled={create.isPending}>
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            // 前两步的 Enter 只推进；生成必须由第 3 步明确的提交意图发起。
            if (step < 3) {
              goNext();
              return;
            }
            submit();
          }}
        >
          {step === 2 ? (
            <>
              <div>
                <h3 className="text-sm font-medium text-fg">写入目标与执行方式</h3>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  默认写入个人记忆；专家目标会写入该专家的共享文件。
                </p>
              </div>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field
                  className="gap-1.5"
                  data-disabled={create.isPending}
                  data-invalid={fieldErrors.model ? true : undefined}
                >
                  <FieldLabel htmlFor="memory-review-model">执行专家</FieldLabel>
                  <Select
                    value={modelAgentId}
                    items={agentOptions}
                    disabled={create.isPending || !canUseAgents}
                    onValueChange={(next) => {
                      if (next === null) return;
                      setModelAgentId(next);
                      setFieldErrors((previous) => clearFieldErrors(previous, 'model', 'form'));
                    }}
                  >
                    <SelectTrigger
                      id="memory-review-model"
                      className="w-full"
                      aria-label="执行专家"
                      aria-invalid={fieldErrors.model ? true : undefined}
                      aria-describedby={fieldErrors.model ? 'memory-review-model-error' : undefined}
                    >
                      <SelectValue placeholder="选择专家" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {agentOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {fieldErrors.model ? (
                    <FieldError id="memory-review-model-error">{fieldErrors.model}</FieldError>
                  ) : null}
                </Field>

                <Field className="gap-1.5" data-disabled={create.isPending}>
                  <FieldLabel htmlFor="memory-review-target-kind">目标</FieldLabel>
                  <Select
                    value={targetKind}
                    items={targetKindOptions}
                    disabled={create.isPending}
                    onValueChange={(next) => {
                      if (next !== null) changeTargetKind(next as TargetKind);
                    }}
                  >
                    <SelectTrigger
                      id="memory-review-target-kind"
                      className="w-full"
                      aria-label="目标"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {targetKindOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              {targetKind !== 'personal' ? (
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field
                    className="gap-1.5"
                    data-disabled={create.isPending}
                    data-invalid={fieldErrors.target ? true : undefined}
                  >
                    <FieldLabel htmlFor="memory-review-target-agent">目标专家</FieldLabel>
                    <Select
                      value={targetAgentId}
                      items={agentOptions}
                      disabled={create.isPending}
                      onValueChange={(next) => {
                        if (next === null) return;
                        setTargetAgentId(next);
                        setRuleChoice('__new__');
                        setNewRuleSlug('');
                        setMemoryChoice(MEMORY_INDEX_NAME);
                        setNewMemoryName('');
                        setFieldErrors((previous) =>
                          clearFieldErrors(previous, 'target', 'slug', 'memory', 'form'),
                        );
                      }}
                    >
                      <SelectTrigger
                        id="memory-review-target-agent"
                        className="w-full"
                        aria-label="目标专家"
                        aria-invalid={fieldErrors.target ? true : undefined}
                        aria-describedby={
                          fieldErrors.target ? 'memory-review-target-error' : undefined
                        }
                      >
                        <SelectValue placeholder="选择专家" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {agentOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    {fieldErrors.target ? (
                      <FieldError id="memory-review-target-error">{fieldErrors.target}</FieldError>
                    ) : null}
                  </Field>

                  {targetKind === 'agent_rule' ? (
                    <Field
                      className="gap-1.5"
                      data-disabled={create.isPending}
                      data-invalid={slugError ? true : undefined}
                    >
                      <FieldLabel htmlFor="memory-review-rule">规则</FieldLabel>
                      <Select
                        value={ruleChoice}
                        items={ruleOptions}
                        disabled={create.isPending}
                        onValueChange={(next) => {
                          if (next === null) return;
                          setRuleChoice(next);
                          setFieldErrors((previous) => clearFieldErrors(previous, 'slug', 'form'));
                        }}
                      >
                        <SelectTrigger
                          id="memory-review-rule"
                          className="w-full"
                          aria-label="规则"
                          aria-invalid={slugError ? true : undefined}
                          aria-describedby={slugError ? 'memory-review-rule-error' : undefined}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {ruleOptions.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      {ruleChoice === '__new__' ? (
                        <Input
                          id="memory-review-rule-slug"
                          value={newRuleSlug}
                          aria-label="新规则 slug"
                          aria-invalid={slugError ? true : undefined}
                          aria-describedby={slugError ? 'memory-review-rule-error' : undefined}
                          placeholder="新规则 slug，如 memory-review"
                          className="mt-2 font-mono"
                          disabled={create.isPending}
                          onChange={(event) => {
                            setNewRuleSlug(event.target.value);
                            setFieldErrors((previous) =>
                              clearFieldErrors(previous, 'slug', 'form'),
                            );
                          }}
                        />
                      ) : null}
                      {slugError ? (
                        <FieldError id="memory-review-rule-error">{slugError}</FieldError>
                      ) : null}
                    </Field>
                  ) : targetKind === 'agent_memory' ? (
                    <Field
                      className="gap-1.5"
                      data-disabled={create.isPending}
                      data-invalid={memoryError ? true : undefined}
                    >
                      <FieldLabel htmlFor="memory-review-memory-file">记忆文件</FieldLabel>
                      <Select
                        value={memoryChoice}
                        items={memoryOptions}
                        disabled={create.isPending}
                        onValueChange={(next) => {
                          if (next === null) return;
                          setMemoryChoice(next);
                          setFieldErrors((previous) =>
                            clearFieldErrors(previous, 'memory', 'form'),
                          );
                        }}
                      >
                        <SelectTrigger
                          id="memory-review-memory-file"
                          className="w-full"
                          aria-label="记忆文件"
                          aria-invalid={memoryError ? true : undefined}
                          aria-describedby={
                            memoryError ? 'memory-review-memory-file-error' : undefined
                          }
                        >
                          <SelectValue placeholder="选择记忆文件" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {memoryOptions.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      {memory.isError ? (
                        <ErrorState error={memory.error} onRetry={() => void memory.refetch()} />
                      ) : null}
                      {memoryChoice === NEW_MEMORY_CHOICE ? (
                        <Input
                          id="memory-review-new-file"
                          value={newMemoryName}
                          aria-label="新主题文件名"
                          aria-invalid={memoryError ? true : undefined}
                          aria-describedby={
                            memoryError ? 'memory-review-memory-file-error' : undefined
                          }
                          placeholder="新主题文件名，如 deployment.md"
                          className="mt-2 font-mono"
                          disabled={create.isPending}
                          onChange={(event) => {
                            setNewMemoryName(event.target.value);
                            setFieldErrors((previous) =>
                              clearFieldErrors(previous, 'memory', 'form'),
                            );
                          }}
                        />
                      ) : null}
                      {memoryError ? (
                        <FieldError id="memory-review-memory-file-error">{memoryError}</FieldError>
                      ) : null}
                    </Field>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}

          {step === 1 ? (
            <>
              <div>
                <h3 className="text-sm font-medium text-fg">来源</h3>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  先选来源专家，再从该专家的本人会话中选择最多 {MAX_SOURCES} 段。
                </p>
              </div>
              <Field
                className="gap-1.5"
                data-disabled={create.isPending}
                data-invalid={fieldErrors.sources ? true : undefined}
                aria-labelledby="memory-review-sources-label"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <FieldTitle id="memory-review-sources-label">来源会话</FieldTitle>
                  <span className="text-xs text-muted-foreground">
                    已选 {sources.length} / {MAX_SOURCES}
                  </span>
                </div>

                <FilterSelect
                  value={sourceExpertId}
                  onValueChange={changeSourceExpert}
                  options={agentOptions}
                  label="来源专家"
                  className="w-full sm:w-56"
                />

                {sources.length > 0 ? (
                  <ul aria-label="已选来源会话" className="flex flex-wrap gap-2">
                    {sources.map((source) => {
                      const agentName =
                        agents.find((agent) => agent.id === source.agentId)?.name ?? source.agentId;
                      return (
                        <li
                          key={source.conversationId}
                          className="inline-flex max-w-full items-center gap-1 rounded-tag bg-sunken px-2 py-1 text-xs text-fg"
                        >
                          <span className="truncate" title={`${agentName} · ${source.title}`}>
                            {source.title || source.conversationId}
                            <span className="ml-1 text-muted-foreground">{agentName}</span>
                          </span>
                          <button
                            type="button"
                            aria-label={`移除来源会话 ${source.title || source.conversationId}`}
                            className="shrink-0 rounded-sm text-muted-foreground hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            disabled={create.isPending}
                            onClick={() =>
                              setSources((previous) =>
                                previous.filter(
                                  (item) => item.conversationId !== source.conversationId,
                                ),
                              )
                            }
                          >
                            <X className="size-3.5" aria-hidden="true" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}

                <div
                  ref={sourcesBoxRef}
                  className="max-h-52 overflow-y-auto overscroll-contain rounded-lg border border-line"
                  aria-invalid={fieldErrors.sources ? true : undefined}
                  aria-describedby={fieldErrors.sources ? 'memory-review-sources-error' : undefined}
                  tabIndex={fieldErrors.sources ? -1 : undefined}
                >
                  {conversations.isPending ? <LoadingState rows={3} /> : null}
                  {conversations.isError ? (
                    <div className="p-3">
                      <ErrorState
                        error={conversations.error}
                        onRetry={() => void conversations.refetch()}
                      />
                    </div>
                  ) : null}
                  {conversations.data ? (
                    conversations.data.length === 0 ? (
                      <p className="px-3 py-4 text-center text-sm text-muted-foreground">
                        该专家还没有会话，先和这位专家对话后再生成提案。
                      </p>
                    ) : (
                      <ul className="divide-y">
                        {conversations.data.map((conversation) => {
                          const checked = sources.some(
                            (source) => source.conversationId === conversation.id,
                          );
                          return (
                            <li key={conversation.id}>
                              <div className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-hover">
                                <Checkbox
                                  id={`memory-review-source-${conversation.id}`}
                                  checked={checked}
                                  disabled={
                                    create.isPending || (!checked && sources.length >= MAX_SOURCES)
                                  }
                                  onCheckedChange={() => toggleSource(conversation)}
                                />
                                <label
                                  htmlFor={`memory-review-source-${conversation.id}`}
                                  className="min-w-0 flex-1 cursor-pointer truncate text-fg"
                                >
                                  {conversation.title || conversation.id}
                                </label>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )
                  ) : null}
                </div>
                {fieldErrors.sources ? (
                  <FieldError id="memory-review-sources-error">{fieldErrors.sources}</FieldError>
                ) : null}
              </Field>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <Field
                className="gap-1.5"
                data-disabled={create.isPending}
                data-invalid={instructionError ? true : undefined}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <FieldLabel htmlFor="memory-review-instruction">审核指令（可选）</FieldLabel>
                  <span
                    id="memory-review-instruction-count"
                    className={
                      instructionLength > INSTRUCTION_MAX_CHARS
                        ? 'text-xs text-danger'
                        : 'text-xs text-muted-foreground'
                    }
                  >
                    {instructionLength} / {INSTRUCTION_MAX_CHARS}
                  </span>
                </div>
                <Textarea
                  id="memory-review-instruction"
                  value={instruction}
                  disabled={create.isPending}
                  placeholder="例如：只整理长期有效的偏好"
                  aria-invalid={instructionError ? true : undefined}
                  aria-describedby={
                    instructionError
                      ? 'memory-review-instruction-count memory-review-instruction-error'
                      : 'memory-review-instruction-count'
                  }
                  onChange={(event) => {
                    setInstruction(event.target.value);
                    setFieldErrors((previous) => clearFieldErrors(previous, 'instruction'));
                  }}
                />
                {instructionError ? (
                  <FieldError id="memory-review-instruction-error">{instructionError}</FieldError>
                ) : null}
              </Field>

              {modelAgent ? (
                <p className="text-sm text-muted-foreground">
                  将使用「{modelAgent.name}」{modelAgent.model ? `（${modelAgent.model}）` : ''}
                  {modelAgent.maxBudgetUsd === undefined
                    ? ''
                    : `，单次预算上限 $${modelAgent.maxBudgetUsd}`}
                  {modelAgent.timeoutMs === undefined
                    ? ''
                    : ` / 超时 ${formatTimeout(modelAgent.timeoutMs)}`}
                  。
                </p>
              ) : null}
            </>
          ) : null}

          {step === 3 ? (
            <div className="flex flex-col gap-4">
              <div>
                <h3 className="text-sm font-medium text-fg">确认生成</h3>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  核对来源、写入目标与执行专家后再生成；生成结果仍需审核才会写入。
                </p>
              </div>
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
                <dt className="text-muted-foreground">来源专家</dt>
                <dd className="min-w-0 text-fg">
                  {sourceAgent?.name ?? sourceExpertId}
                  <ul className="mt-1 flex flex-col gap-1 text-muted-foreground">
                    {sources.map((source) => (
                      <li key={source.conversationId} className="break-words">
                        {source.title || source.conversationId}
                      </li>
                    ))}
                  </ul>
                </dd>

                <dt className="text-muted-foreground">写入目标</dt>
                <dd className="min-w-0 text-fg">
                  {summaryTargetDisplay.label}
                  {summaryTargetDisplay.detail ? (
                    <span className="ml-1.5 text-muted-foreground">
                      {summaryTargetDisplay.detail}
                    </span>
                  ) : null}
                  {summaryTargetDisplay.shared ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      这是专家的共享目标，不是个人记忆。
                    </p>
                  ) : null}
                </dd>

                <dt className="text-muted-foreground">执行专家</dt>
                <dd className="min-w-0 text-fg">
                  {modelAgent?.name ?? modelAgentId}
                  {modelAgent?.model ? (
                    <span className="ml-1.5 text-muted-foreground">{modelAgent.model}</span>
                  ) : null}
                  {modelAgent?.maxBudgetUsd === undefined ? null : (
                    <span className="ml-1.5 text-muted-foreground">
                      单次预算上限 ${modelAgent.maxBudgetUsd}
                    </span>
                  )}
                  {modelAgent?.timeoutMs === undefined ? null : (
                    <span className="ml-1.5 text-muted-foreground">
                      超时 {formatTimeout(modelAgent.timeoutMs)}
                    </span>
                  )}
                </dd>

                <dt className="text-muted-foreground">可选要求</dt>
                <dd className="min-w-0 whitespace-pre-wrap text-fg">
                  {instruction.trim() === '' ? '无' : instruction}
                </dd>
              </dl>
            </div>
          ) : null}

          {fieldErrors.form ? <FieldError>{fieldErrors.form}</FieldError> : null}

          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-xs text-muted-foreground">第 {step} / 3 步</span>
            <Button
              type="button"
              variant="outline"
              disabled={create.isPending}
              onClick={requestClose}
            >
              取消
            </Button>
            {step === 1 ? (
              <Button
                type="button"
                onClick={(event) => {
                  // 浏览器在事件派发后才执行默认动作；React 可能已把同一位置复用成 submit。
                  event.preventDefault();
                  goNext();
                }}
              >
                下一步
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={create.isPending}
                  onClick={goBack}
                >
                  上一步
                </Button>
                {step === 2 ? (
                  <Button
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      goNext();
                    }}
                  >
                    下一步
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    disabled={create.isPending || !canUseAgents}
                    aria-busy={create.isPending}
                  >
                    {create.isPending ? '提交中…' : '生成提案'}
                  </Button>
                )}
              </>
            )}
          </div>
        </form>
      </DialogShell>

      <ConfirmDialog
        open={discardOpen || leaving}
        onClose={() => {
          setDiscardOpen(false);
          blocker.reset?.();
        }}
        title="放弃新建的提案？"
        description={leaving ? '离开后，已填写的内容不会保留。' : '关闭后，已填写的内容不会保留。'}
        confirmLabel={leaving ? '放弃并离开' : '放弃并关闭'}
        confirmDisabled={create.isPending}
        onConfirm={async () => {
          setDiscardOpen(false);
          if (leaving) {
            blocker.proceed();
            return;
          }
          setClosing(true);
        }}
      />
    </Dialog>
  );
}

function MemoryReviewDetail({
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
  /** 当前目标专家对应的读/写叶；个人目标恒为真。 */
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
  // 采纳后目标就是新内容；拒绝时目标未变，链接文案必须说明看的是“当前”内容。
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
      <Link
        to="/personal/memory"
        className="text-primary underline underline-offset-4 hover:text-primary-hover"
      >
        {targetLinkLabel}
      </Link>
    ) : (
      <Link
        to="/agents/$agentId"
        params={{ agentId: review.target.agentId }}
        search={{ tab: review.target.kind === 'agent_memory' ? 'memory' : 'rules' }}
        className="text-primary underline underline-offset-4 hover:text-primary-hover"
      >
        {targetLinkLabel}
      </Link>
    );
  const active = review.status === 'queued' || review.status === 'running';
  const succeeded = review.status === 'succeeded';
  const candidate = review.proposal?.proposedContent ?? null;
  const hasChanges = reviewHasChanges(review);
  // 无变化时没有可对比的两栏；只把当前内容作为一次独立阅读展示。
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
  // 专家目标的读/写叶与后端一致：采纳/拒绝需要读+写，回滚只需写。
  const canActOnTarget = canReadTarget && canWriteTarget;

  useEffect(() => onPendingChange(pending), [pending, onPendingChange]);
  useEffect(() => () => onPendingChange(false), [onPendingChange]);

  const applyReview = (): void => {
    onActionError(null);
    apply.mutate(review.runId, {
      onSuccess: () => toastSuccess('已采用提案'),
      onError: (error) =>
        onActionError(
          error instanceof ApiError && error.status === 409 && error.message.includes('修改')
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
        <h3 className="text-sm font-medium text-fg">写入目标</h3>
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
            <h3 className="text-sm font-medium text-fg">当前内容</h3>
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
            <h3 className="text-sm font-medium text-fg">
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
            <h3 className="text-sm font-medium text-fg">提案内容</h3>
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
            <h3 className="text-sm font-medium text-fg">索引修改前内容</h3>
            <CodeBlock
              code={review.before.index?.content ?? ''}
              maxHeight="none"
              copyable={false}
              className={REVIEW_CODE_CLASS}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <h3 className="text-sm font-medium text-fg">索引提案内容</h3>
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
          <h3 className="text-sm font-medium text-fg">理由</h3>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg">
            {review.proposal.summary}
          </p>
        </section>
      ) : null}

      {review.proposal && review.proposal.evidence.length > 0 ? (
        <section aria-label="证据" className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-fg">证据</h3>
          <ul className="flex flex-col gap-2">
            {review.proposal.evidence.map((evidence) => (
              <li
                key={`${evidence.messageId}:${evidence.kind}:${evidence.quote}`}
                className="border-l-2 border-line-strong/70 pl-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-tag bg-sunken px-1.5 py-0.5 text-2xs text-muted-foreground">
                    {evidenceKindLabel[evidence.kind]}
                  </span>
                  <span className="font-mono text-2xs text-muted-foreground">
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
          <h3 className="text-sm font-medium text-fg">来源</h3>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {review.sources.map((source) =>
              canReadConversations ? (
                <Link
                  key={source.conversationId}
                  to="/chat"
                  search={{ conversation: source.conversationId }}
                  aria-disabled={pending || undefined}
                  onClick={(event) => {
                    // 保留链接语义；在途操作结算前只阻止离开，不伪造一次导航。
                    if (pending) event.preventDefault();
                  }}
                  className={
                    pending
                      ? 'cursor-not-allowed text-muted-foreground underline underline-offset-4'
                      : 'text-primary underline underline-offset-4 hover:text-primary-hover'
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
