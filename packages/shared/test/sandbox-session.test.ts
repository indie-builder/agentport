import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type ExecutionSettlement,
  type SupervisorInput,
  type SupervisorInputFrame,
  supervisorInputSchema,
  supervisorOutputSchema,
} from '../src/sandbox-session.js';

const task = {
  prompt: 'hi',
  model: 'test-model',
  maxTurns: 1,
  maxBudgetUsd: 1,
  userMessageUuid: '11111111-2222-4333-8444-555555555555',
};

describe('session supervisor protocol', () => {
  it('parses start with the shared sandbox task and the per-run env', () => {
    const parsed = supervisorInputSchema.parse({
      type: 'start',
      runId: 'run-1',
      task,
      env: { RUN_TOKEN: 'secret' },
    });

    expect(parsed).toMatchObject({ type: 'start', runId: 'run-1', env: { RUN_TOKEN: 'secret' } });
    // Defaults come from the one shared task schema, not a supervisor copy.
    expect(parsed.type === 'start' && parsed.task.mcpServers).toEqual([]);
    expect(parsed.type === 'start' && parsed.task.plugins).toEqual([]);
  });

  it('types the send shape with defaults optional and the parsed shape required', () => {
    // 宿主用 input 形状发帧；defaults 由 supervisor 解析补齐，发送方可以省略。
    const frame: SupervisorInputFrame = { type: 'start', runId: 'r', task, env: {} };
    expect(frame.type).toBe('start');

    type IsOptional<T, K extends keyof T> = undefined extends T[K] ? true : false;
    type StartFrameTask = Extract<SupervisorInputFrame, { type: 'start' }>['task'];
    type ParsedTask = Extract<SupervisorInput, { type: 'start' }>['task'];

    expectTypeOf<IsOptional<StartFrameTask, 'mcpServers'>>().toEqualTypeOf<true>();
    expectTypeOf<IsOptional<StartFrameTask, 'plugins'>>().toEqualTypeOf<true>();
    expectTypeOf<IsOptional<ParsedTask, 'mcpServers'>>().toEqualTypeOf<false>();
    expectTypeOf<IsOptional<ParsedTask, 'plugins'>>().toEqualTypeOf<false>();
  });

  it('parses input commands and cancel', () => {
    expect(
      supervisorInputSchema.parse({
        type: 'input',
        runId: 'run-1',
        command: { type: 'question_response', requestId: 'q', response: { decline: true } },
      }),
    ).toMatchObject({ type: 'input', runId: 'run-1', command: { type: 'question_response' } });
    expect(supervisorInputSchema.parse({ type: 'cancel', runId: 'run-1' })).toEqual({
      type: 'cancel',
      runId: 'run-1',
    });
  });

  it('rejects unknown input shapes without coercing fields', () => {
    expect(supervisorInputSchema.safeParse({ type: 'stop', runId: 'r' }).success).toBe(false);
    expect(
      supervisorInputSchema.safeParse({ type: 'start', runId: 'r', task, env: { RUN_TOKEN: 1 } })
        .success,
    ).toBe(false);
    // The task itself is still validated by sandboxTaskSchema.
    expect(
      supervisorInputSchema.safeParse({
        type: 'start',
        runId: 'r',
        task: { ...task, userMessageUuid: 'nope' },
        env: {},
      }).success,
    ).toBe(false);
  });

  it('validates output events against ChatEvent instead of a private shape', () => {
    for (const output of [
      { type: 'ready' },
      { type: 'started', runId: 'r' },
      { type: 'event', runId: 'r', event: { type: 'text_delta', text: 'hi' } },
      { type: 'event', runId: 'r', event: { type: 'assistant_text', text: 'hi' } },
      { type: 'stderr', runId: 'r', text: 'oops' },
      { type: 'settled', runId: 'r', code: 0, signal: null, stopped: true },
      {
        type: 'settled',
        runId: 'r',
        code: null,
        signal: 'SIGTERM',
        stopped: false,
        error: 'still running',
      },
      { type: 'rejected', runId: 'r', code: 'BUSY', message: 'busy' },
    ]) {
      expect(supervisorOutputSchema.safeParse(output), JSON.stringify(output)).toMatchObject({
        success: true,
      });
    }

    expect(
      supervisorOutputSchema.safeParse({
        type: 'event',
        runId: 'r',
        event: { type: 'not-a-chat-event' },
      }).success,
    ).toBe(false);
    expect(
      supervisorOutputSchema.safeParse({
        type: 'rejected',
        runId: 'r',
        code: 'NOPE',
        message: 'x',
      }).success,
    ).toBe(false);
  });

  it('models both settlement states', () => {
    const stopped: ExecutionSettlement = { state: 'stopped', code: 0, signal: null };
    const unconfirmed: ExecutionSettlement = { state: 'unconfirmed', error: 'still running' };

    expect(stopped.state).toBe('stopped');
    expect(unconfirmed.state).toBe('unconfirmed');
  });
});
