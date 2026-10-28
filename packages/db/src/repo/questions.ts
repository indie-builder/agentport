import { fail } from '@agentport/core';
import type { NativeQuestions, PublicQuestionResponse, RunQuestion } from '@agentport/shared';
import { questionResponseSchema } from '@agentport/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { agentRuns, runQuestions } from '../schema.js';

type RunQuestionRow = typeof runQuestions.$inferSelect;

function toRunQuestion(row: RunQuestionRow): RunQuestion {
  return {
    requestId: row.requestId,
    runId: row.runId,
    toolUseId: row.toolUseId,
    questions: row.questions,
    status: row.status,
    answers: row.answers,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt === null ? null : row.resolvedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    closeReason: row.closeReason,
  };
}

export interface CreateQuestionInput {
  runId: string;
  requestId: string;
  toolUseId: string;
  questions: NativeQuestions;
  expiresAt: Date;
}

/** runner 可能重发同一 requestId；重复创建返回已有行，不新增。 */
export async function createQuestion(
  db: Database,
  input: CreateQuestionInput,
): Promise<RunQuestion> {
  const [inserted] = await db
    .insert(runQuestions)
    .values({ id: newId('question'), ...input })
    .onConflictDoNothing()
    .returning();
  if (inserted) return toRunQuestion(inserted);

  const [existing] = await db
    .select()
    .from(runQuestions)
    .where(and(eq(runQuestions.runId, input.runId), eq(runQuestions.requestId, input.requestId)))
    .limit(1);
  if (!existing) fail('INTERNAL_ERROR', '提问记录写入失败');
  return toRunQuestion(existing);
}

export async function listQuestions(db: Database, runId: string): Promise<RunQuestion[]> {
  const rows = await db
    .select()
    .from(runQuestions)
    .where(eq(runQuestions.runId, runId))
    .orderBy(asc(runQuestions.createdAt), asc(runQuestions.id));
  return rows.map(toRunQuestion);
}

function sameAnswers(
  stored: Record<string, string> | null,
  incoming: Record<string, string>,
): boolean {
  if (stored === null) return false;
  const storedKeys = Object.keys(stored);
  const incomingKeys = Object.keys(incoming);
  return (
    storedKeys.length === incomingKeys.length &&
    incomingKeys.every((key) => stored[key] === incoming[key])
  );
}

/**
 * 返回要落库的答案；decline 返回 null。题键必须恰好覆盖本次问题。
 * 映射回原问题文本后必须再按 SDK stdin 的同一 schema 校验整体载荷：
 * 逐题合法不代表原问题键与全部答案合起来能通过 responseBytes。
 */
function answersFor(questions: NativeQuestions, response: PublicQuestionResponse) {
  if ('decline' in response) return null;
  const choices = response.choices ?? {};
  const expected = new Set(questions.map((_, index) => String(index)));
  const keys = new Set([...Object.keys(response.answers), ...Object.keys(choices)]);
  if (keys.size !== expected.size || [...keys].some((key) => !expected.has(key))) {
    fail('CONFLICT', '回答必须对应本次提问的每个问题，不能缺项或夹带额外问题');
  }
  const answers = Object.fromEntries(
    questions.map((item, index) => {
      const key = String(index);
      const text = response.answers[key];
      const selected = choices[key] ?? [];
      if (text !== undefined && text.trim().length === 0) fail('CONFLICT', '回答不能为空');
      const labels = selected.map((value) => {
        const option = item.options.find((_, optionIndex) => String(optionIndex) === value);
        if (option === undefined) fail('CONFLICT', '选项必须对应本次提问的有效选项');
        return option.label;
      });
      if (new Set(selected).size !== selected.length) {
        fail('CONFLICT', '选项不能重复');
      }
      if (
        !item.multiSelect &&
        (selected.length > 1 || (selected.length > 0 && text !== undefined))
      ) {
        fail('CONFLICT', '单选问题只能选择一个选项或填写其他回答');
      }
      const answer = [...labels, ...(text === undefined ? [] : [text])].join(', ');
      if (answer.length === 0) fail('CONFLICT', '回答不能为空');
      return [item.question, answer];
    }),
  );
  const parsed = questionResponseSchema.safeParse({ answers });
  if (!parsed.success) {
    fail('CONFLICT', parsed.error.issues[0]?.message ?? '回答内容超出大小限制');
  }
  return answers;
}

/**
 * 回答入口依次锁 run 与问题行：与取消/结束、问题关闭串行，关闭不得被旧读取覆盖。
 * 已回答/已拒答时同一内容幂等返回，不同内容与已关闭一律 409；找不到提问返回 null。
 */
export async function respondToQuestion(
  db: Database,
  runId: string,
  requestId: string,
  response: PublicQuestionResponse,
): Promise<RunQuestion | null> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1)
      .for('update');
    if (!run) return null;

    const [row] = await tx
      .select()
      .from(runQuestions)
      .where(and(eq(runQuestions.runId, runId), eq(runQuestions.requestId, requestId)))
      .limit(1)
      .for('update');
    if (!row) return null;

    const answers = answersFor(row.questions, response);
    const unchanged =
      'decline' in response
        ? row.status === 'declined'
        : row.status === 'answered' && answers !== null && sameAnswers(row.answers, answers);
    if (row.status !== 'pending') {
      if (unchanged) return toRunQuestion(row);
      if (row.status === 'closed') fail('CONFLICT', '这次提问已关闭，无法回答');
      fail('CONFLICT', '这次提问已经回答过，不能覆盖');
    }
    if (run.status !== 'running') fail('CONFLICT', '运行已结束，无法回答这次提问');
    if (row.expiresAt.getTime() <= Date.now()) fail('CONFLICT', '这次提问已过期，无法回答');

    const [updated] = await tx
      .update(runQuestions)
      .set({
        status: answers === null ? 'declined' : 'answered',
        answers,
        resolvedAt: new Date(),
        closeReason: null,
      })
      .where(eq(runQuestions.id, row.id))
      .returning();
    if (!updated) fail('INTERNAL_ERROR', '回答写入失败');
    return toRunQuestion(updated);
  });
}

/** 只关闭仍 pending 的问题；已回答/已拒答的记录不可覆盖。 */
export async function closeQuestions(
  db: Database,
  runId: string,
  reason: string,
  requestId?: string,
): Promise<RunQuestion[]> {
  const rows = await db
    .update(runQuestions)
    .set({ status: 'closed', closeReason: reason, resolvedAt: new Date() })
    .where(
      and(
        eq(runQuestions.runId, runId),
        eq(runQuestions.status, 'pending'),
        ...(requestId === undefined ? [] : [eq(runQuestions.requestId, requestId)]),
      ),
    )
    .returning();
  return rows.map(toRunQuestion);
}
