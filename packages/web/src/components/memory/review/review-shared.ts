import type { MemoryReview, MemoryReviewEvidenceKind, MemoryReviewTarget } from '@agentport/shared';
import { memoryFileNameSchema, memoryReviewHasChanges, slugSchema } from '@agentport/shared';
import type { AgentSummary } from '../../../lib/api.js';

export const INSTRUCTION_MAX_CHARS = 4000;
export const MAX_SOURCES = 10;

export type TargetKind = MemoryReviewTarget['kind'];

export type MemoryReviewView = 'pending' | 'generating' | 'aborted' | 'done';

export const reviewViewOptions = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待审核' },
  { value: 'generating', label: '生成中' },
  { value: 'aborted', label: '已中断' },
  { value: 'done', label: '已处理' },
] as const;

export const allTargetKindOptions = [
  { value: 'personal', label: '个人记忆' },
  { value: 'agent_memory', label: '专家记忆' },
  { value: 'agent_rule', label: '专家规则' },
] as const;

export const NEW_MEMORY_CHOICE = '__new__';

export const REVIEW_CODE_CLASS =
  'min-w-0 [&_code>span]:min-w-0 [&_code>span>span]:min-w-0 [&_code>span>span]:whitespace-pre-wrap [&_code>span>span]:break-words [&_code>span>span]:[overflow-wrap:anywhere]';

export const evidenceKindLabel: Record<MemoryReviewEvidenceKind, string> = {
  user_fact: '用户事实',
  confirmed_decision: '已确认决定',
  assistant_suggestion: '助手建议',
};

export function targetDisplay(
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

export function memoryFileNameOf(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
}

export function memoryFormatErrorOf(value: string): string | null {
  if (value.trim() === '') return null;
  const parsed = memoryFileNameSchema.safeParse(memoryFileNameOf(value));
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? '记忆文件名格式不正确');
}

export function slugFormatErrorOf(value: string): string | null {
  if (value === '') return null;
  const parsed = slugSchema.safeParse(value);
  return parsed.success ? null : `规则 slug ${parsed.error.issues[0]?.message ?? '格式不正确'}。`;
}

export function reviewHasChanges(review: MemoryReview): boolean {
  return (
    review.proposal !== null &&
    memoryReviewHasChanges(review.target, review.before, review.proposal)
  );
}

export function reviewViewOf(review: MemoryReview): MemoryReviewView {
  if (review.status === 'queued' || review.status === 'running') return 'generating';
  if (review.status !== 'succeeded') return 'aborted';
  if (review.decision === 'pending' && reviewHasChanges(review)) return 'pending';
  return 'done';
}

export const reviewViewPriority: Record<MemoryReviewView, number> = {
  pending: 0,
  generating: 1,
  aborted: 2,
  done: 3,
};

export function formatTimeout(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} 分钟` : `${Math.round(ms / 1000)} 秒`;
}

export function decisionDisplay(
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
