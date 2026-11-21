import { PERMISSIONS } from '@agentport/shared';

export const allAccessMe = {
  authenticated: true as const,
  user: { businessId: 'test-admin', username: 'admin', name: '测试管理员' },
  roles: [],
  grants: PERMISSIONS.map((permission) => ({
    permissionId: permission.id,
    scope: permission.scopes[0]!,
  })),
};
