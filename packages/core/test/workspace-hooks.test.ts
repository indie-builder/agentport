import { describe, expect, it } from 'bun:test';
import { renderWorkspace } from '../src/workspace.js';

const agent = { slug: 'a', name: 'A', model: 'm', systemPrompt: 'p', maxTurns: 5 };

const hooks = {
  PreToolUse: [
    {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'bash .claude/hooks/guard.sh' }],
    },
  ],
};

describe('renderWorkspace hooks', () => {
  it('renders no hooks by default', () => {
    const result = renderWorkspace({ agent, servers: [] });
    expect(result.hookFiles).toEqual([]);
    expect(JSON.parse(result.settingsJson)).not.toHaveProperty('hooks');
  });

  it('writes hooks into settings.json and returns hook files when enabled', () => {
    const result = renderWorkspace({
      agent,
      servers: [],
      hooks,
      hookFiles: [{ path: 'guard.sh', content: '#!/bin/sh\n', executable: true }],
    });
    expect(JSON.parse(result.settingsJson).hooks).toEqual(hooks);
    expect(result.hookFiles).toEqual([
      { path: 'guard.sh', content: '#!/bin/sh\n', executable: true },
    ]);
  });

  it('rejects unsafe hook paths', () => {
    for (const path of ['../escape.sh', '/abs.sh', 'a/../../b.sh', 'a//b.sh', 'a\\b.sh']) {
      expect(() =>
        renderWorkspace({
          agent,
          servers: [],
          hookFiles: [{ path, content: '', executable: false }],
        }),
      ).toThrow();
    }
  });
});
