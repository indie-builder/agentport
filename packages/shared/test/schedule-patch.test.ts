import { describe, expect, it } from 'vitest';
import { scheduleInputSchema, schedulePatchSchema } from '../src/index.js';

describe('schedule patch schema', () => {
  it('keeps enabled unset when PATCH only changes the name', () => {
    const parsed = schedulePatchSchema.parse({ name: 'renamed' });
    expect(parsed).not.toHaveProperty('enabled');
  });

  it('still defaults enabled to true on create', () => {
    const input = scheduleInputSchema.parse({
      agentId: 'agent_1',
      name: 'daily',
      cron: '0 9 * * *',
      prompt: 'run',
    });
    expect(input.enabled).toBe(true);
  });
});
