import { describe, expect, it } from 'bun:test';
import { channelEventSchema, channelMessageInputSchema } from '../src/channels.js';

describe('channel message input', () => {
  it('accepts explicit mentions and mentionAll', () => {
    const parsed = channelMessageInputSchema.parse({
      body: 'ping @agent',
      mentions: ['agent_1', 'agent_2'],
      mentionAll: true,
    });
    expect(parsed).toEqual({
      body: 'ping @agent',
      mentions: ['agent_1', 'agent_2'],
      mentionAll: true,
    });
  });

  it('rejects empty mention ids and unknown fields', () => {
    expect(channelMessageInputSchema.safeParse({ body: 'x', mentions: [''] }).success).toBe(false);
    expect(channelMessageInputSchema.safeParse({ body: 'x', surprise: true }).success).toBe(false);
  });
});

describe('channel events', () => {
  it('only accepts terminal statuses for run.finished', () => {
    expect(
      channelEventSchema.safeParse({
        type: 'run.finished',
        channelId: 'chn_1',
        runId: 'run_1',
        agentId: 'agent_1',
        status: 'queued',
      }).success,
    ).toBe(false);
  });
});
