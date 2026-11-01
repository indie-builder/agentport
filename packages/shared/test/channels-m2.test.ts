import { describe, expect, it } from 'vitest';
import {
  type ChannelEvent,
  channelEventSchema,
  channelMessageInputSchema,
  channelStreamKey,
} from '../src/channels.js';
import { runTriggerSchema } from '../src/ops.js';

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
  it('parses run lifecycle events', () => {
    const started: ChannelEvent = channelEventSchema.parse({
      type: 'run.started',
      channelId: 'chn_1',
      runId: 'run_1',
      agentId: 'agent_1',
    });
    expect(started.type).toBe('run.started');

    const finished = channelEventSchema.parse({
      type: 'run.finished',
      channelId: 'chn_1',
      runId: 'run_1',
      agentId: 'agent_1',
      status: 'cancelled',
    });
    expect(finished.type === 'run.finished' && finished.status).toBe('cancelled');
  });

  it('parses approval requested events', () => {
    const requested = channelEventSchema.parse({
      type: 'approval.requested',
      channelId: 'chn_1',
      runId: 'run_1',
      approvalId: 'apr_1',
      toolName: 'write_file',
    });
    expect(requested.type === 'approval.requested' && requested.approvalId).toBe('apr_1');
  });

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

describe('channel contracts adjacent to runs', () => {
  it('accepts channel as a run trigger', () => {
    expect(runTriggerSchema.parse('channel')).toBe('channel');
  });

  it('keeps the channel stream key stable', () => {
    expect(channelStreamKey('chn_1')).toBe('channel:chn_1:events');
  });
});
