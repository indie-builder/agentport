import type { PublicRunQuestion } from '@agentport/shared';
import { Bot, User, Wrench } from 'lucide-react';
import type { RunStep } from '../../lib/api.js';
import { questionFromContent } from '../../lib/chat-state.js';
import { formatDateTime, shortId } from '../../lib/format.js';
import { CodeBlock, CollapsibleText, prettyJson } from '../code-block.js';
import { CopyButton } from '../copy-button.js';
import { RunQuestionCard } from './run-question.js';

export const stepIcons = { user: User, assistant: Bot, tool: Wrench } as const;

export function stepName(step: RunStep): string {
  if (step.kind === 'tool') return step.name ?? '未知工具';
  return step.kind === 'user' ? '用户消息' : '助手回复';
}

/**
 * 工具步骤对应的提问：以该 run 的提问列表为准（回答状态会变化）。
 * 运行步骤可能只保留工具参数，因此再按 toolUseId 对齐；历史快照作兜底。
 * 运行结束后提问不会再有新状态，以落库的最终快照为准，避免接口旧 pending 或 404。
 */
export function questionForStep(
  step: RunStep,
  questionsByToolUseId: ReadonlyMap<string, PublicRunQuestion>,
  live: boolean,
): PublicRunQuestion | undefined {
  if (step.kind !== 'tool') return undefined;
  const snapshot =
    step.question ?? questionFromContent(step.content) ?? questionFromContent(step.result);
  const current = step.toolUseId === null ? undefined : questionsByToolUseId.get(step.toolUseId);
  return live ? (current ?? snapshot) : (snapshot ?? current);
}

export function StepInspector({
  step,
  index,
  question,
  live,
}: {
  step: RunStep;
  index: number;
  question?: PublicRunQuestion | undefined;
  live: boolean;
}) {
  const input = step.kind === 'tool' ? (step.content ?? null) : null;
  const output = step.kind === 'tool' ? (step.result ?? null) : null;
  const nested = step.kind === 'tool' && step.parentToolUseId !== null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b pb-3">
        <span className="font-mono text-2xs tabular-nums text-muted-foreground">#{index + 1}</span>
        <span className="min-w-0 break-all font-mono text-xs text-fg">{stepName(step)}</span>
        <span className="font-mono text-2xs tabular-nums text-muted-foreground">
          事件时间 {formatDateTime(step.at)}
        </span>
        {nested ? (
          <span className="rounded-tag bg-chip px-1.5 py-0.5 text-2xs text-muted-foreground">
            子智能体内部调用
          </span>
        ) : null}
        {step.kind === 'tool' && step.toolUseId ? (
          <span
            className="rounded-tag bg-chip px-1.5 py-0.5 font-mono text-2xs text-muted-foreground"
            title={step.toolUseId}
          >
            {shortId(step.toolUseId)}
          </span>
        ) : null}
      </div>

      {question ? (
        <RunQuestionCard key={question.requestId} question={question} live={live} />
      ) : null}

      {step.kind === 'assistant' || step.kind === 'user' ? (
        <CollapsibleText
          text={step.text}
          className="whitespace-pre-wrap [overflow-wrap:anywhere] text-md text-fg"
        />
      ) : (
        <>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">参数</span>
              {input !== null ? <CopyButton value={prettyJson(input)} label="复制参数" /> : null}
            </div>
            {input !== null ? (
              <CodeBlock code={prettyJson(input)} json maxHeight="18rem" />
            ) : (
              <p className="text-xs text-muted-foreground">无参数。</p>
            )}
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">结果</span>
              {output !== null ? <CopyButton value={prettyJson(output)} label="复制结果" /> : null}
            </div>
            {output !== null ? (
              <CodeBlock code={prettyJson(output)} json maxHeight="22rem" />
            ) : (
              <p className="text-xs text-muted-foreground">
                没有结果：可能等待批准、被拒绝，或运行在返回前结束。
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
