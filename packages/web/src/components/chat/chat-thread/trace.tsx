import type { PublicRunQuestion } from '@agentport/shared';
import { CircleAlert, ListChecks, LoaderCircle, Wrench } from 'lucide-react';
import { lazy, memo, Suspense, useEffect, useState } from 'react';
import type { ApprovalRequest } from '../../../lib/api.js';
import { type ChatItem, toolFailed } from '../../../lib/chat-state.js';
import { cn } from '../../../lib/cn.js';
import { dataDomainResultFromTool } from '../../../lib/data-domain-result.js';
import { formatDuration } from '../../../lib/format.js';
import { JsonBlock } from '../../code-block.js';
import { KnowledgeCitations, knowledgeHitsFromTool } from '../../knowledge/knowledge-citations.js';
import { RunQuestionCard } from '../../run/run-question.js';
import { Skeleton } from '../../ui/skeleton.js';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '../../ui/trace.js';
import { ApprovalCard } from './approval.js';

const DataDomainResultView = lazy(() =>
  import('./data-domain-result.js').then((module) => ({ default: module.DataDomainResultView })),
);

function toolRunning(item: ToolItem): boolean {
  return item.result === undefined && item.startedAt !== undefined && item.endedAt === undefined;
}

function toolNeedsAttention(
  item: ToolItem,
  kids: ToolItem[],
  approvalHosts: ReadonlyMap<string, ApprovalRequest>,
  questionsByToolUseId: ReadonlyMap<string, PublicRunQuestion> | undefined,
): boolean {
  if (approvalHosts.has(item.toolUseId)) return true;
  if ((questionsByToolUseId?.get(item.toolUseId) ?? item.question) !== undefined) return true;
  if (item.result === undefined ? !toolRunning(item) : toolFailed(item.result)) return true;
  return kids.some((kid) => toolNeedsAttention(kid, NO_KIDS, approvalHosts, questionsByToolUseId));
}

export function foldableToolRoots(
  items: ChatItem[],
  structure: ReturnType<typeof buildStructure>,
  approvalHosts: ReadonlyMap<string, ApprovalRequest>,
  questionsByToolUseId: ReadonlyMap<string, PublicRunQuestion> | undefined,
): ToolItem[] {
  return items.filter(
    (item): item is ToolItem =>
      item.kind === 'tool' &&
      !structure.root.has(item.toolUseId) &&
      !toolNeedsAttention(
        item,
        structure.kids.get(item.toolUseId) ?? NO_KIDS,
        approvalHosts,
        questionsByToolUseId,
      ),
  );
}

