import { existsSync } from 'node:fs';
import { ANTHROPIC_DEFAULT_BASE_URL } from '@agentport/core';

export function modelProxyUpstream(
  baseUrl: string | undefined,
  inContainer: boolean = existsSync('/.dockerenv'),
): string {
  const value = baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL;
  if (!inContainer) return value;
  return value.replace(
    /\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(?=[:/]|$)/,
    '//host.docker.internal',
  );
}

export function sdkEnv(cwd: string, anthropicBaseUrl: string | undefined): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: cwd,
    CLAUDE_CONFIG_DIR: cwd,
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  if (anthropicBaseUrl) {
    env.ANTHROPIC_BASE_URL = modelProxyUpstream(anthropicBaseUrl);
  }
  return env;
}
