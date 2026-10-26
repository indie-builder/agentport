import { KnowledgeModelError } from '@agentport/core';
import { describe, expect, it } from 'vitest';
import { isRetryableKnowledgeError } from '../src/knowledge/ingestion.js';
import { KnowledgeParseError } from '../src/knowledge/parsing.js';

describe('knowledge retry policy', () => {
  it('retries transient parser failures', () => {
    expect(isRetryableKnowledgeError(new KnowledgeParseError('parser_unavailable', 'down'))).toBe(
      true,
    );
    expect(isRetryableKnowledgeError(new KnowledgeParseError('upstream_http', '503'))).toBe(true);
  });

  it('does not retry unsupported formats or bad input', () => {
    expect(isRetryableKnowledgeError(new KnowledgeParseError('unsupported', 'slides'))).toBe(false);
    expect(isRetryableKnowledgeError(new KnowledgeParseError('invalid_input', 'empty'))).toBe(
      false,
    );
    expect(isRetryableKnowledgeError(new KnowledgeParseError('partial_success', 'x'))).toBe(false);
  });

  it('keeps the model-error policy unchanged', () => {
    expect(isRetryableKnowledgeError(new KnowledgeModelError('rate_limit', '429'))).toBe(true);
    expect(isRetryableKnowledgeError(new KnowledgeModelError('auth', '401'))).toBe(false);
  });
});