export const TurnTrace = memo(function TurnTrace({
  roots,
  kids,
  approvalHosts,
  pending,
  onApprove,
  questionsByToolUseId,
  liveRunId,
  live,
}: {
  roots: ToolItem[];
  kids: ReadonlyMap<string, ToolItem[]>;
  approvalHosts: ReadonlyMap<string, ApprovalRequest>;
  pending: string | null;
  onApprove: ((item: ApprovalRequest) => void) | undefined;
  questionsByToolUseId?: ReadonlyMap<string, PublicRunQuestion> | undefined;
  liveRunId: string | null;
  live: boolean;
}) {
  const anyRunning = roots.some(
    (root) => toolRunning(root) || (kids.get(root.toolUseId) ?? NO_KIDS).some(toolRunning),
  );
  const [open, setOpen] = useState(live || anyRunning);
  useEffect(() => setOpen(live || anyRunning), [live, anyRunning]);
  return (
    <Trace>
      <TraceCollapsible open={open} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine status={anyRunning ? 'running' : undefined}>
            <TraceIcon>
              {anyRunning ? (
                <span className="quiet-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              ) : (
                <ListChecks />
              )}
            </TraceIcon>
            <TraceTitle>执行过程</TraceTitle>
            <TraceDescription>{anyRunning ? '运行中' : '已完成'}</TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <div className="flex flex-col gap-1">
            {roots.map((root) => (
              <ToolGroup
                key={root.toolUseId}
                tool={root}
                kids={kids.get(root.toolUseId) ?? NO_KIDS}
                approvalHosts={approvalHosts}
                pending={pending}
                onApprove={onApprove}
                questionsByToolUseId={questionsByToolUseId}
                liveRunId={liveRunId}
              />
            ))}
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
});

export const ToolGroup = memo(function ToolGroup({
  tool,
  kids,
  approvalHosts,
  pending,
  onApprove,
  questionsByToolUseId,
  liveRunId,
}: {
  tool: ToolItem;
  kids: ToolItem[];
  approvalHosts: ReadonlyMap<string, ApprovalRequest>;
  pending: string | null;
  onApprove: ((item: ApprovalRequest) => void) | undefined;
  questionsByToolUseId?: ReadonlyMap<string, PublicRunQuestion> | undefined;
  liveRunId: string | null;
}) {
  const approval = approvalHosts.get(tool.toolUseId);
  const question = questionsByToolUseId?.get(tool.toolUseId) ?? tool.question;
  return (
    <>
      <div className="flex flex-col gap-1.5">
        {question ? (
          <RunQuestionCard
            key={question.requestId}
            question={question}
            live={liveRunId !== null && question.runId === liveRunId}
          />
        ) : (
          <ToolRow
            item={tool}
            nested={tool.parentToolUseId !== undefined}
            childCount={kids.length}
          />
        )}
        {approval && onApprove ? (
          <ApprovalCard item={approval} pending={pending} onApprove={onApprove} />
        ) : null}
      </div>
      {kids.map((child) => {
        const childApproval = approvalHosts.get(child.toolUseId);
        const childQuestion = questionsByToolUseId?.get(child.toolUseId) ?? child.question;
        return (
          <div key={`${child.toolUseId}-child`} className="flex flex-col gap-1.5">
            {childQuestion ? (
              <RunQuestionCard
                key={childQuestion.requestId}
                question={childQuestion}
                live={liveRunId !== null && childQuestion.runId === liveRunId}
              />
            ) : (
              <ToolRow item={child} nested={true} childCount={0} />
            )}
            {childApproval && onApprove ? (
              <ApprovalCard item={childApproval} pending={pending} onApprove={onApprove} />
            ) : null}
          </div>
        );
      })}
    </>
  );
});

function approvalMatchesTool(item: ToolItem, approval: ApprovalRequest): boolean {
  return approval.serverName
    ? item.name === `mcp__${approval.serverName}__${approval.toolName}`
    : item.name === approval.toolName || item.name.endsWith(`__${approval.toolName}`);
}

export function assignApprovals(
  turnTools: ToolItem[],
  approvalItems: ApprovalRequest[],
): Map<string, ApprovalRequest> {
  const hosts = new Map<string, ApprovalRequest>();
  for (const approval of approvalItems) {
    const candidates = turnTools.filter((tool) => approvalMatchesTool(tool, approval));
    const awaiting = candidates.filter((tool) => tool.result === undefined);
    const host =
      candidates.length === 1 ? candidates[0] : awaiting.length === 1 ? awaiting[0] : undefined;
    if (host) hosts.set(host.toolUseId, approval);
  }
  return hosts;
}

export type ToolItem = Extract<ChatItem, { kind: 'tool' }>;
export const NO_KIDS: ToolItem[] = [];

export function isTool(item: ChatItem): item is ToolItem {
  return item.kind === 'tool';
}

export function stableTools(items: ChatItem[], previous: ToolItem[]): ToolItem[] {
  const tools = items.filter(isTool);
  if (tools.length !== previous.length) return tools;
  for (let index = 0; index < tools.length; index += 1) {
    if (tools[index] !== previous[index]) return tools;
  }
  return previous;
}

export function buildStructure(tools: ToolItem[]): {
  root: Map<string, string>;
  kids: Map<string, ToolItem[]>;
} {
  const toolById = new Map<string, ToolItem>();
  for (const item of tools) toolById.set(item.toolUseId, item);
  const rootOf = (item: ToolItem): string | null => {
    let node = item.parentToolUseId ? toolById.get(item.parentToolUseId) : undefined;
    let depth = 0;
    while (node?.parentToolUseId && depth < 8) {
      const up = toolById.get(node.parentToolUseId);
      if (!up) break;
      node = up;
      depth += 1;
    }
    return node?.toolUseId ?? null;
  };
  const root = new Map<string, string>();
  const kids = new Map<string, ToolItem[]>();
  for (const item of tools) {
    if (item.parentToolUseId === undefined) continue;
    const top = rootOf(item);
    if (top === null) continue;
    root.set(item.toolUseId, top);
    const list = kids.get(top) ?? [];
    list.push(item);
    kids.set(top, list);
  }
  return { root, kids };
}

const ToolRow = memo(function ToolRow({
  item,
  nested,
  childCount,
}: {
  item: Extract<ChatItem, { kind: 'tool' }>;
  nested: boolean;
  childCount: number;
}) {
  const running =
    item.result === undefined && item.startedAt !== undefined && item.endedAt === undefined;
  const missing = !running && item.result === undefined;
  const failed = toolFailed(item.result);
  const cited = knowledgeHitsFromTool(item.name, item.result)?.length ?? 0;
  const dataDomainResult = dataDomainResultFromTool(item.name, item.result);
  const status = running ? '运行中' : missing ? '未收到结果' : failed ? '失败' : '完成';
  const lineStatus = running ? 'running' : missing ? 'pending' : failed ? 'error' : undefined;
  const [open, setOpen] = useState(running);

  useEffect(() => {
    setOpen(running);
  }, [running]);

  const duration =
    item.startedAt !== undefined && item.endedAt !== undefined
      ? item.endedAt - item.startedAt
      : undefined;

  return (
    <TraceCollapsible
      open={open}
      onOpenChange={setOpen}
      className={cn('min-w-0', nested && 'ml-4')}
    >
      <TraceCollapsibleTrigger>
        <TraceLine status={lineStatus}>
          <TraceIcon>
            {running ? (
              <LoaderCircle className="animate-spin" />
            ) : missing || failed ? (
              <CircleAlert />
            ) : (
              <Wrench />
            )}
          </TraceIcon>
          <TraceTitle className="font-mono text-xs text-fg">{item.name}</TraceTitle>
          <TraceDescription>
            {status}
            {duration === undefined ? '' : ` · ${formatDuration(duration)}`}
            {dataDomainResult === null ? '' : ` · ${dataDomainResult.rowCount} 行`}
            {cited > 0 ? ` · ${cited} 来源` : ''}
          </TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-2">
        {childCount > 0 ? (
          <p className="text-xs text-muted-foreground">子智能体 · {childCount} 次调用</p>
        ) : null}
        <div className="min-w-0">
          <div className="mb-1 text-2xs uppercase tracking-[0.06em] text-muted-foreground">
            参数
          </div>
          {item.input !== undefined ? (
            <JsonBlock value={item.input} maxHeight="16rem" />
          ) : (
            <p className="text-2xs text-muted-foreground">{running ? '等待参数…' : '未收到参数'}</p>
          )}
        </div>
        <div className="min-w-0">
          <div className="mb-1 text-2xs uppercase tracking-[0.06em] text-muted-foreground">
            结果
          </div>
          {item.result !== undefined ? (
            dataDomainResult === null ? (
              <>
                <JsonBlock value={item.result} maxHeight="20rem" />
                <div className="mt-2">
                  <KnowledgeCitations name={item.name} result={item.result} />
                </div>
              </>
            ) : (
              <Suspense fallback={<Skeleton className="h-16 w-full" />}>
                <DataDomainResultView result={dataDomainResult} />
              </Suspense>
            )
          ) : (
            <p className="text-2xs text-muted-foreground">{running ? '等待结果…' : '未收到结果'}</p>
          )}
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
});
