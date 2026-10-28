import type {
  PublicQuestionResponse,
  PublicRunQuestion,
  RunQuestionStatus,
} from '@agentport/shared';
import { MessageCircleQuestion } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { errorMessage } from '../lib/api.js';
import { useRespondToQuestion } from '../lib/queries.js';
import { Button } from './ui/button.js';
import { Checkbox } from './ui/checkbox.js';
import { Field, FieldGroup, FieldLabel } from './ui/field.js';
import { Label } from './ui/label.js';
import { RadioGroup, RadioGroupItem } from './ui/radio-group.js';
import { Textarea } from './ui/textarea.js';

const OTHER = '__other__';

const statusLabel: Record<RunQuestionStatus, string> = {
  pending: '待回答',
  answered: '已回答',
  declined: '暂不回答',
  closed: '已关闭',
};

type PublicQuestion = PublicRunQuestion['questions'][number];

interface AnswerDraft {
  picked: string[];
  otherOn: boolean;
  other: string;
}

const EMPTY: AnswerDraft = { picked: [], otherOn: false, other: '' };

/**
 * 服务端已把选项投影成稳定的 value（原数组序号）；这里只回传 value 与自由文本。
 * 「其他」未勾选时即使还留着隐藏输入值也不能带进回答。
 */
function answerOf(
  question: PublicQuestion,
  draft: AnswerDraft,
): { choices: string[]; text: string } | null {
  const choices = question.options
    .filter((option) => draft.picked.includes(option.value))
    .map((option) => option.value);
  const text = draft.otherOn ? draft.other.trim() : '';
  if (question.multiSelect) return choices.length > 0 || text ? { choices, text } : null;
  if (draft.otherOn) return text ? { choices: [], text } : null;
  return choices.length > 0 ? { choices, text: '' } : null;
}

function statusHeading(question: PublicRunQuestion, live: boolean, expired: boolean): string {
  if (question.status === 'pending') {
    if (expired) return '已失效';
    if (!live) return statusLabel.pending;
    return '需要你的回答';
  }
  return statusLabel[question.status];
}

/** 已回答 / 拒绝 / 关闭、过期以及离开实时运行后的只读快照；不提供任何回答入口。 */
function ReadOnlyQuestion({
  question,
  live,
  expired,
}: {
  question: PublicRunQuestion;
  live: boolean;
  expired: boolean;
}) {
  const pending = question.status === 'pending';
  return (
    <div className="flex flex-col gap-2 rounded-card border bg-surface px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-fg">
        <MessageCircleQuestion
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        {statusHeading(question, live, expired)}
      </div>
      <dl className="flex flex-col gap-2">
        {question.questions.map((item, index) => (
          <div key={item.question} className="flex flex-col gap-0.5">
            <dt className="text-sm text-fg [overflow-wrap:anywhere]">{item.question}</dt>
            {question.answers === null ? null : (
              <dd className="whitespace-pre-wrap text-sm text-muted-foreground [overflow-wrap:anywhere]">
                {question.answers[String(index)] ?? '—'}
              </dd>
            )}
          </div>
        ))}
      </dl>
      {pending && expired ? (
        <p className="text-xs text-muted-foreground">已超过回答时限，无法提交。</p>
      ) : pending ? (
        <p className="text-xs text-muted-foreground">请在发起该提问的会话中回答。</p>
      ) : null}
    </div>
  );
}

/**
 * 官方 AskUserQuestion 的宿主表单：chat 工具位与运行详情共用。
 * `live` 由所在页面判断（当前运行仍在进行），终态或历史快照只读。
 */
