import { join } from 'node:path';

export function sdkSessionsRoot(workspacesDir: string, slug: string): string {
  return join(workspacesDir, slug, 'sdk-sessions');
}

export function sessionSandboxesRoot(workspacesDir: string, slug: string): string {
  return join(workspacesDir, slug, 'session-sandboxes');
}

export function sdkSessionDir(workspacesDir: string, slug: string, conversationId: string): string {
  return join(sdkSessionsRoot(workspacesDir, slug), conversationId);
}

export function sessionSandboxDir(
  workspacesDir: string,
  slug: string,
  conversationId: string,
): string {
  return join(sessionSandboxesRoot(workspacesDir, slug), conversationId);
}
