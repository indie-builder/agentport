import { describe, expect, it } from 'vitest';
import { agentInputSchema } from '../src/agent.js';

const base = { slug: 'permission-default', name: 'Permission default' };

describe('agent permission default', () => {
  it('creates new agents in default mode so questions can reach the user', () => {
    expect(agentInputSchema.parse(base).permissionMode).toBe('default');
  });

  it('keeps an explicit dontAsk', () => {
    expect(agentInputSchema.parse({ ...base, permissionMode: 'dontAsk' }).permissionMode).toBe(
      'dontAsk',
    );
  });
});
