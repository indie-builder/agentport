import { describe, expect, it } from 'vitest';
import { renderWorkspace } from '../src/workspace.js';

const agent = {
  slug: 'a',
  name: 'A',
  model: 'm',
  systemPrompt: 'p',
  maxTurns: 5,
};

describe('renderWorkspace skill files', () => {
  it('carries supporting files alongside SKILL.md', () => {
    const files = renderWorkspace({
      agent,
      servers: [],
      skills: [
        {
          slug: 'deploy',
          name: 'Deploy',
          description: 'd',
          body: 'run it',
          files: [
            { path: 'scripts/run.sh', content: 'echo hi' },
            { path: 'references/api.md', content: '# api' },
          ],
        },
      ],
    });
    expect(files.skills).toHaveLength(1);
    expect(files.skills[0]?.content).toContain('name: "deploy"');
    expect(files.skills[0]?.files).toEqual([
      { path: 'scripts/run.sh', content: 'echo hi' },
      { path: 'references/api.md', content: '# api' },
    ]);
  });

  it('defaults to no supporting files', () => {
    const files = renderWorkspace({
      agent,
      servers: [],
      skills: [{ slug: 's', name: 'S', description: 'd', body: 'b' }],
    });
    expect(files.skills[0]?.files).toEqual([]);
  });
});
