import type { PermissionId } from '@agentport/shared';

export type RouteAccess =
  | { kind: 'public'; reason: string }
  | { kind: 'authenticated' }
  | { kind: 'permission'; permissionId: PermissionId }
  | { kind: 'service'; boundary: 'mcp' | 'run-token' | 'share-token'; reason: string };

export type RouteMeta = { access: RouteAccess; rateLimit?: number };
