import { describe, expect, it } from 'vitest';
import { chatEventSchema } from '../src/chat.js';
import {
  nativeQuestionInputSchema,
  publicQuestionResponseSchema,
  publicRunQuestionSchema,
  QUESTION_LIMITS,
  questionResponseSchema,
  runQuestionSchema,
  sandboxInputCommandSchema,
} from '../src/questions.js';
import { publicRunQuestion, redactSecrets } from '../src/redact.js';

const question = (text: string, multiSelect = false) => ({
  question: text,
  header: '选择',
  options: [
    { label: 'A', description: '第一个' },
    { label: 'B', description: '第二个' },
  ],
  multiSelect,
});

const runQuestion = {
  requestId: 'req-1',
  runId: 'run-1',
  toolUseId: 'tool-1',
  questions: [question('你希望用什么语言？')],
  status: 'pending' as const,
  answers: null,
  createdAt: '2026-10-28T00:00:00.000Z',
  resolvedAt: null,
  expiresAt: '2026-10-28T00:10:00.000Z',
  closeReason: null,
};

describe('native question input', () => {
  it('accepts the official 1-4 questions with 2-4 options', () => {
    const parsed = nativeQuestionInputSchema.parse({
      questions: [question('问题一'), question('问题二', true)],
    });
    expect(parsed.questions).toHaveLength(2);
    expect(parsed.questions[1]?.multiSelect).toBe(true);
  });

  it('bounds question count, option count, header and text', () => {
    expect(nativeQuestionInputSchema.safeParse({ questions: [] }).success).toBe(false);
    expect(
      nativeQuestionInputSchema.safeParse({
        questions: Array.from({ length: QUESTION_LIMITS.questions + 1 }, (_, i) =>
          question(`问题${i}`),
        ),
      }).success,
    ).toBe(false);
    expect(
      nativeQuestionInputSchema.safeParse({
        questions: [{ ...question('问题'), header: '超过十二个字符的标题文字啊' }],
      }).success,
    ).toBe(false);
    expect(
      nativeQuestionInputSchema.safeParse({
        questions: [{ ...question('问题'), options: [{ label: '只有一项', description: '' }] }],
      }).success,
    ).toBe(false);
    expect(
      nativeQuestionInputSchema.safeParse({
        questions: [question('x'.repeat(QUESTION_LIMITS.question + 1))],
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate question text because answers are keyed by it', () => {
    expect(
      nativeQuestionInputSchema.safeParse({ questions: [question('重复'), question('重复')] })
        .success,
    ).toBe(false);
  });
});

describe('question response', () => {
  it('accepts answers or an explicit decline, never both', () => {
    expect(questionResponseSchema.parse({ answers: { 问题一: 'A' } })).toEqual({
      answers: { 问题一: 'A' },
    });
    expect(questionResponseSchema.parse({ decline: true })).toEqual({ decline: true });
    expect(questionResponseSchema.safeParse({ answers: {}, decline: true }).success).toBe(false);
    expect(questionResponseSchema.safeParse({ answers: { 问题一: '   ' } }).success).toBe(false);
  });

  it('bounds answer values and the whole payload', () => {
    expect(
      questionResponseSchema.safeParse({ answers: { q: 'x'.repeat(QUESTION_LIMITS.answer + 1) } })
        .success,
    ).toBe(false);
    const tooLarge = Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [
        `q${i}`.padEnd(QUESTION_LIMITS.question, 'k'),
        'x'.repeat(QUESTION_LIMITS.answer),
      ]),
    );
    expect(questionResponseSchema.safeParse({ answers: tooLarge }).success).toBe(false);
  });
});

describe('run question', () => {
  it('round-trips the persisted shape', () => {
    expect(runQuestionSchema.parse(runQuestion)).toEqual(runQuestion);
  });

  it('rejects unknown statuses and missing timestamps', () => {
    expect(runQuestionSchema.safeParse({ ...runQuestion, status: 'expired' }).success).toBe(false);
    expect(runQuestionSchema.safeParse({ ...runQuestion, expiresAt: undefined }).success).toBe(
      false,
    );
  });
});

describe('public question contract', () => {
  it('projects question and answer text once with stable option identities', () => {
    const secret = 'sk-test-1234567890abcdefghijklmnop';
    const original = {
      ...runQuestion,
      status: 'answered' as const,
      questions: [
        {
          ...question(secret),
          options: [
            { label: secret, description: '第一个' },
            { label: 'B', description: '第二个' },
          ],
        },
        question(`second ${secret}`),
      ],
      answers: { [secret]: secret, [`second ${secret}`]: 'free text' },
      closeReason: `TOKEN=${secret}`,
    };
    const projected = publicRunQuestion(original);
    expect(JSON.stringify(projected)).not.toContain(secret);
    expect(projected.answers).toEqual({ '0': 'sk-t***', '1': 'free text' });
    expect(projected.questions[0]?.options[0]).toMatchObject({ value: '0', label: 'sk-t***' });
    expect(publicRunQuestionSchema.parse(projected)).toEqual(projected);
    expect(original.answers[secret]).toBe(secret);
    expect(redactSecrets('Bearer abcdef123456')).toBe('Bearer abcd***');
  });

  it('accepts only indexed free text and option identities at the HTTP boundary', () => {
    expect(publicQuestionResponseSchema.parse({ answers: {}, choices: { '0': ['1'] } })).toEqual({
      answers: {},
      choices: { '0': ['1'] },
    });
    expect(publicQuestionResponseSchema.safeParse({ answers: { original: 'A' } }).success).toBe(
      false,
    );
    expect(
      publicQuestionResponseSchema.safeParse({ answers: {}, choices: { '0': ['label'] } }).success,
    ).toBe(false);
  });
});

describe('question wire events', () => {
  it('parses the three question events', () => {
    expect(
      chatEventSchema.parse({
        type: 'question_requested',
        requestId: 'req-1',
        toolUseId: 'tool-1',
        questions: runQuestion.questions,
      }),
    ).toMatchObject({ type: 'question_requested' });
    expect(chatEventSchema.parse({ type: 'question_closed', requestId: 'req-1' })).toEqual({
      type: 'question_closed',
      requestId: 'req-1',
    });
    expect(
      chatEventSchema.parse({ type: 'question_updated', question: publicRunQuestion(runQuestion) }),
    ).toMatchObject({ type: 'question_updated' });
  });

  it('parses the stdin command with a typed response', () => {
    expect(
      sandboxInputCommandSchema.parse({
        type: 'question_response',
        requestId: 'req-1',
        response: { answers: { 问题一: 'A' } },
      }),
    ).toMatchObject({ type: 'question_response' });
    expect(
      sandboxInputCommandSchema.safeParse({ type: 'question_response', requestId: 'req-1' })
        .success,
    ).toBe(false);
  });
});
