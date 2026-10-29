import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUNTIME_DOCKERFILE,
  DEFAULT_RUNTIME_ENVIRONMENT_NAME,
  runtimeEnvironmentInputSchema,
  runtimeEnvironmentPatchSchema,
} from '../src/runtime-environment.js';

describe('runtime environment contract', () => {
  it('defaults the Dockerfile to the platform base template', () => {
    const parsed = runtimeEnvironmentInputSchema.parse({ name: ' 数据科学 ' });
    expect(parsed.name).toBe('数据科学');
    expect(parsed.dockerfile).toBe(DEFAULT_RUNTIME_DOCKERFILE);
  });

  it('derives from the configurable runner base and ends as the node user in /app', () => {
    expect(DEFAULT_RUNTIME_DOCKERFILE).toContain('ARG RUNTIME_BASE_IMAGE=');
    expect(DEFAULT_RUNTIME_DOCKERFILE).toContain(`FROM \${RUNTIME_BASE_IMAGE}`);
    expect(DEFAULT_RUNTIME_DOCKERFILE).toContain('\nUSER root\n');
    expect(DEFAULT_RUNTIME_DOCKERFILE).toContain('\nUSER node\nWORKDIR /app\n');
  });

  it('default environment name is stable for worker registration', () => {
    expect(DEFAULT_RUNTIME_ENVIRONMENT_NAME).toBe('默认环境');
  });

  it('patch fields are optional and reject empty names', () => {
    expect(runtimeEnvironmentPatchSchema.parse({})).toEqual({});
    expect(runtimeEnvironmentPatchSchema.safeParse({ name: '  ' }).success).toBe(false);
  });
});
