import type { ApiToolInput } from '@agentport/shared';
import { describe, expect, it } from 'vitest';
import { parsePairs, validateToolInput } from '../src/lib/resource-form.js';

const tool: ApiToolInput = {
  name: 'list-users',
  description: '',
  method: 'GET',
  pathTemplate: '/users',
  inputSchema: {},
  paramsIn: 'query',
  requiresApproval: false,
};

describe('connector environment/header lines', () => {
  it('rejects duplicate keys with both line numbers instead of overwriting secrets', () => {
    expect(() => parsePairs('TOKEN=first\n\nTOKEN=second', 'env')).toThrow(/3.*1/);
  });

  it('rejects header duplicates regardless of casing with both line numbers', () => {
    expect(() => parsePairs('Authorization=first\nauthorization=second', 'headers')).toThrow(
      /2.*1/,
    );
  });

  it('keeps environment keys case-sensitive', () => {
    expect(parsePairs('TOKEN=first\ntoken=second', 'env')).toEqual({
      TOKEN: 'first',
      token: 'second',
    });
  });

  it('rejects malformed nonempty lines instead of silently dropping credentials', () => {
    expect(() => parsePairs('TOKEN=secret\n\nAuthorization: Bearer secret', 'env')).toThrow(/3/);
  });

  it('rejects empty and whitespace-only keys', () => {
    expect(() => parsePairs('=secret', 'env')).toThrow(/1/);
    expect(() => parsePairs('  =secret', 'headers')).toThrow(/1/);
  });

  it('preserves equals in values, empty values, masked secrets, and blank lines', () => {
    expect(parsePairs(' TOKEN = abc== \n\nEMPTY=\nMASK=••••\r\n', 'env')).toEqual({
      TOKEN: 'abc==',
      EMPTY: '',
      MASK: '••••',
    });
  });
});

describe('tool form validation', () => {
  it.each(['null', '[]', '42', 'true', '"text"', '{'])('rejects invalid schema text %s', (text) => {
    const result = validateToolInput(tool, text);
    expect(result.data).toBeUndefined();
    expect(result.errors?.inputSchema).toBeTruthy();
  });

  it.each([
    ['name', 'a'.repeat(65)],
    ['description', 'a'.repeat(1001)],
  ])('enforces the shared %s length limit before submission', (field, value) => {
    const result = validateToolInput({ ...tool, [field]: value }, '{}');
    expect(result.data).toBeUndefined();
    expect(result.errors?.[field]).toBeTruthy();
  });

  it('accepts names and descriptions exactly at the shared limits', () => {
    const input = { ...tool, name: 'a'.repeat(64), description: 'a'.repeat(1000) };
    expect(validateToolInput(input, '{}').data).toEqual(input);
  });

  it('rejects whitespace-only paths and missing placeholder properties', () => {
    expect(
      validateToolInput({ ...tool, pathTemplate: '   ' }, '{}').errors?.pathTemplate,
    ).toBeTruthy();
    expect(
      validateToolInput({ ...tool, pathTemplate: '/users/{id}' }, '{"properties":{}}').errors
        ?.pathTemplate,
    ).toBeTruthy();
  });

  it('submits parsed schema and retains approval settings when placeholders are defined', () => {
    const result = validateToolInput(
      { ...tool, pathTemplate: '/users/{id}', requiresApproval: true },
      '{"type":"object","properties":{"id":{"type":"string"}}}',
    );
    expect(result.data).toEqual({
      ...tool,
      pathTemplate: '/users/{id}',
      requiresApproval: true,
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    });
  });
});