export function RunQuestionCard({
  question,
  live,
}: {
  question: PublicRunQuestion;
  live: boolean;
}) {
  const respond = useRespondToQuestion();
  const baseId = useId();
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({});
  const [now, setNow] = useState(() => Date.now());
  const deadline = Date.parse(question.expiresAt);
  const expired = Number.isFinite(deadline) && now >= deadline;

  // 打开的表单跨过期限也要立即变成只读，不依赖 worker 到时关闭记录。
  useEffect(() => {
    if (!Number.isFinite(deadline)) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        setNow(Date.now());
        return;
      }
      // 超过 setTimeout 上限的期限分段等待，避免被浏览器当成 0 毫秒立即触发。
      timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [deadline]);

  const draftFor = (index: number): AnswerDraft => drafts[index] ?? EMPTY;
  const update = (index: number, next: AnswerDraft) =>
    setDrafts((previous) => ({ ...previous, [index]: next }));

  const answers: Record<string, string> = {};
  const choices: Record<string, string[]> = {};
  let complete = true;
  for (const [index, item] of question.questions.entries()) {
    const answer = answerOf(item, draftFor(index));
    if (answer === null) {
      complete = false;
      continue;
    }
    const key = String(index);
    if (answer.text) answers[key] = answer.text;
    if (answer.choices.length > 0) choices[key] = answer.choices;
  }
  const response: PublicQuestionResponse =
    Object.keys(choices).length > 0 ? { answers, choices } : { answers };

  if (!live || question.status !== 'pending' || expired) {
    return <ReadOnlyQuestion question={question} live={live} expired={expired} />;
  }

  const submit = () => {
    if (!complete) return;
    respond.mutate({
      runId: question.runId,
      requestId: question.requestId,
      response,
    });
  };
  const decline = () => {
    respond.mutate({
      runId: question.runId,
      requestId: question.requestId,
      response: { decline: true },
    });
  };

  return (
    <div className="flex flex-col gap-3 rounded-card border bg-surface px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-fg">
        <MessageCircleQuestion
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        需要你的回答
      </div>
      <FieldGroup className="gap-3">
        {question.questions.map((item, index) => {
          const draft = draftFor(index);
          const groupId = `${baseId}-${index}`;
          const otherId = `${groupId}-other`;
          const otherInputId = `${groupId}-other-input`;
          return (
            <fieldset
              key={item.question}
              disabled={respond.isPending}
              className="flex min-w-0 flex-col gap-1.5"
            >
              <legend className="text-sm font-medium text-fg [overflow-wrap:anywhere]">
                {item.question}
              </legend>
              {item.multiSelect ? (
                <div className="flex flex-col gap-1.5">
                  {item.options.map((option) => {
                    const id = `${groupId}-${option.value}`;
                    return (
                      <div key={option.value} className="flex items-start gap-2">
                        <Checkbox
                          id={id}
                          className="mt-0.5"
                          disabled={respond.isPending}
                          checked={draft.picked.includes(option.value)}
                          onCheckedChange={(checked) =>
                            update(index, {
                              picked: checked
                                ? [...draft.picked, option.value]
                                : draft.picked.filter((picked) => picked !== option.value),
                              otherOn: draft.otherOn,
                              other: draft.other,
                            })
                          }
                        />
                        <div className="flex min-w-0 flex-col">
                          <Label htmlFor={id}>{option.label}</Label>
                          {option.description ? (
                            <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                              {option.description}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={otherId}
                      disabled={respond.isPending}
                      checked={draft.otherOn}
                      onCheckedChange={(checked) => update(index, { ...draft, otherOn: checked })}
                    />
                    <Label htmlFor={otherId}>其他</Label>
                  </div>
                </div>
              ) : (
                <RadioGroup
                  disabled={respond.isPending}
                  value={draft.otherOn ? OTHER : (draft.picked[0] ?? '')}
                  onValueChange={(value) =>
                    update(
                      index,
                      value === OTHER
                        ? { ...draft, picked: [], otherOn: true }
                        : { picked: [value], otherOn: false, other: '' },
                    )
                  }
                >
                  {item.options.map((option) => {
                    const id = `${groupId}-${option.value}`;
                    return (
                      <div key={option.value} className="flex items-start gap-2">
                        <RadioGroupItem
                          id={id}
                          value={option.value}
                          disabled={respond.isPending}
                          className="mt-0.5"
                        />
                        <div className="flex min-w-0 flex-col">
                          <Label htmlFor={id}>{option.label}</Label>
                          {option.description ? (
                            <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                              {option.description}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                  <div className="flex items-center gap-2">
                    <RadioGroupItem id={otherId} value={OTHER} disabled={respond.isPending} />
                    <Label htmlFor={otherId}>其他</Label>
                  </div>
                </RadioGroup>
              )}
              {draft.otherOn ? (
                <Field>
                  <FieldLabel htmlFor={otherInputId}>其他答案</FieldLabel>
                  <Textarea
                    id={otherInputId}
                    disabled={respond.isPending}
                    value={draft.other}
                    onChange={(event) => update(index, { ...draft, other: event.target.value })}
                  />
                </Field>
              ) : null}
            </fieldset>
          );
        })}
      </FieldGroup>
      {respond.isError ? (
        <p role="alert" className="text-xs text-danger [overflow-wrap:anywhere]">
          {errorMessage(respond.error)}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" disabled={respond.isPending} onClick={decline}>
          暂不回答
        </Button>
        <Button
          size="sm"
          disabled={!complete || respond.isPending}
          aria-busy={respond.isPending}
          onClick={submit}
        >
          {respond.isPending ? '提交中…' : '提交回答'}
        </Button>
      </div>
    </div>
  );
}
