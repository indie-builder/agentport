import { describe, expect, it } from 'vitest';
import { renderOutputStyleMd, renderWorkspace } from '../src/workspace.js';

const agent = { slug: 'a', name: 'A', model: 'm', systemPrompt: 'p', maxTurns: 5 };

describe('renderOutputStyleMd', () => {
  it('renders frontmatter and body', () => {
    const md = renderOutputStyleMd({
      slug: 'code-reviewer',
      description: 'Reviews code',
      keepCodingInstructions: true,
      body: '# Code Reviewer\n\nBe strict.',
    });
    expect(md).toContain('name: "code-reviewer"');
    expect(md).toContain('description: "Reviews code"');
    expect(md).toContain('keep-coding-instructions: true');
    expect(md).toContain('Be strict.');
  });

  it('omits the description line when empty', () => {
    const md = renderOutputStyleMd({
      slug: 'bare',
      description: '',
      keepCodingInstructions: false,
      body: 'body',
    });
    expect(md).not.toContain('description:');
    expect(md).toContain('keep-coding-instructions: false');
  });
});

describe('renderWorkspace output styles', () => {
  it('returns styles and the selected style', () => {
    const result = renderWorkspace({
      agent,
      servers: [],
      outputStyles: [
        { slug: 'code-reviewer', description: 'd', keepCodingInstructions: true, body: 'b' },
      ],
      selectedOutputStyle: 'code-reviewer',
    });
    expect(result.outputStyles).toHaveLength(1);
    expect(result.outputStyles[0]?.slug).toBe('code-reviewer');
    expect(result.outputStyles[0]?.content).toContain('name: "code-reviewer"');
    expect(result.selectedOutputStyle).toBe('code-reviewer');
  });

  it('defaults to no styles and no selection', () => {
    const result = renderWorkspace({ agent, servers: [] });
    expect(result.outputStyles).toEqual([]);
    expect(result.selectedOutputStyle).toBeNull();
  });
});
