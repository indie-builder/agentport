import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_RUNTIME_DOCKERFILE,
  runtimeEnvironmentInputSchema,
  runtimeEnvironmentPatchSchema,
} from '../src/runtime-environment.js';

describe('runtime environment contract', () => {
  it('defaults the Dockerfile to the platform base template', () => {
    const parsed = runtimeEnvironmentInputSchema.parse({ name: ' 数据科学 ' });
    expect(parsed.name).toBe('数据科学');
    expect(parsed.dockerfile).toBe(DEFAULT_RUNTIME_DOCKERFILE);
  });

  it('patch fields are optional and reject empty names', () => {
    expect(runtimeEnvironmentPatchSchema.parse({})).toEqual({});
    expect(runtimeEnvironmentPatchSchema.safeParse({ name: '  ' }).success).toBe(false);
  });
});
