import { describe, expect, it } from 'bun:test';
import { scheduleTriggerArgs, scheduleTriggerJobSchema } from '../src/index.js';

describe('schedule trigger queue contract', () => {
  it('builds the approved upsert arguments', () => {
    const [id, repeat, template] = scheduleTriggerArgs(
      'schedule_abc',
      '*/5 * * * *',
      'Asia/Shanghai',
    );
    expect(id).toBe('schedule_abc');
    expect(repeat).toEqual({ pattern: '*/5 * * * *', tz: 'Asia/Shanghai' });
    expect(template.name).toBe('trigger');
    expect(template.data).toEqual({ scheduleId: 'schedule_abc' });
    expect(template.opts).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    });
    expect(template.opts).not.toHaveProperty('jobId');
  });

  it('accepts the scheduler payload and the ids written by the worker', () => {
    expect(scheduleTriggerJobSchema.parse({ scheduleId: 'schedule_abc' })).toEqual({
      scheduleId: 'schedule_abc',
    });
    expect(
      scheduleTriggerJobSchema.parse({
        scheduleId: 'schedule_abc',
        runId: 'run_1',
        conversationId: 'conversation_1',
        messageId: 'message_1',
      }),
    ).toMatchObject({ runId: 'run_1' });
  });

  it('rejects a payload without a schedule id', () => {
    expect(scheduleTriggerJobSchema.safeParse({}).success).toBe(false);
    expect(scheduleTriggerJobSchema.safeParse({ scheduleId: '' }).success).toBe(false);
  });
});
