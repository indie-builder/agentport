import { fail } from '@agentport/core';
import type { NativeQuestions, PublicQuestionResponse, RunQuestion } from '@agentport/shared';
import { questionPhase, questionResponseSchema } from '@agentport/shared';
import { and, asc, eq, lte } from 'drizzle-orm';
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

export async function expireStaleQuestions(
  db: Database,
  input: { runId: string; now?: Date },
): Promise<RunQuestion[]> {
  const now = input.now ?? new Date();
  const rows = await db
    .update(runQuestions)
    .set({ status: 'expired', closeReason: '超时未回答', resolvedAt: now })
    .where(
      and(
        eq(runQuestions.runId, input.runId),
        eq(runQuestions.status, 'pending'),
        lte(runQuestions.expiresAt, now),
      ),
    )
    .returning();
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

export function buildQuestionAnswers(
  questions: NativeQuestions,
  response: Extract<PublicQuestionResponse, { answers: Record<string, string> }>,
) {
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

export async function respondToQuestion(
  db: Database,
  runId: string,
  requestId: string,
  response: PublicQuestionResponse,
): Promise<RunQuestion | null> {
  const result = await db.transaction(async (tx) => {
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

    const answers = 'decline' in response ? null : buildQuestionAnswers(row.questions, response);
    const unchanged =
      'decline' in response
        ? row.status === 'declined'
        : row.status === 'answered' && answers !== null && sameAnswers(row.answers, answers);
    if (row.status !== 'pending') {
      if (unchanged) return { question: toRunQuestion(row) };
      if (row.status === 'closed') fail('CONFLICT', '这次提问已关闭，无法回答');
      if (row.status === 'expired') fail('CONFLICT', '这次提问已过期，无法回答');
      fail('CONFLICT', '这次提问已经回答过，不能覆盖');
    }
    if (run.status !== 'running') fail('CONFLICT', '运行已结束，无法回答这次提问');
    if (questionPhase(row) !== 'pending') {
      await tx
        .update(runQuestions)
        .set({ status: 'expired', closeReason: '超时未回答', resolvedAt: new Date() })
        .where(and(eq(runQuestions.id, row.id), eq(runQuestions.status, 'pending')));
      return { expired: true };
    }

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
    return { question: toRunQuestion(updated) };
  });
  if (result === null) return null;
  if ('expired' in result) fail('CONFLICT', '这次提问已过期，无法回答');
  return result.question;
}

export async function closeQuestions(
  db: Database,
  runId: string,
  reason: string,
  requestId?: string,
): Promise<RunQuestion[]> {
  const now = new Date();
  const matching = and(
    eq(runQuestions.runId, runId),
    eq(runQuestions.status, 'pending'),
    ...(requestId === undefined ? [] : [eq(runQuestions.requestId, requestId)]),
  );
  return db.transaction(async (tx) => {
    const expired = await tx
      .update(runQuestions)
      .set({ status: 'expired', closeReason: '超时未回答', resolvedAt: now })
      .where(and(matching, lte(runQuestions.expiresAt, now)))
      .returning();
    const closed = await tx
      .update(runQuestions)
      .set({ status: 'closed', closeReason: reason, resolvedAt: now })
      .where(matching)
      .returning();
    return [...expired, ...closed].map(toRunQuestion);
  });
}
